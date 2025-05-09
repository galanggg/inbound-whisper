const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS
app.use(cors());
app.use(express.json());

// Configure file storage for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({ storage });

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Endpoint to transcribe audio
app.post('/transcribe', upload.single('audio'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }

  const audioPath = req.file.path;
  const modelSize = req.body.model || 'medium';
  const language = req.body.language || 'auto';

  // Validate model size
  const validModels = ['tiny', 'base', 'small', 'medium', 'large'];
  if (!validModels.includes(modelSize)) {
    return res.status(400).json({ error: 'Invalid model size' });
  }

  const outputPath = `${audioPath}.txt`;
  const whisperCommand = `/app/whisper.cpp/build/bin/whisper-cli -m /app/whisper.cpp/models/ggml-${modelSize}.bin -f "${audioPath}" -l ${language} -otxt`;

  console.log(`Executing: ${whisperCommand}`);

  exec(whisperCommand, (error, stdout, stderr) => {
    if (error) {
      console.error(`Whisper error: ${error}`);
      return res.status(500).json({ error: 'Transcription failed', details: stderr });
    }

    // Read the transcription result
    fs.readFile(`${audioPath}.txt`, 'utf8', (err, data) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to read transcription result' });
      }

      // Cleanup files
      cleanupFiles(audioPath, `${audioPath}.txt`);

      res.json({
        success: true,
        transcription: data.trim()
      });
    });
  });
});

// Endpoint to list available models
app.get('/models', (req, res) => {
  const modelsDir = '/app/whisper.cpp/models';

  fs.readdir(modelsDir, (err, files) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to list models' });
    }

    const models = files
      .filter(file => file.endsWith('.bin'))
      .map(file => file.replace('ggml-', '').replace('.bin', ''));

    res.json({ models });
  });
});

// Clean up uploaded files after processing
function cleanupFiles(...files) {
  files.forEach(file => {
    fs.unlink(file, (err) => {
      if (err) console.error(`Failed to delete file: ${file}`, err);
    });
  });
}

app.listen(port, '0.0.0.0', () => {
  console.log(`Whisper API server listening on port ${port}`);
});
