const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const OpenAI = require('openai');
const axios = require('axios');
const apiLogger = require('./api-logger');
const OpenCC = require('opencc-js');
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
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '20mb' }));
app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
        return res.status(413).json({
            error: '請求內容過大，請縮短逐字稿或提高 JSON_BODY_LIMIT。'
        });
    }
    return next(err);
});
app.use(express.static(path.join(__dirname)));

// Ensure temp directory exists
const TEMP_DIR = path.join(__dirname, 'temp');
fs.ensureDirSync(TEMP_DIR);
const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_BYTES) || 1024 * 1024 * 1024;

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

// ===== Helper Functions =====
async function resolveYtdlpCookiesArgs(options = {}) {
    const cleanup = async () => {};
    const envFromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER || '';
    const envPath = process.env.YTDLP_COOKIES_PATH || process.env.YTDLP_COOKIES || '';
    const envBase64 = process.env.YTDLP_COOKIES_BASE64 || process.env.YTDLP_COOKIES_B64 || '';
    const cookiesFromBrowser = options.cookiesFromBrowser || '';
    const cookiesText = options.cookiesText || '';
    const cookiesBase64 = options.cookiesBase64 || '';

    if (cookiesFromBrowser) {
        return { args: ['--cookies-from-browser', cookiesFromBrowser], cleanup };
    }

    if (cookiesText) {
        const cookiesPath = path.join(TEMP_DIR, `yt-dlp-cookies-${Date.now()}.txt`);
        await fs.outputFile(cookiesPath, cookiesText);
        return { args: ['--cookies', cookiesPath], cleanup: () => fs.remove(cookiesPath).catch(() => {}) };
    }

    if (cookiesBase64) {
        try {
            const decoded = Buffer.from(cookiesBase64, 'base64').toString('utf8');
            if (decoded.trim()) {
                const cookiesPath = path.join(TEMP_DIR, `yt-dlp-cookies-${Date.now()}.txt`);
                await fs.outputFile(cookiesPath, decoded);
                return { args: ['--cookies', cookiesPath], cleanup: () => fs.remove(cookiesPath).catch(() => {}) };
            }
        } catch (error) {
            console.warn('Failed to decode cookiesBase64:', error.message);
        }
    }

    if (envFromBrowser) {
        return { args: ['--cookies-from-browser', envFromBrowser], cleanup };
    }

    if (envBase64) {
        try {
            const decoded = Buffer.from(envBase64, 'base64').toString('utf8');
            if (decoded.trim()) {
                const cookiesPath = path.join(TEMP_DIR, 'yt-dlp-cookies.txt');
                await fs.outputFile(cookiesPath, decoded);
                return { args: ['--cookies', cookiesPath], cleanup };
            }
        } catch (error) {
            console.warn('Failed to decode YTDLP_COOKIES_BASE64:', error.message);
        }
    }

    if (envPath) {
        if (await fs.pathExists(envPath)) {
            return { args: ['--cookies', envPath], cleanup };
        }
        console.warn(`YTDLP_COOKIES_PATH does not exist: ${envPath}`);
    }

    return { args: [], cleanup };
}

async function resolveAudioPath(videoId) {
    const defaultPath = path.join(TEMP_DIR, `${videoId}.webm`);
    if (await fs.pathExists(defaultPath)) {
        return defaultPath;
    }
    const files = await fs.readdir(TEMP_DIR);
    const match = files.find(file => file.startsWith(videoId));
    return match ? path.join(TEMP_DIR, match) : defaultPath;
}

// Clean up common JSON issues from AI responses
function cleanJsonString(str) {
    // Replace Chinese punctuation with English
    str = str.replace(/，/g, ',');
    str = str.replace(/：/g, ':');
    str = str.replace(/"/g, '"');
    str = str.replace(/"/g, '"');
    str = str.replace(/'/g, "'");
    str = str.replace(/'/g, "'");
    str = str.replace(/。/g, '.');

    // Remove trailing commas before } or ]
    str = str.replace(/,\s*}/g, '}');
    str = str.replace(/,\s*]/g, ']');

    // Remove any BOM or special characters
    str = str.replace(/^\uFEFF/, '');

    // Remove markdown code blocks if present
    str = str.replace(/```json\s*/g, '');
    str = str.replace(/```\s*/g, '');

    // Fix unescaped newlines in strings (common issue)
    str = str.replace(/"text"\s*:\s*"([^"]*)"/g, (match, content) => {
        // Escape any unescaped newlines and problematic characters
        const escaped = content
            .replace(/\\/g, '\\\\')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t');
        return `"text": "${escaped}"`;
    });

    return str;
}

