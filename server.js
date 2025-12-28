import express from "express";
import multer from "multer";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: "/tmp" });

app.get("/", (req, res) => res.send("ffmpeg-crop-service OK"));

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) return reject({ err, stdout, stderr });
      resolve({ stdout, stderr });
    });
  });
}

async function probeVideo(filePath) {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0];
  if (!stream?.width || !stream?.height) throw new Error("ffprobe failed to read width/height");
  return { width: Number(stream.width), height: Number(stream.height) };
}

function parseCropdetect(stderrText) {
  // cropdetect prints lines containing: crop=w:h:x:y
  const matches = [...stderrText.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  return {
    crop_w: Number(last[1]),
    crop_h: Number(last[2]),
    x: Number(last[3]),
    y: Number(last[4]),
  };
}

/**
 * POST /detect
 * multipart/form-data: file=<video>, optional sample_time, frames, limit
 * Returns JSON crop params
 */
app.post("/detect", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });
    }

    const inputPath = req.file.path;

    const sample_time = req.body.sample_time ? Number(req.body.sample_time) : 0.5; // seconds
    const frames = req.body.frames ? Number(req.body.frames) : 30; // analyze N frames
    const limit = req.body.limit ? Number(req.body.limit) : 24; // cropdetect sensitivity-ish

    if (![sample_time, frames, limit].every(Number.isFinite)) {
      return res.status(400).json({ error: "Invalid detect params", received: req.body });
    }

    // Run cropdetect on a small window of frames
    // -ss seeks first, -frames:v analyzes only a handful of frames
    const args = [
      "-hide_banner",
      "-ss",
      String(sample_time),
      "-i",
      inputPath,
      "-vf",
      `cropdetect=limit=${limit}:round=2:reset=0`,
      "-frames:v",
      String(frames),
      "-f",
      "null",
      "-",
    ];

    let stderr;
    try {
      const out = await run("ffmpeg", args);
      stderr = out.stderr || "";
    } catch (e) {
      stderr = e.stderr || "";
      // even if ffmpeg returns non-zero sometimes, we still try parsing stderr
    }

    const crop = parseCropdetect(stderr);
    if (!crop) {
      return res.status(422).json({
        error: "Could not detect crop",
        details: (stderr || "").slice(0, 3000),
      });
    }

    // Safety clamp to video bounds
    const { width, height } = await probeVideo(inputPath);
    if (crop.crop_w > width) crop.crop_w = width;
    if (crop.crop_h > height) crop.crop_h = height;
    if (crop.x < 0) crop.x = 0;
    if (crop.y < 0) crop.y = 0;

    // cleanup input
    fs.unlink(inputPath, () => {});

    return res.json({ ...crop, source_w: width, source_h: height });
  } catch (e) {
    return res.status(500).json({ error: "detect failed", details: String(e?.err || e) });
  }
});

/**
 * POST /autocrop
 * multipart/form-data: file=<video>, optional detect params + optional trim params
 * Detects crop then returns cropped mp4
 */
app.post("/autocrop", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });
    }

    const inputPath = req.file.path;
    const outputPath = path.join("/tmp", `autocropped-${Date.now()}.mp4`);

    const sample_time = req.body.sample_time ? Number(req.body.sample_time) : 0.5;
    const frames = req.body.frames ? Number(req.body.frames) : 30;
    const limit = req.body.limit ? Number(req.body.limit) : 24;

    // Optional trim
    const start = req.body.start ? Number(req.body.start) : null;
    const duration = req.body.duration ? Number(req.body.duration) : null;

    // 1) detect crop
    let stderrDetect = "";
    try {
      const out = await run("ffmpeg", [
        "-hide_banner",
        "-ss",
        String(sample_time),
        "-i",
        inputPath,
        "-vf",
        `cropdetect=limit=${limit}:round=2:reset=0`,
        "-frames:v",
        String(frames),
        "-f",
        "null",
        "-",
      ]);
      stderrDetect = out.stderr || "";
    } catch (e) {
      stderrDetect = e.stderr || "";
    }

    const crop = parseCropdetect(stderrDetect);
    if (!crop) {
      fs.unlink(inputPath, () => {});
      return res.status(422).json({
        error: "Could not detect crop",
        details: (stderrDetect || "").slice(0, 3000),
      });
    }

    // 2) apply crop
    const args = [];
    if (start !== null) args.push("-ss", String(start));
    args.push("-i", inputPath);
    if (duration !== null) args.push("-t", String(duration));

    args.push(
      "-vf",
      `crop=${crop.crop_w}:${crop.crop_h}:${crop.x}:${crop.y}`,
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

    try {
      await run("ffmpeg", args);
    } catch (e) {
      return res.status(500).json({
        error: "ffmpeg failed",
        details: (e.stderr || String(e.err || e)).slice(0, 4000),
      });
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="autocropped.mp4"');

    const stream = fs.createReadStream(outputPath);
    stream.on("close", () => {
      fs.unlink(inputPath, () => {});
      fs.unlink(outputPath, () => {});
    });
    stream.pipe(res);
  } catch (e) {
    res.status(500).json({ error: "Server error", details: String(e) });
  }
});

// Render PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg service listening on port ${PORT}`));
