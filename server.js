import express from "express";
import multer from "multer";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { PNG } from "pngjs";
import OpenAI from "openai";

const app = express();

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// n8n: keep field name as "file" (multer field), and n8n can map binary property (e.g. "data") into that field.
const upload = multer({ dest: "/tmp" });

// OpenAI (optional refine pass)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (req, res) => res.send("ffmpeg-crop-service with smart crop detection OK"));

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

function clampInt(v, min, max) {
  return Math.max(min, Math.min(max, Math.floor(v)));
}

/**
 * Robust “content box” detector for videos with black bars + overlays.
 *
 * Key idea:
 * - A black header/footer often contains small white text/logos.
 * - If we look at *fraction* of non-dark pixels per row/column:
 *   - header/footer rows have LOW fraction (only text)
 *   - real video rows have HIGH fraction (lots of non-dark pixels)
 * So we can find the largest rectangle of “real content” and crop everything else out.
 */
function detectContentBoxFromPng(png, opts = {}) {
  const { width, height, data } = png;

  // Pixel considered “non-dark” if luminance >= lumThreshold
  const lumThreshold = Number(opts.lum_threshold ?? 26);

  // A row is considered “content” if >= rowFrac pixels are non-dark
  const rowFrac = Number(opts.row_frac ?? 0.12);

  // A column is considered “content” if >= colFrac pixels are non-dark
  const colFrac = Number(opts.col_frac ?? 0.10);

  // Require N consecutive content rows/cols to start/stop (reduces noise)
  const consecutive = clampInt(Number(opts.consecutive ?? 6), 2, 30);

  // Extra padding inside the detected content (safety margin)
  const pad = clampInt(Number(opts.safe_margin ?? 8), 0, 200);

  // Helpers
  function luminanceAt(idx) {
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // Compute row fractions
  const rowIsContent = new Array(height).fill(false);
  for (let y = 0; y < height; y++) {
    let nonDark = 0;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (luminanceAt(idx) >= lumThreshold) nonDark++;
    }
    const frac = nonDark / width;
    rowIsContent[y] = frac >= rowFrac;
  }

  // Compute col fractions
  const colIsContent = new Array(width).fill(false);
  for (let x = 0; x < width; x++) {
    let nonDark = 0;
    for (let y = 0; y < height; y++) {
      const idx = (y * width + x) * 4;
      if (luminanceAt(idx) >= lumThreshold) nonDark++;
    }
    const frac = nonDark / height;
    colIsContent[x] = frac >= colFrac;
  }

  function findStartByConsecutive(boolArr) {
    let streak = 0;
    for (let i = 0; i < boolArr.length; i++) {
      streak = boolArr[i] ? streak + 1 : 0;
      if (streak >= consecutive) return i - consecutive + 1;
    }
    return 0;
  }

  function findEndByConsecutive(boolArr) {
    let streak = 0;
    for (let i = boolArr.length - 1; i >= 0; i--) {
      streak = boolArr[i] ? streak + 1 : 0;
      if (streak >= consecutive) return i + consecutive - 1;
    }
    return boolArr.length - 1;
  }

  let top = findStartByConsecutive(rowIsContent);
  let bottom = findEndByConsecutive(rowIsContent);
  let left = findStartByConsecutive(colIsContent);
  let right = findEndByConsecutive(colIsContent);

  // Apply inner padding
  top = clampInt(top + pad, 0, height - 2);
  bottom = clampInt(bottom - pad, 1, height - 1);
  left = clampInt(left + pad, 0, width - 2);
  right = clampInt(right - pad, 1, width - 1);

  // Ensure sane minimum
  const minW = clampInt(Number(opts.min_w ?? 200), 50, width);
  const minH = clampInt(Number(opts.min_h ?? 200), 50, height);

  if (right - left + 1 < minW) {
    left = 0;
    right = width - 1;
  }
  if (bottom - top + 1 < minH) {
    top = 0;
    bottom = height - 1;
  }

  return {
    left,
    top,
    right,
    bottom,
    width,
    height,
    params_used: { lumThreshold, rowFrac, colFrac, consecutive, pad, minW, minH },
  };
}