// Robust JSON parser with multiple fallback strategies
function parseJsonRobust(str) {
    // Strategy 1: Direct parse after cleaning
    try {
        return JSON.parse(cleanJsonString(str));
    } catch (e) {
        console.log('JSON parse strategy 1 failed, trying fallback...');
    }

    // Strategy 2: Try to extract just the segments array
    try {
        const segmentsMatch = str.match(/"segments"\s*:\s*\[([\s\S]*?)\]/);
        if (segmentsMatch) {
            const segmentsStr = `{"segments": [${segmentsMatch[1]}]}`;
            return JSON.parse(cleanJsonString(segmentsStr));
        }
    } catch (e) {
        console.log('JSON parse strategy 2 failed, trying fallback...');
    }

    // Strategy 3: Manual extraction of speaker/text pairs
    try {
        const segments = [];
        const pattern = /"speaker"\s*:\s*"([^"]+)"[\s\S]*?"text"\s*:\s*"([^"]+)"/g;
        let match;
        let id = 1;
        while ((match = pattern.exec(str)) !== null) {
            segments.push({
                id: id++,
                speaker: match[1],
                start: 0,
                end: 0,
                text: match[2]
            });
        }
        if (segments.length > 0) {
            return { segments };
        }
    } catch (e) {
        console.log('JSON parse strategy 3 failed');
    }

    throw new Error('All JSON parsing strategies failed');
}

// Parse AI refine response with multiple fallback strategies
function parseRefineResponse(text) {
    // Remove markdown code blocks if present
    let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '');

    // Strategy 1: Try to find and parse the JSON object
    try {
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
    } catch (e) {
        console.log('Refine parse strategy 1 failed:', e.message);
    }

    // Strategy 2: Try to fix common JSON issues (trailing commas, unescaped quotes)
    try {
        let fixed = cleaned;
        // Find the main JSON object
        const startIdx = fixed.indexOf('{');
        const endIdx = fixed.lastIndexOf('}');
        if (startIdx !== -1 && endIdx !== -1) {
            fixed = fixed.substring(startIdx, endIdx + 1);
        }

        // Fix trailing commas before ] or }
        fixed = fixed.replace(/,\s*([}\]])/g, '$1');

        // Try to parse
        return JSON.parse(fixed);
    } catch (e) {
        console.log('Refine parse strategy 2 failed:', e.message);
    }

    // Strategy 3: Try to extract transcript array separately
    try {
        const transcriptMatch = cleaned.match(/"transcript"\s*:\s*\[([\s\S]*?)\]([\s\S]*?"changes"[\s\S]*)/);
        if (transcriptMatch) {
            // Try to parse just the transcript array
            let transcriptStr = '[' + transcriptMatch[1] + ']';
            // Fix trailing commas
            transcriptStr = transcriptStr.replace(/,\s*([}\]])/g, '$1');
            const transcript = JSON.parse(transcriptStr);

            // Extract changes
            const changesMatch = transcriptMatch[2].match(/"changes"\s*:\s*"([^"]*)"/);
            const changes = changesMatch ? changesMatch[1] : '修改完成';

            return { transcript, changes };
        }
    } catch (e) {
        console.log('Refine parse strategy 3 failed:', e.message);
    }

    // Strategy 4: Extract individual segments using regex
    try {
        const segments = [];
        const segmentPattern = /\{\s*"id"\s*:\s*(\d+)\s*,\s*"speaker"\s*:\s*"([^"]+)"\s*,\s*"start"\s*:\s*([\d.]+)\s*,\s*"end"\s*:\s*([\d.]+)\s*,\s*"text"\s*:\s*"([^"]+)"\s*\}/g;
        let match;
        while ((match = segmentPattern.exec(cleaned)) !== null) {
            segments.push({
                id: parseInt(match[1]),
                speaker: match[2],
                start: parseFloat(match[3]),
                end: parseFloat(match[4]),
                text: match[5]
            });
        }

        if (segments.length > 0) {
            console.log(`Refine: Extracted ${segments.length} segments using regex`);
            return { transcript: segments, changes: '修改完成（使用備用解析方式）' };
        }
    } catch (e) {
        console.log('Refine parse strategy 4 failed:', e.message);
    }

    throw new Error('無法解析 AI 回應的 JSON 格式。請重試。');
}

