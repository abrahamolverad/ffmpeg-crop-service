import express from "express";
import multer from "multer";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";

const app = express();

// ✅ parse JSON + form urlencoded (won’t parse multipart; multer handles that)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: "/tmp" });

app.get("/", (req, res) => res.send("ffmpeg-crop-service OK"));

app.post("/crop", upload.single("file"), async (req, res) => {
  try {
    // ✅ file from multer
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Use field name 'file'." });
    }

    // ✅ read fields safely (NO destructuring)
    const crop_w = Number(req.body.crop_w);
    const crop_h = Number(req.body.crop_h);
    const x = Number(req.body.x);
    const y = Number(req.body.y);

    // Optional trim
    const start = req.body.start ? Number(req.body.start) : null; // seconds
    const duration = req.body.duration ? Number(req.body.duration) : null;

    if (![crop_w, crop_h, x, y].every((n) => Number.isFinite(n))) {
      return res.status(400).json({
        error: "Missing/invalid crop params. Required: crop_w,crop_h,x,y (numbers).",
        received: req.body,
      });
    }

    const inputPath = req.file.path; // e.g. /tmp/xxxx
    const outputPath = path.join("/tmp", `cropped-${Date.now()}.mp4`);

    // Build ffmpeg args
    const args = [];

    // Trim (optional)
    if (start !== null) args.push("-ss", String(start));
    args.push("-i", inputPath);
    if (duration !== null) args.push("-t", String(duration));

    // Crop
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

      // Return file
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", 'attachment; filename="cropped.mp4"');

      const stream = fs.createReadStream(outputPath);
      stream.on("close", () => {
        // cleanup
        fs.unlink(inputPath, () => {});
        fs.unlink(outputPath, () => {});
      });
      stream.pipe(res);
    });
  } catch (e) {
    res.status(500).json({ error: "Server error", details: String(e) });
  }
});

// ✅ MUST listen on Render PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg service listening on port ${PORT}`));
