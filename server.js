import express from "express";
import multer from "multer";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { PNG } from "pngjs";
import OpenAI from "openai";

/**
 * FFmpeg Crop Service
 * - POST /detect-ai  -> returns crop rectangle (GPT-5-mini + HARD pixel enforcement)
 * - POST /detect     -> basic dark-band detection (no AI)
 * - POST /crop       -> applies crop
 *
 * Goal: CROP OUT ALL UI (headers/captions/watermarks/logos) and keep ONLY the actual video content.
 */

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: "/tmp" });

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/", (req, res) => res.send("ffmpeg-crop-service with AI detection OK"));

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) reject({ err, stdout, stderr });
      else resolve({ stdout, stderr });
    });
  });
}

async function ffprobeDims(inputPath) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    inputPath,
  ]);
  const parsed = JSON.parse(stdout);
  const s = parsed?.streams?.[0];
  return { w: Number(s?.width), h: Number(s?.height) };
}

async function ffprobeDuration(inputPath) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    inputPath,
  ]);
  const parsed = JSON.parse(stdout);
  const d = Number(parsed?.format?.duration);
  return Number.isFinite(d) && d > 0 ? d : 10;
}

// Heuristic #1: dark header/footer detection (solid bars)
function detectCutsFromPng(png, opts = {}) {
  const { width, height, data } = png;

  const darkThreshold = Number(opts.darkThreshold ?? 35);
  const minBandRatio = Number(opts.minBandRatio ?? 0.02);
  const maxBandRatio = Number(opts.maxBandRatio ?? 0.45);

  const minBand = Math.floor(height * minBandRatio);
  const maxBand = Math.floor(height * maxBandRatio);

  const rowMean = new Array(height).fill(0);

  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    rowMean[y] = sum / width;
  }

  let topCut = 0;
  while (topCut < maxBand && rowMean[topCut] < darkThreshold) topCut++;

  let bottomCut = 0;
  while (bottomCut < maxBand && rowMean[height - 1 - bottomCut] < darkThreshold) bottomCut++;

  if (topCut < minBand) topCut = 0;
  if (bottomCut < minBand) bottomCut = 0;

  return { topCut, bottomCut };
}

/**
 * Heuristic #2 (IMPORTANT): Detect “white text on dark background” bands near top/bottom.
 * This catches headers like your screenshot: black strip + white caption text.
 */
function detectTextOnDarkBands(png, opts = {}) {
  const { width, height, data } = png;

  const scanTopRatio = Number(opts.scanTopRatio ?? 0.40);
  const scanBottomRatio = Number(opts.scanBottomRatio ?? 0.30);

  const darkLum = Number(opts.darkLum ?? 40);
  const whiteLum = Number(opts.whiteLum ?? 235);

  const minDarkRatio = Number(opts.minDarkRatio ?? 0.55);
  const minWhiteRatio = Number(opts.minWhiteRatio ?? 0.003);

  const minBandPx = Number(opts.minBandPx ?? Math.floor(height * 0.015));
  const maxTopPx = Number(opts.maxTopPx ?? Math.floor(height * 0.45));
  const maxBottomPx = Number(opts.maxBottomPx ?? Math.floor(height * 0.30));

  const topScanH = Math.floor(height * scanTopRatio);
  const botScanH = Math.floor(height * scanBottomRatio);

  function rowStats(y) {
    let darkCount = 0;
    let whiteCount = 0;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (lum <= darkLum) darkCount++;
      if (lum >= whiteLum) whiteCount++;
    }
    return { darkRatio: darkCount / width, whiteRatio: whiteCount / width };
  }

  // top overlay end (exclusive)
  let topEnd = 0;
  {
    let run = 0;
    let lastGood = -1;
    for (let y = 0; y < topScanH; y++) {
      if (y > maxTopPx) break;
      const { darkRatio, whiteRatio } = rowStats(y);
      const ok = darkRatio >= minDarkRatio && whiteRatio >= minWhiteRatio;
      if (ok) {
        run++;
        lastGood = y;
      } else {
        if (run >= minBandPx) break;
        run = 0;
        lastGood = -1;
      }
    }
    topEnd = run >= minBandPx && lastGood >= 0 ? lastGood + 1 : 0;
  }

  // bottom overlay start
  let bottomStart = height;
  {
    let run = 0;
    let lastGood = -1;
    for (let i = 0; i < botScanH; i++) {
      if (i > maxBottomPx) break;
      const y = height - 1 - i;
      const { darkRatio, whiteRatio } = rowStats(y);
      const ok = darkRatio >= minDarkRatio && whiteRatio >= minWhiteRatio;
      if (ok) {
        run++;
        lastGood = y;
      } else {
        if (run >= minBandPx) break;
        run = 0;
        lastGood = -1;
      }
    }
    bottomStart = run >= minBandPx && lastGood >= 0 ? lastGood : height;
  }

  return { top_overlay_end: topEnd, bottom_overlay_start: bottomStart };
}