// ===== Routes =====

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'YouTube Transcriber Pro API is running' });
});

// Convert Chinese text (s2t or t2s)
app.post('/api/convert', (req, res) => {
    const { text, type } = req.body;

    if (!text || !type) {
        return res.status(400).json({ error: 'Missing text or conversion type' });
    }

    try {
        let converter;
        if (type === 's2t') {
            converter = OpenCC.Converter({ from: 'cn', to: 'tw' });
        } else if (type === 't2s') {
            converter = OpenCC.Converter({ from: 'tw', to: 'cn' });
        } else {
            return res.status(400).json({ error: 'Invalid conversion type. Use "s2t" or "t2s"' });
        }

        const converted = converter(text);
        res.json({ success: true, text: converted });
    } catch (error) {
        console.error('Conversion error:', error);
        res.status(500).json({ error: 'Conversion failed' });
    }
});

// Upload local media file
app.post('/api/upload', express.raw({ type: '*/*', limit: UPLOAD_MAX_BYTES }), async (req, res) => {
    if (!req.body || !req.body.length) {
        return res.status(400).json({ error: 'Missing file upload' });
    }

    try {
        const rawName = req.headers['x-filename'] || 'uploaded-media';
        const originalName = decodeURIComponent(rawName.toString());
        const ext = path.extname(originalName) || '';
        const videoId = `upload_${Date.now()}`;
        const targetPath = path.join(TEMP_DIR, `${videoId}${ext}`);

        await fs.writeFile(targetPath, req.body);

        return res.json({
            success: true,
            videoId,
            title: originalName,
            audioPath: targetPath
        });
    } catch (error) {
        console.error('Upload error:', error);
        return res.status(500).json({ error: 'Upload failed' });
    }
});

// Download audio from YouTube using yt-dlp
app.post('/api/download', async (req, res) => {
    const { url, cookiesText, cookiesBase64, cookiesFromBrowser } = req.body;

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

        const { args: cookiesArgs, cleanup: cookiesCleanup } = await resolveYtdlpCookiesArgs({
            cookiesText,
            cookiesBase64,
            cookiesFromBrowser
        });
        const ytdlpArgs = [
            '-x',                           // Extract audio only
            '--audio-format', 'opus',       // Convert to opus (webm container)
            '--audio-quality', '0',         // Best quality
            '-o', audioPath.replace('.webm', '.%(ext)s'),  // Output path
            '--no-playlist',                // Don't download playlist
            '--no-warnings',                // Suppress warnings
        ];

        if (cookiesArgs.length > 0) {
            ytdlpArgs.push(...cookiesArgs);
        }

        // Add ffmpeg location if available (Windows)
        if (ffmpegPath) {
            ytdlpArgs.push('--ffmpeg-location', ffmpegPath);
        }

        ytdlpArgs.push(url);

        try {
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
        } finally {
            await cookiesCleanup();
        }

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
        let message = error.message || 'Unknown error';
        if (message.includes('Sign in to confirm') || message.includes('cookies')) {
            message += '。請在部署環境設定 YTDLP_COOKIES_PATH、YTDLP_COOKIES_BASE64 或 YTDLP_COOKIES_FROM_BROWSER，或在前端貼上 cookies 內容。';
        }
        res.status(500).json({ error: `下載失敗: ${message}` });
    }
});

