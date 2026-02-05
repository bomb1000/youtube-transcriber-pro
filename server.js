const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const OpenAI = require('openai');
const axios = require('axios');
const apiLogger = require('./api-logger');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Default API Keys from environment variables
const DEFAULT_API_KEYS = {
    gemini: process.env.GEMINI_API_KEY || '',
    openai: process.env.OPENAI_API_KEY || '',
    assemblyai: process.env.ASSEMBLYAI_API_KEY || ''
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Ensure temp directory exists
const TEMP_DIR = path.join(__dirname, 'temp');
fs.ensureDirSync(TEMP_DIR);

// ===== API to get default keys status =====
app.get('/api/config', (req, res) => {
    res.json({
        hasDefaultKeys: {
            gemini: !!DEFAULT_API_KEYS.gemini,
            openai: !!DEFAULT_API_KEYS.openai,
            assemblyai: !!DEFAULT_API_KEYS.assemblyai
        }
    });
});

// ===== Routes =====

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'YouTube Transcriber Pro API is running' });
});

// Download audio from YouTube using yt-dlp
app.post('/api/download', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'Missing YouTube URL' });
    }

    try {
        const videoId = extractVideoId(url);
        if (!videoId) {
            return res.status(400).json({ error: 'Invalid YouTube URL' });
        }

        const audioPath = path.join(TEMP_DIR, `${videoId}.webm`);

        // Check if already downloaded and has content
        if (await fs.pathExists(audioPath)) {
            const stats = await fs.stat(audioPath);
            if (stats.size > 0) {
                console.log(`Audio already exists: ${audioPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
                return res.json({
                    success: true,
                    videoId,
                    audioPath,
                    message: 'Audio already downloaded'
                });
            } else {
                // File is empty, delete it and re-download
                await fs.remove(audioPath);
            }
        }

        console.log(`Downloading audio for video: ${videoId} using yt-dlp`);

        // Cross-platform yt-dlp path detection
        const isWindows = process.platform === 'win32';
        let ytdlpPath = 'yt-dlp'; // Default: assume it's in PATH (Linux/Railway)
        let ffmpegPath = '';

        if (isWindows) {
            // Windows: try WinGet Links path first
            const wingetLinks = process.env.LOCALAPPDATA
                ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')
                : '';
            if (wingetLinks && fs.existsSync(path.join(wingetLinks, 'yt-dlp.exe'))) {
                ytdlpPath = path.join(wingetLinks, 'yt-dlp.exe');
                ffmpegPath = wingetLinks;
            }
        }

        const ytdlpArgs = [
            '-x',                           // Extract audio only
            '--audio-format', 'opus',       // Convert to opus (webm container)
            '--audio-quality', '0',         // Best quality
            '-o', audioPath.replace('.webm', '.%(ext)s'),  // Output path
            '--no-playlist',                // Don't download playlist
            '--no-warnings',                // Suppress warnings
        ];

        // Add ffmpeg location if available (Windows)
        if (ffmpegPath) {
            ytdlpArgs.push('--ffmpeg-location', ffmpegPath);
        }

        ytdlpArgs.push(url);

        await new Promise((resolve, reject) => {
            const ytdlp = spawn(ytdlpPath, ytdlpArgs);

            let stderr = '';

            ytdlp.stdout.on('data', (data) => {
                console.log(`yt-dlp: ${data}`);
            });

            ytdlp.stderr.on('data', (data) => {
                stderr += data.toString();
                console.error(`yt-dlp stderr: ${data}`);
            });

            ytdlp.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`yt-dlp exited with code ${code}: ${stderr}`));
                }
            });

            ytdlp.on('error', (err) => {
                reject(new Error(`Failed to start yt-dlp: ${err.message}`));
            });
        });

        // Find the downloaded file (might have different extension)
        const files = await fs.readdir(TEMP_DIR);
        const downloadedFile = files.find(f => f.startsWith(videoId));

        if (!downloadedFile) {
            throw new Error('Download completed but file not found');
        }

        const actualPath = path.join(TEMP_DIR, downloadedFile);
        const stats = await fs.stat(actualPath);

        // Rename to .webm if needed
        if (actualPath !== audioPath) {
            await fs.rename(actualPath, audioPath);
        }

        console.log(`Audio downloaded successfully: ${audioPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

        res.json({
            success: true,
            videoId,
            audioPath,
            message: 'Audio downloaded successfully'
        });

    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: `下載失敗: ${error.message}` });
    }
});