function intersectBoxes(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);

  // If intersection collapses, fallback to a
  if (right <= left + 10 || bottom <= top + 10) return a;
  return { ...a, left, top, right, bottom };
}

function boxToCrop(box) {
  const x = clampInt(box.left, 0, box.width - 2);
  const y = clampInt(box.top, 0, box.height - 2);
  const crop_w = clampInt(box.right - box.left + 1, 10, box.width - x);
  const crop_h = clampInt(box.bottom - box.top + 1, 10, box.height - y);
  return { x, y, crop_w, crop_h };
}

async function extractFramePng(inputPath, tsSeconds, outPath) {
  await run("ffmpeg", [
    "-y",
    "-ss",
    String(tsSeconds),
    "-i",
    inputPath,
    "-vframes",
    "1",
    "-vf",
    "scale=iw:ih",
    outPath,
  ]);
}

async function refineWithGPT5Mini({ frameBase64, src_w, src_h, initialCrop }) {
  // IMPORTANT: keep it aggressive, and force it to stay within initialCrop bounds.
  const messageContent = [
    {
      type: "image_url",
      image_url: {
        url: `data:image/png;base64,${frameBase64}`,
        detail: "high",
      },
    },
    {
      type: "text",
      text: `You are cropping a vertical social media video frame (${src_w}x${src_h}).

Goal: return the crop rectangle that contains ONLY the real video content area.
You MUST remove/avoid EVERYTHING that is not the underlying video content:
- ALL black bars (letterbox/pillarbox)
- ALL overlaid UI text, captions, usernames, watermarks, logos, headers/footers

This frame often has a black header/footer with white text/logos.
Those MUST be cropped out even if small.

Constraint: You must return a crop INSIDE this pre-detected safe region:
initial_safe_crop = { x:${initialCrop.x}, y:${initialCrop.y}, w:${initialCrop.crop_w}, h:${initialCrop.crop_h} }
So your returned crop must satisfy:
crop_x >= initial_safe_crop.x
crop_y >= initial_safe_crop.y
crop_x + crop_w <= initial_safe_crop.x + initial_safe_crop.w
crop_y + crop_h <= initial_safe_crop.y + initial_safe_crop.h

Return ONLY valid JSON (no markdown, no extra text):
{
  "crop_x": <int>,
  "crop_y": <int>,
  "crop_w": <int>,
  "crop_h": <int>,
  "confidence": <0-100>,
  "reasoning": "<one short sentence>"
}`,
    },
  ];

  const resp = await openai.chat.completions.create({
    model: "gpt-5-mini",
    messages: [{ role: "user", content: messageContent }],
    max_tokens: 300,
    temperature: 0.1,
  });

  const txt = resp.choices?.[0]?.message?.content || "";
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("GPT refine: no JSON found");
  const j = JSON.parse(m[0]);

  // Clamp to initial crop bounds strictly
  const minX = initialCrop.x;
  const minY = initialCrop.y;
  const maxX = initialCrop.x + initialCrop.crop_w;
  const maxY = initialCrop.y + initialCrop.crop_h;

  let crop_x = clampInt(j.crop_x, minX, maxX - 10);
  let crop_y = clampInt(j.crop_y, minY, maxY - 10);

  let crop_w = clampInt(j.crop_w, 10, maxX - crop_x);
  let crop_h = clampInt(j.crop_h, 10, maxY - crop_y);

  // If model returns something that still touches boundaries too much, nudge in slightly
  const nudge = 0; // keep 0 by default; you can set to 4–8 if needed
  crop_x = clampInt(crop_x + nudge, minX, maxX - 10);
  crop_y = clampInt(crop_y + nudge, minY, maxY - 10);
  crop_w = clampInt(crop_w - 2 * nudge, 10, maxX - crop_x);
  crop_h = clampInt(crop_h - 2 * nudge, 10, maxY - crop_y);

  return {
    crop_x,
    crop_y,
    crop_w,
    crop_h,
    confidence: Number.isFinite(j.confidence) ? j.confidence : 0,
    reasoning: typeof j.reasoning === "string" ? j.reasoning : "",
  };
}