// Transcribe audio with OpenAI
app.post('/api/transcribe/openai', async (req, res) => {
    const { videoId, apiKey: userApiKey, model: requestedModel } = req.body;
    const apiKey = userApiKey || DEFAULT_API_KEYS.openai;

    // Support different OpenAI models (diarize is default for speaker separation)
    const validModels = ['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe-diarize'];
    const model = validModels.includes(requestedModel) ? requestedModel : 'gpt-4o-transcribe-diarize';

    if (!videoId) {
        return res.status(400).json({ error: 'Missing videoId' });
    }
    if (!apiKey) {
        return res.status(400).json({ error: 'Missing apiKey - no default key configured' });
    }

    try {
        const audioPath = await resolveAudioPath(videoId);

        if (!await fs.pathExists(audioPath)) {
            return res.status(404).json({ error: '找不到音訊檔案，請重新下載或重新上傳。' });
        }

        // Check file size (OpenAI limit is 25MB)
        const stats = await fs.stat(audioPath);
        const fileSizeMB = stats.size / (1024 * 1024);
        console.log(`Audio file size: ${fileSizeMB.toFixed(2)} MB, using model: ${model}`);

        if (fileSizeMB > 25) {
            return res.status(400).json({
                error: `音訊檔案太大 (${fileSizeMB.toFixed(2)} MB)。\n\nOpenAI API 限制最大 25MB。\n\n建議：\n1. 嘗試使用較短的影片\n2. 改用 AssemblyAI（無大小限制）`
            });
        }

        console.log(`Creating OpenAI client with model: ${model}...`);
        const openai = new OpenAI({
            apiKey,
            timeout: 300000, // 5 minutes timeout
            maxRetries: 3
        });

        console.log('Sending to OpenAI API...');
        const audioFile = fs.createReadStream(audioPath);

        // Different models support different response formats
        const isWhisper = model === 'whisper-1';
        const isDiarize = model === 'gpt-4o-transcribe-diarize';

        let responseFormat = 'json';
        if (isWhisper) {
            responseFormat = 'verbose_json';
        } else if (isDiarize) {
            responseFormat = 'diarized_json';
        }

        const transcriptionOptions = {
            file: audioFile,
            model: model,
            response_format: responseFormat
        };

        // Only whisper-1 supports timestamp_granularities
        if (isWhisper) {
            transcriptionOptions.timestamp_granularities = ['segment'];
        }

        // Diarize model requires chunking_strategy
        if (isDiarize) {
            transcriptionOptions.chunking_strategy = 'auto';
        }

        const transcription = await openai.audio.transcriptions.create(transcriptionOptions);

        console.log(`Transcription completed successfully with ${model}`);
        console.log('Response keys:', Object.keys(transcription));

        // Debug: log the full structure for diarize model
        if (isDiarize) {
            console.log('Diarize response structure:', JSON.stringify(transcription, null, 2).substring(0, 1000));
        }

        let segments;

        if (isDiarize) {
            // Diarize model may return data in different structures
            // Try segments first, then utterances, then words
            const rawSegments = transcription.segments || transcription.utterances || transcription.words || [];

            if (rawSegments.length > 0) {
                segments = rawSegments.map((seg, idx) => ({
                    id: idx + 1,
                    speaker: seg.speaker || seg.speaker_label || `講者 ${String.fromCharCode(65 + (idx % 26))}`,
                    start: seg.start || seg.start_time || 0,
                    end: seg.end || seg.end_time || 0,
                    text: seg.text || seg.transcript || ''
                }));
            } else if (transcription.text) {
                // Fallback: if no segments, create one from the full text
                console.log('Warning: Diarize model did not return segments, using full text');
                segments = [{
                    id: 1,
                    speaker: '講者 A',
                    start: 0,
                    end: 0,
                    text: transcription.text
                }];
            }
        } else if (isWhisper && transcription.segments) {
            // Whisper returns segments with timestamps but no speaker diarization
            // Don't fake speaker separation based on pauses - it's inaccurate
            // Just label all segments as single speaker
            segments = transcription.segments.map((seg, idx) => ({
                id: idx + 1,
                speaker: '講者',
                start: seg.start,
                end: seg.end,
                text: seg.text.trim()
            }));
        } else {
            // GPT-4o models without diarize return just text, we need to create a single segment
            segments = [{
                id: 1,
                speaker: '講者',
                start: 0,
                end: 0,
                text: transcription.text || transcription
            }];
        }

        res.json({
            success: true,
            transcript: segments,
            model: model,
            language: transcription.language || 'detected',
            duration: transcription.duration || 0
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
        const audioPath = await resolveAudioPath(videoId);

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
        // Use 'best' which includes universal-2 for Chinese support
        const transcriptResponse = await axios.post(
            'https://api.assemblyai.com/v2/transcript',
            {
                audio_url: uploadUrl,
                speaker_labels: true,
                speech_models: ['universal-2'],  // Universal-2 supports Chinese
                language_detection: true  // Auto-detect language
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

        // Process with better segmentation for SRT
        // Use words to create smaller segments (better for subtitles)
        const words = transcript.words || [];
        const utterances = transcript.utterances || [];

        let segments = [];

        if (words.length > 0 && utterances.length > 0) {
            // Create segments by combining words into reasonable subtitle lengths
            // Max ~15 words or ~5 seconds per segment
            const MAX_WORDS_PER_SEGMENT = 15;
            const MAX_DURATION_MS = 5000;

            let currentSegment = { words: [], speaker: 'A', start: 0, end: 0 };
            let segmentId = 1;

            // Create a map of word timestamps to speakers from utterances
            const getSpeakerAtTime = (startTime) => {
                for (const utt of utterances) {
                    if (startTime >= utt.start && startTime <= utt.end) {
                        return utt.speaker;
                    }
                }
                return 'A';
            };

            for (const word of words) {
                const speaker = getSpeakerAtTime(word.start);
                const duration = currentSegment.words.length > 0
                    ? word.end - currentSegment.start
                    : 0;

                // Start new segment if: speaker changed, too many words, or too long
                if (currentSegment.words.length > 0 && (
                    speaker !== currentSegment.speaker ||
                    currentSegment.words.length >= MAX_WORDS_PER_SEGMENT ||
                    duration >= MAX_DURATION_MS
                )) {
                    // Save current segment
                    segments.push({
                        id: segmentId++,
                        speaker: `講者 ${currentSegment.speaker}`,
                        start: currentSegment.start / 1000,
                        end: currentSegment.end / 1000,
                        text: currentSegment.words.map(w => w.text).join('')
                    });
                    currentSegment = { words: [], speaker: speaker, start: word.start, end: word.end };
                }

                if (currentSegment.words.length === 0) {
                    currentSegment.start = word.start;
                    currentSegment.speaker = speaker;
                }
                currentSegment.words.push(word);
                currentSegment.end = word.end;
            }

            // Don't forget the last segment
            if (currentSegment.words.length > 0) {
                segments.push({
                    id: segmentId++,
                    speaker: `講者 ${currentSegment.speaker}`,
                    start: currentSegment.start / 1000,
                    end: currentSegment.end / 1000,
                    text: currentSegment.words.map(w => w.text).join('')
                });
            }
        } else {
            // Fallback to utterances if words not available
            segments = utterances.map((utt, idx) => ({
                id: idx + 1,
                speaker: `講者 ${utt.speaker}`,
                start: utt.start / 1000,
                end: utt.end / 1000,
                text: utt.text
            }));
        }

        res.json({
            success: true,
            transcript: segments,
            model: 'universal-2',
            language: transcript.language_code || 'detected',
            duration: (transcript.audio_duration || 0)
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
        const audioPath = await resolveAudioPath(videoId);

        if (!await fs.pathExists(audioPath)) {
            return res.status(404).json({ error: 'Audio file not found' });
        }

        // Check file size
        const stats = await fs.stat(audioPath);
        const fileSizeMB = stats.size / (1024 * 1024);
        console.log(`Audio file size: ${fileSizeMB.toFixed(2)} MB`);

        let fileUri;

        // For files > 10MB, use File API (more stable)
        if (fileSizeMB > 10) {
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
            console.log('Raw Gemini response length:', textContent.length);

            const parsed = parseJsonRobust(textContent);
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
            console.log('Raw Gemini response length:', textContent.length);

            const parsed = parseJsonRobust(textContent);
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

        // If JSON parsing failed, try to provide more context
        if (error.message.includes('JSON')) {
            console.error('JSON parsing error - raw response may have format issues');
        }

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

// AI Refine with Custom Prompt - Chunked Processing + Google Search
app.post('/api/refine', async (req, res) => {
    const { transcript, prompt, provider, apiKey: userApiKey, context, enableWebSearch } = req.body;
    const apiKey = userApiKey || (provider === 'gemini' ? DEFAULT_API_KEYS.gemini : DEFAULT_API_KEYS.openai);

    if (!transcript || !prompt) {
        return res.status(400).json({ error: 'Missing transcript or prompt' });
    }
    if (!apiKey) {
        return res.status(400).json({ error: 'Missing apiKey - no default key configured' });
    }

    const startTime = Date.now();
    let model = '';
    const BATCH_SIZE = 50; // Process 50 segments at a time

    try {
        // Split transcript into batches
        const batches = [];
        for (let i = 0; i < transcript.length; i += BATCH_SIZE) {
            batches.push(transcript.slice(i, i + BATCH_SIZE));
        }

        console.log(`Refine: Processing ${transcript.length} segments in ${batches.length} batch(es)`);

        const allChanges = [];
        const processedTranscript = [];

        // Process each batch
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            const batchStart = batchIndex * BATCH_SIZE;

            console.log(`Processing batch ${batchIndex + 1}/${batches.length} (segments ${batchStart + 1}-${batchStart + batch.length})`);

            // Get context from previous batch (last 5 segments)
            let previousContextStr = '';
            if (batchIndex > 0) {
                const prevBatch = batches[batchIndex - 1];
                const overlapSegments = prevBatch.slice(-5); // Last 5 segments
                previousContextStr = `
上下文銜接（這是上一批次的結尾，僅供參考，請勿修改）：
${JSON.stringify(overlapSegments, null, 2)}
`;
            }

            const batchPrompt = `你是一位專業的逐字稿編輯助手。請根據用戶的指示修改以下逐字稿片段。

${context ? `影片相關背景：${context}\n\n` : ''}用戶指示：${prompt}

這是第 ${batchIndex + 1} 批，共 ${batches.length} 批。段落編號從 ${batchStart + 1} 開始。
${previousContextStr}
逐字稿片段（請修正此部分的內容）：
${JSON.stringify(batch, null, 2)}

請按照相同的 JSON 格式回覆修改後的逐字稿，保持原有的 id、speaker、start、end 欄位不變，只修改 text 欄位。
格式：
{
  "transcript": [...修改後的逐字稿...],
  "changes": "本批修改說明..."
}
只回覆 JSON，不要其他文字。`;

            let batchResult;

            if (provider === 'openai') {
                model = 'gpt-4o';
                const openai = new OpenAI({ apiKey });
                const completion = await openai.chat.completions.create({
                    model: model,
                    messages: [{ role: 'user', content: batchPrompt }],
                    temperature: 0.3,
                    max_tokens: 16000
                });

                const response = completion.choices[0].message.content;
                batchResult = parseRefineResponse(response);

            } else if (provider === 'gemini') {
                model = 'gemini-2.0-flash';

                // Build request body with optional Google Search grounding
                const requestBody = {
                    contents: [{ parts: [{ text: batchPrompt }] }],
                    generationConfig: {
                        temperature: 0.3,
                        maxOutputTokens: 16000
                    }
                };

                // Add Google Search grounding if enabled
                if (enableWebSearch) {
                    requestBody.tools = [{
                        google_search_retrieval: {
                            dynamic_retrieval_config: {
                                mode: "MODE_DYNAMIC",
                                dynamic_threshold: 0.3
                            }
                        }
                    }];
                }

                const response = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
                    requestBody
                );

                const textContent = response.data.candidates[0].content.parts[0].text;
                batchResult = parseRefineResponse(textContent);
            }

            // Collect results
            if (batchResult.transcript && Array.isArray(batchResult.transcript)) {
                processedTranscript.push(...batchResult.transcript);
            } else {
                // If parsing failed, keep original batch
                console.log(`Batch ${batchIndex + 1} parsing failed, keeping original`);
                processedTranscript.push(...batch);
            }

            if (batchResult.changes) {
                allChanges.push(`[批次 ${batchIndex + 1}] ${batchResult.changes}`);
            }
        }

        const duration = Date.now() - startTime;

        // Log the API call
        apiLogger.log({
            provider,
            model,
            action: 'refine',
            duration,
            success: true,
            batches: batches.length
        });

        res.json({
            success: true,
            transcript: processedTranscript,
            changes: allChanges.join('\n\n') || '無具體修改說明',
            batchCount: batches.length,
            webSearchEnabled: !!enableWebSearch
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