// Transcribe audio with OpenAI
app.post('/api/transcribe/openai', async (req, res) => {
    const { videoId, apiKey: userApiKey } = req.body;
    const apiKey = userApiKey || DEFAULT_API_KEYS.openai;

    if (!videoId) {
        return res.status(400).json({ error: 'Missing videoId' });
    }
    if (!apiKey) {
        return res.status(400).json({ error: 'Missing apiKey - no default key configured' });
    }

    try {
        const audioPath = path.join(TEMP_DIR, `${videoId}.webm`);

        if (!await fs.pathExists(audioPath)) {
            return res.status(404).json({ error: '找不到音訊檔案，請重新下載。' });
        }

        // Check file size (OpenAI Whisper limit is 25MB)
        const stats = await fs.stat(audioPath);
        const fileSizeMB = stats.size / (1024 * 1024);
        console.log(`Audio file size: ${fileSizeMB.toFixed(2)} MB`);

        if (fileSizeMB > 25) {
            return res.status(400).json({
                error: `音訊檔案太大 (${fileSizeMB.toFixed(2)} MB)。\n\nOpenAI Whisper API 限制最大 25MB。\n\n建議：\n1. 嘗試使用較短的影片\n2. 改用 AssemblyAI（無大小限制）`
            });
        }

        console.log('Creating OpenAI client...');
        const openai = new OpenAI({
            apiKey,
            timeout: 300000, // 5 minutes timeout
            maxRetries: 3
        });

        console.log('Sending to OpenAI Whisper API...');
        const audioFile = fs.createReadStream(audioPath);

        const transcription = await openai.audio.transcriptions.create({
            file: audioFile,
            model: 'whisper-1',
            response_format: 'verbose_json',
            timestamp_granularities: ['segment']
        });

        console.log('Transcription completed successfully');

        // Process segments with simple speaker detection based on pauses
        const segments = processSegmentsWithSpeakers(transcription.segments);

        res.json({
            success: true,
            transcript: segments,
            language: transcription.language,
            duration: transcription.duration
        });

    } catch (error) {
        console.error('OpenAI transcription error:', error);

        let errorMessage = error.message;

        // Provide more helpful error messages
        if (error.code === 'ECONNRESET' || error.message.includes('Connection error')) {
            errorMessage = `OpenAI API 連線失敗\n\n可能原因：\n1. 網路連線不穩定\n2. 音訊檔案太大導致上傳超時\n3. API Key 無效\n\n建議：\n1. 檢查網路連線\n2. 嘗試較短的影片\n3. 確認 API Key 是否正確`;
        } else if (error.message.includes('Invalid API Key') || error.status === 401) {
            errorMessage = `OpenAI API Key 無效\n\n請確認您的 API Key 是否正確。\n\n取得 API Key：https://platform.openai.com/api-keys`;
        } else if (error.status === 429) {
            errorMessage = `OpenAI API 請求次數超過限制\n\n請稍後再試，或升級您的 OpenAI 方案。`;
        }

        res.status(500).json({ error: errorMessage });
    }
});

