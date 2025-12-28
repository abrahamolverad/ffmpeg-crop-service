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

/**
 * ✅ Auto-detect crop rectangle using ffmpeg cropdetect
 * POST /detect  (multipart/form-data)
 * field: file  (video)
 * optional: sample_time (seconds, default 0.5)
 */
app.post("/detect", upload.any(), async (req, res) => {
  try {
    // Be tolerant: accept any field name and take first file
    const file = req.files?.[0];
    if (!file) {
      return res.status(400).json({ error: "No file uploaded. Send multipart/form-data with a file." });
    }

    const inputPath = file.path;

    const sample_time = req.body.sample_time ? Number(req.body.sample_time) : 0.5;
    if (!Number.isFinite(sample_time) || sample_time < 0) {
      return res.status(400).json({ error: "Invalid sample_time. Must be a number >= 0." });
    }

    // Run cropdetect on a short slice
    // -ss seeks, -t processes ~1s, cropdetect prints "crop=w:h:x:y" in stderr
    const args = [
      "-hide_banner",
      "-ss",
      String(sample_time),
      "-i",
      inputPath,
      "-t",
      "1",
      "-vf",
      "cropdetect=24:16:0", // (limit:24, round:16, reset:0)
      "-f",
      "null",
      "-"
    ];

    execFile("ffmpeg", args, (err, stdout, stderr) => {
      // Always cleanup input
      fs.unlink(inputPath, () => {});

      if (err) {
        return res.status(500).json({
          error: "ffmpeg detect failed",
          details: stderr?.slice?.(0, 4000) || String(err),
        });
      }

      // Parse LAST crop= line
      const lines = (stderr || "").split("\n");
      const cropLines = lines.filter((l) => l.includes("crop="));
      const last = cropLines[cropLines.length - 1] || "";
      const match = last.match(/crop=(\d+):(\d+):(\d+):(\d+)/);

      if (!match) {
        return res.status(422).json({
          error: "Could not detect crop",
          details: last.slice(0, 500),
        });
      }

      const crop_w = Number(match[1]);
      const crop_h = Number(match[2]);
      const x = Number(match[3]);
      const y = Number(match[4]);

      return res.json({
        crop_w,
        crop_h,
        x,
        y,
        sample_time,
        method: "ffmpeg_cropdetect",
      });
    });
  } catch (e) {
    res.status(500).json({ error: "Server error", details: String(e) });
  }
});

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
