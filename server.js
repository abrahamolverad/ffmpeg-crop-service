import express from "express";
import multer from "multer";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { PNG } from "pngjs";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: "/tmp" });

app.get("/", (req, res) => res.send("ffmpeg-crop-service OK"));

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

// Simple “header/footer” detection by scanning dark rows.
// Works well for: black UI bars, black title headers, repost overlays at top/bottom.
function detectCutsFromPng(png, opts = {}) {
  const { width, height, data } = png;

  const darkThreshold = Number(opts.darkThreshold ?? 35); // 0..255
  const minBandRatio = Number(opts.minBandRatio ?? 0.03); // 3% height
  const maxBandRatio = Number(opts.maxBandRatio ?? 0.35); // 35% height

  const minBand = Math.floor(height * minBandRatio);
  const maxBand = Math.floor(height * maxBandRatio);

  const rowMean = new Array(height).fill(0);

  // mean luminance per row
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      // luminance
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    rowMean[y] = sum / width;
  }

  // Top cut: find longest prefix of “dark rows”
  let topCut = 0;
  while (topCut < maxBand && rowMean[topCut] < darkThreshold) topCut++;

  // Bottom cut: find longest suffix of “dark rows”
  let bottomCut = 0;
  while (bottomCut < maxBand && rowMean[height - 1 - bottomCut] < darkThreshold) bottomCut++;

  // Only accept cut if it’s at least minBand; otherwise treat as 0
  if (topCut < minBand) topCut = 0;
  if (bottomCut < minBand) bottomCut = 0;

  return { topCut, bottomCut, width, height };
}

// ---------------------------
// ✅ NEW: /detect
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

    // Extract one frame
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

    // Usable area after removing header/footer
    const usableY0 = topCut;
    const usableY1 = src_h - bottomCut;
    const usableH = Math.max(1, usableY1 - usableY0);

    // Build a square crop inside usable region
    const safeMargin = req.body.safe_margin ? Number(req.body.safe_margin) : 0; // pixels
    const cropSize = Math.min(src_w, usableH) - safeMargin * 2;
    const crop_w = Math.max(2, Math.floor(cropSize));
    const crop_h = crop_w;

    // Center it
    const x = Math.max(0, Math.floor((src_w - crop_w) / 2));
    const y = Math.max(0, Math.floor(usableY0 + (usableH - crop_h) / 2));

    // cleanup
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
    });
  } catch (e) {
    return res.status(500).json({ error: "detect failed", details: String(e?.stderr || e) });
  }
});

// ---------------------------
// ✅ EXISTING: /crop
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg service listening on port ${PORT}`));