// Transcribe with AssemblyAI (supports speaker diarization natively)
app.post('/api/transcribe/assemblyai', async (req, res) => {
    const { videoId, apiKey: userApiKey } = req.body;
    const apiKey = userApiKey || DEFAULT_API_KEYS.assemblyai;

    if (!videoId) {
        return res.status(400).json({ error: 'Missing videoId' });
    }
    if (!apiKey) {
        return res.status(400).json({ error: 'Missing apiKey - no default key configured' });
    }

    try {
        const audioPath = path.join(TEMP_DIR, `${videoId}.webm`);

        if (!await fs.pathExists(audioPath)) {
            return res.status(404).json({ error: 'Audio file not found' });
        }

        // Step 1: Upload audio to AssemblyAI
        console.log('Uploading to AssemblyAI...');
        const uploadResponse = await axios.post(
            'https://api.assemblyai.com/v2/upload',
            fs.createReadStream(audioPath),
            {
                headers: {
                    'authorization': apiKey,
                    'content-type': 'application/octet-stream'
                },
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            }
        );

        const uploadUrl = uploadResponse.data.upload_url;
        console.log('Upload complete, starting transcription...');

        // Step 2: Start transcription with speaker diarization
        const transcriptResponse = await axios.post(
            'https://api.assemblyai.com/v2/transcript',
            {
                audio_url: uploadUrl,
                speaker_labels: true,
                language_code: 'zh'
            },
            {
                headers: {
                    'authorization': apiKey,
                    'content-type': 'application/json'
                }
            }
        );

        const transcriptId = transcriptResponse.data.id;
        console.log(`Transcription started: ${transcriptId}`);

        // Step 3: Poll for completion
        let transcript;
        while (true) {
            const pollResponse = await axios.get(
                `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
                { headers: { 'authorization': apiKey } }
            );

            console.log(`Status: ${pollResponse.data.status}`);

            if (pollResponse.data.status === 'completed') {
                transcript = pollResponse.data;
                break;
            } else if (pollResponse.data.status === 'error') {
                throw new Error(pollResponse.data.error);
            }

            await new Promise(r => setTimeout(r, 3000));
        }

        // Process utterances with speaker labels
        const segments = (transcript.utterances || []).map((utt, idx) => ({
            id: idx + 1,
            speaker: `講者 ${utt.speaker}`,
            start: utt.start / 1000,
            end: utt.end / 1000,
            text: utt.text
        }));

        res.json({
            success: true,
            transcript: segments
        });

    } catch (error) {
        console.error('AssemblyAI error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Transcribe with Gemini
app.post('/api/transcribe/gemini', async (req, res) => {
    const { videoId, apiKey: userApiKey } = req.body;
    const apiKey = userApiKey || DEFAULT_API_KEYS.gemini;

    if (!videoId) {
        return res.status(400).json({ error: 'Missing videoId' });
    }
    if (!apiKey) {
        return res.status(400).json({ error: 'Missing apiKey - no default key configured' });
    }

    try {
        const audioPath = path.join(TEMP_DIR, `${videoId}.webm`);

        if (!await fs.pathExists(audioPath)) {
            return res.status(404).json({ error: 'Audio file not found' });
        }

        // Check file size
        const stats = await fs.stat(audioPath);
        const fileSizeMB = stats.size / (1024 * 1024);
        console.log(`Audio file size: ${fileSizeMB.toFixed(2)} MB`);

        let fileUri;

        // For files > 20MB, use File API
        if (fileSizeMB > 20) {
            console.log('File is large, uploading via Gemini File API...');

            // Step 1: Start resumable upload
            const startUploadResponse = await axios.post(
                `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
                {
                    file: {
                        display_name: `audio_${videoId}`
                    }
                },
                {
                    headers: {
                        'X-Goog-Upload-Protocol': 'resumable',
                        'X-Goog-Upload-Command': 'start',
                        'X-Goog-Upload-Header-Content-Length': stats.size,
                        'X-Goog-Upload-Header-Content-Type': 'audio/webm',
                        'Content-Type': 'application/json'
                    }
                }
            );

            const uploadUrl = startUploadResponse.headers['x-goog-upload-url'];
            console.log('Got upload URL, uploading file...');

            // Step 2: Upload the file
            const audioBuffer = await fs.readFile(audioPath);
            const uploadResponse = await axios.put(
                uploadUrl,
                audioBuffer,
                {
                    headers: {
                        'Content-Length': stats.size,
                        'X-Goog-Upload-Offset': '0',
                        'X-Goog-Upload-Command': 'upload, finalize'
                    },
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity,
                    timeout: 600000 // 10 minutes for upload
                }
            );

            fileUri = uploadResponse.data.file.uri;
            console.log('File uploaded successfully:', fileUri);

            // Step 3: Wait for file processing
            let fileState = 'PROCESSING';
            let attempts = 0;
            const maxAttempts = 60;

            while (fileState === 'PROCESSING' && attempts < maxAttempts) {
                await new Promise(r => setTimeout(r, 5000));

                const statusResponse = await axios.get(
                    `https://generativelanguage.googleapis.com/v1beta/${uploadResponse.data.file.name}?key=${apiKey}`
                );

                fileState = statusResponse.data.state;
                console.log(`File processing status: ${fileState}`);
                attempts++;
            }

            if (fileState !== 'ACTIVE') {
                throw new Error('File processing timeout or failed');
            }

            // Step 4: Generate content using file URI
            console.log('Sending transcription request...');
            const transcriptionResponse = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
                {
                    contents: [{
                        parts: [
                            {
                                file_data: {
                                    mime_type: 'audio/webm',
                                    file_uri: fileUri
                                }
                            },
                            {
                                text: `請將這段音訊轉錄成逐字稿，並識別不同的講者。
請使用以下 JSON 格式回覆：
{
  "segments": [
    {"speaker": "講者 A", "start": 0.0, "end": 5.0, "text": "內容..."}
  ]
}
只回覆 JSON，不要其他文字。`
                            }
                        ]
                    }]
                },
                {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 600000
                }
            );

            const textContent = transcriptionResponse.data.candidates[0].content.parts[0].text;
            const jsonMatch = textContent.match(/\{[\s\S]*\}/);

            if (!jsonMatch) {
                throw new Error('Failed to parse Gemini response');
            }

            const parsed = JSON.parse(jsonMatch[0]);
            const segments = parsed.segments.map((seg, idx) => ({
                id: idx + 1,
                ...seg
            }));

            res.json({
                success: true,
                transcript: segments
            });

        } else {
            // For smaller files, use inline base64
            console.log('File is small, using inline base64...');
            const audioBuffer = await fs.readFile(audioPath);
            const audioBase64 = audioBuffer.toString('base64');

            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
                {
                    contents: [{
                        parts: [
                            {
                                inline_data: {
                                    mime_type: 'audio/webm',
                                    data: audioBase64
                                }
                            },
                            {
                                text: `請將這段音訊轉錄成逐字稿，並識別不同的講者。
請使用以下 JSON 格式回覆：
{
  "segments": [
    {"speaker": "講者 A", "start": 0.0, "end": 5.0, "text": "內容..."}
  ]
}
只回覆 JSON，不要其他文字。`
                            }
                        ]
                    }]
                },
                {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 300000
                }
            );

            const textContent = response.data.candidates[0].content.parts[0].text;
            const jsonMatch = textContent.match(/\{[\s\S]*\}/);

            if (!jsonMatch) {
                throw new Error('Failed to parse Gemini response');
            }

            const parsed = JSON.parse(jsonMatch[0]);
            const segments = parsed.segments.map((seg, idx) => ({
                id: idx + 1,
                ...seg
            }));

            res.json({
                success: true,
                transcript: segments
            });
        }

    } catch (error) {
        console.error('Gemini error:', error);

        let errorMessage = error.message;

        if (error.response?.status === 429 || error.message.includes('429')) {
            errorMessage = `Gemini API 請求次數超過限制 (429)\n\n可能原因：\n1. 免費額度已用完\n2. 短時間內發送太多請求\n\n解決方案：\n1. 等待幾分鐘後再試\n2. 到 Google AI Studio 檢查你的額度\n\n額度查詢：https://aistudio.google.com/`;
        } else if (error.response?.status === 400) {
            errorMessage = `Gemini API 請求格式錯誤\n\n可能是音訊格式不支援，請嘗試其他影片。`;
        } else if (error.response?.status === 403) {
            errorMessage = `Gemini API Key 無效或無權限\n\n請確認您的 API Key 是否正確。\n\n取得 API Key：https://aistudio.google.com/apikey`;
        }

        res.status(500).json({ error: errorMessage });
    }
});