// ---------------------------
// ✅ SMART: Detect crop box (content-only), with optional GPT-5-mini refine
// ---------------------------
app.post("/detect-ai", upload.single("file"), async (req, res) => {
  const cleanup = [];
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });
    }

    const inputPath = req.file.path;
    cleanup.push(() => fs.unlink(inputPath, () => {}));

    const { w: src_w, h: src_h } = await ffprobeDims(inputPath);
    if (!Number.isFinite(src_w) || !Number.isFinite(src_h)) {
      return res.status(400).json({ error: "Could not read video dimensions." });
    }

    const duration = await ffprobeDuration(inputPath);

    // By default: analyze multiple frames for stability (THIS fixes “variations”)
    const numFrames = req.body.num_frames ? Number(req.body.num_frames) : 5;
    const n = Number.isFinite(numFrames) && numFrames > 0 ? Math.min(9, Math.max(1, Math.floor(numFrames))) : 5;

    // Spread timestamps across the video (avoid very start/end)
    const timestamps = [];
    for (let i = 0; i < n; i++) {
      const t = (duration * 0.12) + (duration * 0.76) * (i / Math.max(1, n - 1));
      timestamps.push(Math.min(duration * 0.9, Math.max(0.2, t)));
    }

    // Detector params (tune from n8n if needed)
    const detectorParams = {
      lum_threshold: req.body.lum_threshold ?? 26,
      row_frac: req.body.row_frac ?? 0.12,
      col_frac: req.body.col_frac ?? 0.10,
      consecutive: req.body.consecutive ?? 6,
      safe_margin: req.body.safe_margin ?? 8,
      min_w: req.body.min_w ?? 200,
      min_h: req.body.min_h ?? 200,
    };

    let intersectionBox = null;
    let pickedFrameForAI = null;

    for (let i = 0; i < timestamps.length; i++) {
      const framePath = path.join("/tmp", `frame-${Date.now()}-${i}.png`);
      cleanup.push(() => fs.unlink(framePath, () => {}));

      try {
        await extractFramePng(inputPath, timestamps[i], framePath);
        const buf = fs.readFileSync(framePath);
        const png = PNG.sync.read(buf);

        const box = detectContentBoxFromPng(png, detectorParams);
        intersectionBox = intersectionBox ? intersectBoxes(intersectionBox, box) : box;

        // Keep one representative frame for optional GPT refine (middle one preferred)
        if (i === Math.floor(timestamps.length / 2)) {
          pickedFrameForAI = buf.toString("base64");
        }
      } catch (e) {
        // If one frame fails, keep going
        console.error("Frame analysis failed:", e?.stderr || e);
      }
    }

    if (!intersectionBox) {
      return res.status(500).json({ error: "Failed to analyze frames for content box." });
    }

    const initialCrop = boxToCrop(intersectionBox);

    // Optional GPT refine (ON by default if key exists, can disable via ai_refine=false)
    const aiRefineRequested = String(req.body.ai_refine ?? "true").toLowerCase() !== "false";
    const canRefine = aiRefineRequested && !!process.env.OPENAI_API_KEY && !!pickedFrameForAI;

    let final = {
      x: initialCrop.x,
      y: initialCrop.y,
      crop_w: initialCrop.crop_w,
      crop_h: initialCrop.crop_h,
      confidence: 80,
      reasoning: "Content box detected by pixel-fraction method (bars/UI excluded).",
      refined_by_ai: false,
    };

    if (canRefine) {
      try {
        const refined = await refineWithGPT5Mini({
          frameBase64: pickedFrameForAI,
          src_w,
          src_h,
          initialCrop,
        });

        final = {
          x: clampInt(refined.crop_x, 0, src_w - 10),
          y: clampInt(refined.crop_y, 0, src_h - 10),
          crop_w: clampInt(refined.crop_w, 10, src_w - clampInt(refined.crop_x, 0, src_w - 10)),
          crop_h: clampInt(refined.crop_h, 10, src_h - clampInt(refined.crop_y, 0, src_h - 10)),
          confidence: refined.confidence ?? 0,
          reasoning: refined.reasoning || "Refined by GPT-5-mini within safe region.",
          refined_by_ai: true,
        };
      } catch (e) {
        console.error("GPT refine failed, falling back to pixel box:", e);
      }
    }

    // Cleanup
    cleanup.forEach((fn) => fn());

    return res.json({
      crop_w: final.crop_w,
      crop_h: final.crop_h,
      x: final.x,
      y: final.y,
      src_w,
      src_h,
      ai_powered: true,
      model_used: "gpt-5-mini",
      refined_by_ai: final.refined_by_ai,
      reasoning: final.reasoning,
      confidence: final.confidence,
      frames_analyzed: timestamps.length,
      timestamps_sampled: timestamps,
      detector_params: detectorParams,
    });
  } catch (e) {
    cleanup.forEach((fn) => fn());
    console.error("detect-ai error:", e);
    return res.status(500).json({
      error: "detect-ai failed",
      details: String(e?.message || e),
      stderr: e?.stderr ? String(e.stderr).slice(0, 2000) : undefined,
      stack: e?.stack,
    });
  }
});

