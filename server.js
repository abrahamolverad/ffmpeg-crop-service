import express from "express";
import multer from "multer";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { PNG } from "pngjs";
import OpenAI from "openai";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: "/tmp" });

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

// Simple "header/footer" detection by scanning dark rows.
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

// ---------------------------
// ✅ NEW: AI-Powered Detection (Multi-Frame)
// ---------------------------
app.post("/detect-ai", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });
    }

    const inputPath = req.file.path;
    
    // Get video dimensions
    const { w: src_w, h: src_h } = await ffprobeDims(inputPath);
    if (!Number.isFinite(src_w) || !Number.isFinite(src_h)) {
      return res.status(400).json({ error: "Could not read video dimensions." });
    }

    // Get video duration to calculate good sample points
    const { stdout: durationOutput } = await run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      inputPath,
    ]);
    const durationData = JSON.parse(durationOutput);
    const duration = Number(durationData?.format?.duration) || 10;

    // Sample ONLY 1 frame from middle for faster, more consistent results
    const numFrames = 1;
    const timestamps = [duration * 0.4]; // Sample at 40% through the video

    console.log(`Extracting ${numFrames} frames at timestamps:`, timestamps);

    // Extract frames
    const frames = [];
    for (let i = 0; i < timestamps.length; i++) {
      const framePath = path.join("/tmp", `frame-${Date.now()}-${i}.png`);
      
      try {
        await run("ffmpeg", [
          "-y",
          "-ss",
          String(timestamps[i]),
          "-i",
          inputPath,
          "-vframes",
          "1",
          "-vf",
          "scale=iw:ih",
          framePath,
        ]);

        const frameBuffer = fs.readFileSync(framePath);
        frames.push({
          base64: frameBuffer.toString("base64"),
          timestamp: timestamps[i],
        });

        fs.unlinkSync(framePath);
      } catch (frameErr) {
        console.error(`Failed to extract frame at ${timestamps[i]}s:`, frameErr);
      }
    }

    if (frames.length === 0) {
      return res.status(500).json({ error: "Failed to extract any frames from video" });
    }

    console.log(`Successfully extracted ${frames.length} frames, sending to OpenAI...`);

    // Build OpenAI message with all frames
    const messageContent = [
      ...frames.map((frame) => ({
        type: "image_url",
        image_url: {
          url: `data:image/png;base64,${frame.base64}`,
          detail: "high",
        },
      })),
      {
        type: "text",
        text: `You are analyzing ${frames.length} frames from a vertical social media video (${src_w}x${src_h} pixels) extracted at timestamps: ${timestamps.map(t => t.toFixed(1) + "s").join(", ")}.

Your task is to determine the optimal crop rectangle that:
1. EXCLUDES all UI elements: text overlays, usernames, captions, watermarks, logos, headers, footers
2. PRESERVES the main subject/action/content that viewers care about
3. WORKS consistently across all ${frames.length} frames shown
4. Handles any moving or static overlays intelligently

Analysis guidelines:
- Look for consistent dark bars, text areas, or branding at top/bottom
- Identify the core content area (usually the person, scene, or main action)
- Be conservative - it's better to include slightly more than to cut off important content
- If in doubt, favor keeping the subject's full body/face visible

Respond with ONLY a valid JSON object (no markdown, no code blocks, no extra text):
{
  "crop_x": <number>,
  "crop_y": <number>,
  "crop_w": <number>,
  "crop_h": <number>,
  "reasoning": "<brief explanation of what you excluded and why>",
  "confidence": <0-100, your confidence in this crop>
}

All values must be integers. The crop must fit within ${src_w}x${src_h}.`,
      },
    ];

    // Call OpenAI GPT-4o-mini Vision (cheaper alternative)
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: messageContent,
        },
      ],
      max_tokens: 800,
      temperature: 0.3,
    });

    console.log("OpenAI response received");

    const responseText = response.choices[0].message.content;
    console.log("Raw OpenAI response:", responseText);

    // Parse JSON from response (strip any markdown if present)
    let cropData;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }
      cropData = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error("Failed to parse OpenAI response:", parseErr);
      return res.status(500).json({
        error: "Failed to parse AI response",
        raw_response: responseText,
      });
    }

    // Validate and enforce minimum cropping
    let crop_x = Math.max(0, Math.floor(cropData.crop_x));
    let crop_y = Math.max(0, Math.floor(cropData.crop_y));
    let crop_w = Math.floor(cropData.crop_w);
    let crop_h = Math.floor(cropData.crop_h);

    // ENFORCE: If crop is too conservative, apply minimum safe cropping
    // Most social videos have at least 100px header and 100px footer
    if (crop_y < 80) {
      console.log(`Warning: crop_y too small (${crop_y}), enforcing minimum 100px top crop`);
      crop_y = 100;
    }
    
    const bottom_margin = src_h - (crop_y + crop_h);
    if (bottom_margin < 80) {
      console.log(`Warning: bottom margin too small (${bottom_margin}), enforcing minimum 100px bottom crop`);
      crop_h = src_h - crop_y - 100;
    }

    // Ensure crop stays within bounds
    crop_w = Math.max(10, Math.min(src_w - crop_x, crop_w));
    crop_h = Math.max(10, Math.min(src_h - crop_y, crop_h));

    // Cleanup
    fs.unlink(inputPath, () => {});

    return res.json({
      crop_w,
      crop_h,
      x: crop_x,
      y: crop_y,
      src_w,
      src_h,
      reasoning: cropData.reasoning || "No reasoning provided",
      confidence: cropData.confidence || 0,
      frames_analyzed: frames.length,
      timestamps_sampled: timestamps,
      ai_powered: true,
      model_used: "gpt-4o-mini",
    });
  } catch (e) {
    console.error("AI detection error:", e);
    return res.status(500).json({
      error: "AI detection failed",
      details: String(e.message || e),
      stack: e.stack,
    });
  }
});

// ---------------------------
// ✅ FALLBACK: Basic pixel detection (no AI)
// ---------------------------
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
// ✅ EXISTING: /crop endpoint
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
  console.log(`FFmpeg service with AI detection listening on port ${PORT}`);
  console.log(`OpenAI API Key configured: ${!!process.env.OPENAI_API_KEY}`);
});