// AI Correction
app.post('/api/correct', async (req, res) => {
    const { transcript, provider, apiKey: userApiKey } = req.body;
    const apiKey = userApiKey || (provider === 'gemini' ? DEFAULT_API_KEYS.gemini : DEFAULT_API_KEYS.openai);

    if (!transcript) {
        return res.status(400).json({ error: 'Missing transcript' });
    }
    if (!apiKey) {
        return res.status(400).json({ error: 'Missing apiKey - no default key configured' });
    }

    try {
        const prompt = `請修正以下逐字稿中的錯誤，包括：
1. 修正明顯的語音辨識錯誤
2. 添加適當的標點符號
3. 修正錯別字
4. 保持原意不變

請保持相同的 JSON 格式回覆：
${JSON.stringify(transcript, null, 2)}

只回覆修正後的 JSON 陣列，不要其他文字。`;

        let correctedTranscript;

        if (provider === 'openai') {
            const openai = new OpenAI({ apiKey });
            const completion = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3
            });

            const response = completion.choices[0].message.content;
            const jsonMatch = response.match(/\[[\s\S]*\]/);
            correctedTranscript = JSON.parse(jsonMatch[0]);

        } else if (provider === 'gemini') {
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
                {
                    contents: [{ parts: [{ text: prompt }] }]
                }
            );

            const textContent = response.data.candidates[0].content.parts[0].text;
            const jsonMatch = textContent.match(/\[[\s\S]*\]/);
            correctedTranscript = JSON.parse(jsonMatch[0]);
        }

        res.json({
            success: true,
            transcript: correctedTranscript
        });

    } catch (error) {
        console.error('Correction error:', error);
        res.status(500).json({ error: error.message });
    }
});