function clampInt(n, min, max) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

// ---------------------------
// ✅ AI-Powered Detection (GPT-5-mini + HARD enforcement)
// ---------------------------
app.post("/detect-ai", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });

    const inputPath = req.file.path;

    const { w: src_w, h: src_h } = await ffprobeDims(inputPath);
    if (!Number.isFinite(src_w) || !Number.isFinite(src_h)) {
      return res.status(400).json({ error: "Could not read video dimensions." });
    }

    const duration = await ffprobeDuration(inputPath);

    // sample frames (robust vs moving overlays)
    const numFrames = req.body.num_frames ? Math.max(1, Math.min(5, Number(req.body.num_frames))) : 3;
    const timestamps = [];
    for (let i = 0; i < numFrames; i++) {
      timestamps.push(Math.min(duration * 0.9, (duration / (numFrames + 1)) * (i + 1)));
    }

    const frames = [];
    let firstPng = null;

    for (let i = 0; i < timestamps.length; i++) {
      const framePath = path.join("/tmp", `frame-${Date.now()}-${i}.png`);
      await run("ffmpeg", ["-y", "-ss", String(timestamps[i]), "-i", inputPath, "-vframes", "1", framePath]);

      const buf = fs.readFileSync(framePath);
      frames.push({ base64: buf.toString("base64"), t: timestamps[i] });

      if (!firstPng) {
        try {
          firstPng = PNG.sync.read(buf);
        } catch {}
      }

      fs.unlinkSync(framePath);
    }

    if (frames.length === 0) {
      fs.unlink(inputPath, () => {});
      return res.status(500).json({ error: "Failed to extract frames." });
    }

    // HARD pixel enforcement (this is what prevents your header from surviving)
    const safeMargin = req.body.safe_margin ? Number(req.body.safe_margin) : 14;

    let enforcedTop = 0;
    let enforcedBottom = 0;

    if (firstPng) {
      const { topCut, bottomCut } = detectCutsFromPng(firstPng, {
        darkThreshold: req.body.dark_threshold ? Number(req.body.dark_threshold) : 35,
      });

      const { top_overlay_end, bottom_overlay_start } = detectTextOnDarkBands(firstPng, {
        scanTopRatio: req.body.scan_top_ratio ? Number(req.body.scan_top_ratio) : 0.40,
        scanBottomRatio: req.body.scan_bottom_ratio ? Number(req.body.scan_bottom_ratio) : 0.30,
      });

      enforcedTop = Math.max(topCut, top_overlay_end) + safeMargin;
      enforcedBottom = Math.max(bottomCut, src_h - bottom_overlay_start) + safeMargin;

      enforcedTop = clampInt(enforcedTop, 0, Math.floor(src_h * 0.55));
      enforcedBottom = clampInt(enforcedBottom, 0, Math.floor(src_h * 0.40));
    }

    // GPT-5-mini prompt (AGGRESSIVE: “overlay must die”)
    const messageContent = [
      ...frames.map((f) => ({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${f.base64}`, detail: "high" },
      })),
      {
        type: "text",
        text: `You are cropping a vertical social media video (${src_w}x${src_h}). You see ${frames.length} frame(s).

NON-NEGOTIABLE:
- The crop MUST REMOVE ALL UI overlays (headers, captions, watermarks, usernames, logos, text).
- If you must choose between keeping scene content vs removing overlay text, ALWAYS remove overlay text.
- Return ONE crop rectangle that works across all frames.

Hard bounds you MUST respect:
- crop_y MUST be >= ${enforcedTop}
- crop_y + crop_h MUST be <= ${src_h - enforcedBottom}

Return ONLY valid JSON:
{
  "crop_x": <int>,
  "crop_y": <int>,
  "crop_w": <int>,
  "crop_h": <int>,
  "reasoning": "<1-2 sentences>",
  "confidence": <0-100>
}`,
      },
    ];

    const response = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: messageContent }],
      max_tokens: 650,
      temperature: 0.1,
    });

    const txt = response.choices?.[0]?.message?.content ?? "";
    let cropData;
    try {
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("No JSON found");
      cropData = JSON.parse(m[0]);
    } catch {
      fs.unlink(inputPath, () => {});
      return res.status(500).json({ error: "Failed to parse AI response", raw_response: txt });
    }

    // Proposed crop
    let crop_x = clampInt(cropData.crop_x, 0, src_w - 10);
    let crop_y = clampInt(cropData.crop_y, 0, src_h - 10);
    let crop_w = clampInt(cropData.crop_w, 10, src_w);
    let crop_h = clampInt(cropData.crop_h, 10, src_h);

    // Prefer full width (most cases)
    if (crop_w < src_w * 0.85) {
      crop_x = 0;
      crop_w = src_w;
    }
    if (crop_x + crop_w > src_w) crop_x = Math.max(0, src_w - crop_w);

    // HARD ENFORCEMENT (this is what actually fixes your header issue)
    crop_y = Math.max(crop_y, enforcedTop);

    const maxBottomY = src_h - enforcedBottom;
    if (crop_y + crop_h > maxBottomY) {
      crop_h = Math.max(10, maxBottomY - crop_y);
    }

    // Final clamp
    crop_x = clampInt(crop_x, 0, src_w - 10);
    crop_y = clampInt(crop_y, 0, src_h - 10);
    crop_w = clampInt(crop_w, 10, src_w - crop_x);
    crop_h = clampInt(crop_h, 10, src_h - crop_y);

    fs.unlink(inputPath, () => {});

    return res.json({
      crop_w,
      crop_h,
      x: crop_x,
      y: crop_y,
      src_w,
      src_h,
      reasoning: cropData.reasoning || "",
      confidence: Number.isFinite(Number(cropData.confidence)) ? Number(cropData.confidence) : 0,
      frames_analyzed: frames.length,
      timestamps_sampled: timestamps,
      heuristic_enforced_top: enforcedTop,
      heuristic_enforced_bottom: enforcedBottom,
      ai_powered: true,
      model_used: "gpt-5-mini",
    });
  } catch (e) {
    return res.status(500).json({ error: "AI detection failed", details: String(e?.message || e) });
  }
});

// ---------------------------
// ✅ FALLBACK: Basic pixel detection (no AI)
// ---------------------------
app.post("/detect", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });

    const inputPath = req.file.path;
    const sampleTime = req.body.sample_time ? Number(req.body.sample_time) : 0.5;

    const { w: src_w, h: src_h } = await ffprobeDims(inputPath);
    if (!Number.isFinite(src_w) || !Number.isFinite(src_h)) {
      return res.status(400).json({ error: "Could not read video dimensions." });
    }

    const framePath = path.join("/tmp", `frame-${Date.now()}.png`);

    await run("ffmpeg", ["-y", "-ss", String(sampleTime), "-i", inputPath, "-vframes", "1", framePath]);

    const buf = fs.readFileSync(framePath);
    const png = PNG.sync.read(buf);

    const { topCut, bottomCut } = detectCutsFromPng(png, {
      darkThreshold: req.body.dark_threshold ? Number(req.body.dark_threshold) : 35,
    });

    const safeMargin = req.body.safe_margin ? Number(req.body.safe_margin) : 10;

    const crop_w = src_w;
    const crop_h = Math.max(10, src_h - topCut - bottomCut - safeMargin * 2);
    const x = 0;
    const y = Math.max(0, topCut + safeMargin);

    fs.unlink(framePath, () => {});
    fs.unlink(inputPath, () => {});

    return res.json({
      crop_w,
      crop_h,
      x,
      y,
      src_w,
      src_h,
      top_cut: topCut,
      bottom_cut: bottomCut,
      sample_time: sampleTime,
      safe_margin: safeMargin,
      ai_powered: false,
    });
  } catch (e) {
    return res.status(500).json({ error: "detect failed", details: String(e?.stderr || e) });
  }
});

// ---------------------------
// ✅ /crop endpoint
// ---------------------------
app.post("/crop", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });

    const crop_w = Number(req.body.crop_w);
    const crop_h = Number(req.body.crop_h);
    const x = Number(req.body.x);
    const y = Number(req.body.y);

    const start = req.body.start ? Number(req.body.start) : null;
    const duration = req.body.duration ? Number(req.body.duration) : null;

    if (![crop_w, crop_h, x, y].every((n) => Number.isFinite(n))) {
      return res.status(400).json({
        error: "Missing/invalid crop params. Required: crop_w,crop_h,x,y (numbers).",
        received: req.body,
      });
    }

    const inputPath = req.file.path;
    const outputPath = path.join("/tmp", `cropped-${Date.now()}.mp4`);

    const args = [];
    if (start !== null) args.push("-ss", String(start));
    args.push("-i", inputPath);
    if (duration !== null) args.push("-t", String(duration));

    args.push(
      "-vf",
      `crop=${Math.floor(crop_w)}:${Math.floor(crop_h)}:${Math.floor(x)}:${Math.floor(y)}`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outputPath
    );

    execFile("ffmpeg", args, (err, stdout, stderr) => {
      if (err) {
        return res.status(500).json({
          error: "ffmpeg failed",
          details: stderr?.slice?.(0, 4000) || String(err),
        });
      }

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", 'attachment; filename="cropped.mp4"');

      const stream = fs.createReadStream(outputPath);
      stream.on("close", () => {
        fs.unlink(inputPath, () => {});
        fs.unlink(outputPath, () => {});
      });
      stream.pipe(res);
    });
  } catch (e) {
    res.status(500).json({ error: "Server error", details: String(e) });
  }
});

// Health
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    openai_configured: !!process.env.OPENAI_API_KEY,
    endpoints: ["/detect-ai", "/detect", "/crop"],
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FFmpeg service with AI detection listening on port ${PORT}`);
  console.log(`OpenAI API Key configured: ${!!process.env.OPENAI_API_KEY}`);
});
