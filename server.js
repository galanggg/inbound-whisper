const express = require('express');
const multer = require('multer');
const { exec } = require('child_process'); // exec will be used for the script
const fs = require('fs');
const path = require('path');
const cors = require('cors');
// const https = require('https'); // No longer needed for direct download

const app = express();
const port = process.env.PORT || 3000;

// --- Configuration for Models ---
// Assuming server.js is at the root of your project for __dirname,
// and 'app' is a peer directory for the models.
// For a fixed path as per your original setup and Docker environment:
const MODELS_DIR = '/app/whisper.cpp/models';
const MODEL_DOWNLOAD_SCRIPT = path.join(MODELS_DIR, 'download-ggml-model.sh');
const SCRIPT_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB, for example

// Ensure MODELS_DIR exists (important for Docker environments where it might not be pre-created)
// The download script itself might also create it, but good to be defensive.
if (!fs.existsSync(MODELS_DIR)) {
  try {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    console.log(`Created models directory: ${MODELS_DIR}`);
  } catch (err) {
    console.error(`Error creating models directory ${MODELS_DIR}:`, err);
  }
}

// List of valid models (names the download script understands)
const validModels = [
    'tiny', 'base', 'small', 'medium', 'large',
    'tiny.en', 'base.en', 'small.en', 'medium.en',
    'large-v1', 'large-v2', 'large-v3'
];

// Enable CORS
app.use(cors());
app.use(express.json()); // Middleware to parse JSON bodies

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

// --- Function to Ensure Model Exists using the shell script ---
function ensureModelExists(modelSize) {
  return new Promise((resolve, reject) => {
    const expectedModelFileName = `ggml-${modelSize}.bin`;
    const modelPath = path.join(MODELS_DIR, expectedModelFileName);

    if (fs.existsSync(modelPath)) {
      console.log(`Model ${expectedModelFileName} found locally at ${modelPath}`);
      resolve(modelPath);
      return;
    }

    console.log(`Model ${expectedModelFileName} not found locally. Attempting download using script: ${MODEL_DOWNLOAD_SCRIPT} for model size: ${modelSize}`);

    // Check if download script exists
    if (!fs.existsSync(MODEL_DOWNLOAD_SCRIPT)) {
        const scriptError = `Download script not found at ${MODEL_DOWNLOAD_SCRIPT}. Cannot download model.`;
        console.error(scriptError);
        reject(new Error(scriptError));
        return;
    }
    if (!fs.statSync(MODEL_DOWNLOAD_SCRIPT).isFile()) { // Basic check if it's a file
        const scriptError = `${MODEL_DOWNLOAD_SCRIPT} is not a file. Cannot download model.`;
        console.error(scriptError);
        reject(new Error(scriptError));
        return;
    }


    // Execute the script. The script name itself implies it handles ggml prefixes etc.
    // The script should be executable (chmod +x download-ggml-model.sh)
    const command = `sh "${MODEL_DOWNLOAD_SCRIPT}" ${modelSize}`;

    exec(command, { cwd: MODELS_DIR, maxBuffer: SCRIPT_MAX_BUFFER }, (error, stdout, stderr) => {
      console.log(`Download script stdout for ${modelSize}:\n${stdout}`);
      console.error(`Download script stderr for ${modelSize}:\n${stderr}`);

      if (error) {
        const execError = `Error executing download script for model ${modelSize}: ${error.message}`;
        console.error(execError);
        reject(new Error(execError));
        return;
      }

      // After script execution, verify the model file was actually created
      if (fs.existsSync(modelPath)) {
        console.log(`Model ${expectedModelFileName} downloaded successfully to ${modelPath} via script.`);
        resolve(modelPath);
      } else {
        const downloadVerifyError = `Download script for ${modelSize} executed but model file ${expectedModelFileName} not found at ${modelPath}. Check script output.`;
        console.error(downloadVerifyError);
        reject(new Error(downloadVerifyError));
      }
    });
  });
}


// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Endpoint to transcribe audio
app.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided' });
  }

  const audioPath = req.file.path;
  console.log(`Received audio file for transcription: ${audioPath}`);
  const modelSize = req.body.model || 'medium';
  const language = req.body.language || 'auto';

  if (!validModels.includes(modelSize)) {
    return res.status(400).json({ error: `Invalid model size. Valid models are: ${validModels.join(', ')}` });
  }

  let localModelPath;
  try {
    localModelPath = await ensureModelExists(modelSize); // This is now a promise
  } catch (error) {
    console.error(`Failed to ensure model ${modelSize} exists:`, error);
    return res.status(500).json({ error: `Failed to download or access model ${modelSize}`, details: error.message });
  }

  const outputJSONPath = `${audioPath}.json`;
  const whisperCommand = `/app/whisper.cpp/build/bin/whisper-cli -m "${localModelPath}" -f "${audioPath}" -l ${language} --output-json`;

  console.log(`Executing: ${whisperCommand}`);
  exec(whisperCommand, (error, stdout, stderr) => {
    console.log(`Whisper stdout:\n${stdout}`);
    console.log(`Whisper stderr:\n${stderr}`);
    if (error) {
      console.error(`Whisper exec error: ${error.message}`);
      return res.status(500).json({
          error: 'Transcription process failed',
          details: `Exec error: ${error.message}`,
          whisper_stderr: stderr,
          whisper_stdout: stdout
      });
    }
    if (!fs.existsSync(outputJSONPath)) {
        console.error(`Output file ${outputJSONPath} not found after whisper-cli execution.`);
        return res.status(500).json({
          error: 'Transcription output file not created by whisper-cli',
          details: `Expected file at: ${outputJSONPath}`,
          whisper_stderr: stderr,
          whisper_stdout: stdout
        });
    }
    fs.readFile(outputJSONPath, 'utf8', (err, data) => {
    console.log(`Read data from ${outputJSONPath}:`, data);
      if (err) {
        console.error(`Failed to read JSON transcription result from ${outputJSONPath}: ${err}`);
        return res.status(500).json({
            error: 'Failed to read transcription result file',
            details: `File system error: ${err.message}`,
            path: outputJSONPath
        });
      }
      try {
        const transcriptionJson = JSON.parse(data);
        console.log(`Parsed transcription JSON:`, transcriptionJson);
        res.status(200).json({
          success: true,
          transcription: transcriptionJson.transcription,
        });
        cleanupFiles(audioPath, outputJSONPath);
      } catch (parseError) {
        console.error(`Failed to parse JSON transcription: ${parseError}`);
        res.status(500).json({ error: 'Failed to parse transcription JSON output', raw_output: data });
      }
    });
  });
});

// Endpoint to list available models
app.get('/models', (req, res) => {
  if (!fs.existsSync(MODELS_DIR)) {
    console.warn(`Models directory ${MODELS_DIR} not found for listing.`);
    return res.json({ models: [] });
  }
  fs.readdir(MODELS_DIR, (err, files) => {
    if (err) {
      console.error(`Failed to list models from ${MODELS_DIR}:`, err);
      return res.status(500).json({ error: 'Failed to list models' });
    }

    console.log(`Listing models from ${MODELS_DIR}:`, files);
    const models = files
      .filter(file => file.startsWith('ggml-') && file.endsWith('.bin'))
      .map(file => file.replace('ggml-', '').replace('.bin', ''));
    res.json({ models });
  });
});

// Endpoint to Download a Specific Model using the script
app.post('/models/download', async (req, res) => {
  const { model: modelSize } = req.body;

  if (!modelSize) {
    return res.status(400).json({ success: false, message: 'Model name not provided in request body.' });
  }

  if (!validModels.includes(modelSize)) {
    return res.status(400).json({
      success: false,
      message: `Invalid model name: ${modelSize}. Valid models are: ${validModels.join(', ')}`
    });
  }

  try {
    console.log(`Received request to download model: ${modelSize} using script.`);
    await ensureModelExists(modelSize); // This will use the script
    res.status(200).json({
      success: true,
      message: `Model ${modelSize} is available locally. Download initiated via script if it wasn't present.`
    });
  } catch (error) {
    console.error(`Error ensuring model ${modelSize} exists via API endpoint (using script):`, error);
    res.status(500).json({
      success: false,
      message: `Failed to download or ensure model ${modelSize} is available via script.`,
      details: error.message
    });
  }
});

// Clean up uploaded files after processing
function cleanupFiles(...files) {
  files.forEach(file => {
    fs.unlink(file, (err) => {
      if (err) console.error(`Failed to delete file: ${file}`, err);
      else console.log(`Successfully deleted file: ${file}`);
    });
  });
}

app.listen(port, '0.0.0.0', () => {
  console.log(`Whisper API server listening on port ${port}`);
});