// AI Refine with Custom Prompt
app.post('/api/refine', async (req, res) => {
    const { transcript, prompt, provider, apiKey: userApiKey, context } = req.body;
    const apiKey = userApiKey || (provider === 'gemini' ? DEFAULT_API_KEYS.gemini : DEFAULT_API_KEYS.openai);

    if (!transcript || !prompt) {
        return res.status(400).json({ error: 'Missing transcript or prompt' });
    }
    if (!apiKey) {
        return res.status(400).json({ error: 'Missing apiKey - no default key configured' });
    }

    const startTime = Date.now();
    let model = '';

    try {
        const systemPrompt = `你是一位專業的逐字稿編輯助手。請根據用戶的指示修改以下逐字稿。

${context ? `影片相關背景：${context}\n\n` : ''}用戶指示：${prompt}

逐字稿：
${JSON.stringify(transcript, null, 2)}

請按照相同的 JSON 格式回覆修改後的逐字稿，並在最後附上一個 "changes" 欄位說明你做了哪些修改。
格式：
{
  "transcript": [...修改後的逐字稿...],
  "changes": "1. 修改項目一\n2. 修改項目二..."
}
只回覆 JSON，不要其他文字。`;

        let result;

        if (provider === 'openai') {
            model = 'gpt-4o';
            const openai = new OpenAI({ apiKey });
            const completion = await openai.chat.completions.create({
                model: model,
                messages: [{ role: 'user', content: systemPrompt }],
                temperature: 0.3
            });

            const response = completion.choices[0].message.content;
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            result = JSON.parse(jsonMatch[0]);

        } else if (provider === 'gemini') {
            model = 'gemini-2.0-flash';
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
                {
                    contents: [{ parts: [{ text: systemPrompt }] }]
                }
            );

            const textContent = response.data.candidates[0].content.parts[0].text;
            const jsonMatch = textContent.match(/\{[\s\S]*\}/);
            result = JSON.parse(jsonMatch[0]);
        }

        const duration = Date.now() - startTime;

        // Log the API call
        apiLogger.log({
            provider,
            model,
            action: 'refine',
            duration,
            success: true
        });

        res.json({
            success: true,
            transcript: result.transcript,
            changes: result.changes || '無具體修改說明'
        });

    } catch (error) {
        const duration = Date.now() - startTime;
        apiLogger.log({
            provider,
            model,
            action: 'refine',
            duration,
            success: false,
            error: error.message
        });

        console.error('Refine error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get API Logs
app.get('/api/logs', (req, res) => {
    res.json({
        logs: apiLogger.getLogs(),
        stats: apiLogger.getStats()
    });
});

// ===== Helper Functions =====

function extractVideoId(url) {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/
    ];

    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

// Simple speaker detection based on pauses between segments
function processSegmentsWithSpeakers(segments) {
    if (!segments || segments.length === 0) return [];

    let currentSpeaker = 0;
    const speakerLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

    return segments.map((seg, idx) => {
        // Switch speaker if there's a significant pause (> 2 seconds)
        if (idx > 0) {
            const pause = seg.start - segments[idx - 1].end;
            if (pause > 2) {
                currentSpeaker = (currentSpeaker + 1) % speakerLetters.length;
            }
        }

        return {
            id: idx + 1,
            speaker: `講者 ${speakerLetters[currentSpeaker]}`,
            start: seg.start,
            end: seg.end,
            text: seg.text.trim()
        };
    });
}

// ===== Start Server =====
app.listen(PORT, () => {
    console.log(`
    ╔═══════════════════════════════════════════════════════╗
    ║                                                       ║
    ║   🎬 YouTube Transcriber Pro                          ║
    ║   Server running at http://localhost:${PORT}             ║
    ║                                                       ║
    ║   ✅ 使用 yt-dlp 下載 YouTube 音訊                    ║
    ║                                                       ║
    ╚═══════════════════════════════════════════════════════╝
    `);
});