// ---------------------------
// ✅ FALLBACK: Basic pixel detection (dark-row scan only)
// ---------------------------
function detectCutsFromPng(png, opts = {}) {
  const { width, height, data } = png;

  const darkThreshold = Number(opts.darkThreshold ?? 35);
  const minBandRatio = Number(opts.minBandRatio ?? 0.03);
  const maxBandRatio = Number(opts.maxBandRatio ?? 0.35);

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

  return { topCut, bottomCut, width, height };
}

app.post("/detect", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });
    }

    const inputPath = req.file.path;
    const sampleTime = req.body.sample_time ? Number(req.body.sample_time) : 0.5;

    const { w: src_w, h: src_h } = await ffprobeDims(inputPath);
    if (!Number.isFinite(src_w) || !Number.isFinite(src_h)) {
      return res.status(400).json({ error: "Could not read video dimensions." });
    }

    const framePath = path.join("/tmp", `frame-${Date.now()}.png`);

    await run("ffmpeg", [
      "-y",
      "-ss",
      String(sampleTime),
      "-i",
      inputPath,
      "-vframes",
      "1",
      "-vf",
      "scale=iw:ih",
      framePath,
    ]);

    const buf = fs.readFileSync(framePath);
    const png = PNG.sync.read(buf);

    const { topCut, bottomCut } = detectCutsFromPng(png, {
      darkThreshold: req.body.dark_threshold ? Number(req.body.dark_threshold) : 35,
      minBandRatio: req.body.min_band_ratio ? Number(req.body.min_band_ratio) : 0.03,
      maxBandRatio: req.body.max_band_ratio ? Number(req.body.max_band_ratio) : 0.35,
    });

    const safeMargin = req.body.safe_margin ? Number(req.body.safe_margin) : 10;

    // Keep full width, only trim top/bottom
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
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });
    }

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
      `crop=${crop_w}:${crop_h}:${x}:${y}`,
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

// ---------------------------
// Health check
// ---------------------------
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    openai_configured: !!process.env.OPENAI_API_KEY,
    endpoints: ["/detect-ai", "/detect", "/crop"],
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FFmpeg service listening on port ${PORT}`);
  console.log(`OpenAI API Key configured: ${!!process.env.OPENAI_API_KEY}`);
});
