import express from 'express';
import multer from 'multer';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ dest: '/tmp' });

app.post('/crop', upload.single('file'), async (req, res) => {
  try {
    const {
      crop_w,
      crop_h,
      crop_x,
      crop_y,
      start = 0,
      end
    } = req.body;

    if (!req.file) {
      return res.status(400).send('No video file provided');
    }

    const inputPath = req.file.path;
    const outputPath = `${inputPath}_out.mp4`;

    const args = [
      '-y',
      '-ss', String(start),
      ...(end ? ['-to', String(end)] : []),
      '-i', inputPath,
      '-vf', `crop=${crop_w}:${crop_h}:${crop_x}:${crop_y}`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath
    ];

    execFile('ffmpeg', args, (err) => {
      if (err) {
        console.error(err);
        return res.status(500).send('FFmpeg error');
      }

      res.sendFile(outputPath, () => {
        fs.unlinkSync(inputPath);
        fs.unlinkSync(outputPath);
      });
    });

  } catch (e) {
    console.error(e);
    res.status(500).send('Server error');
  }
});

app.get('/', (_, res) => {
  res.send('FFmpeg service running');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FFmpeg service listening on port ${PORT}`);
});
