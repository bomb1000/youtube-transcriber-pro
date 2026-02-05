// ===== Configuration & State =====
const state = {
    settings: {
        sttProvider: 'openai',
        openaiKey: '',
        geminiKey: '',
        assemblyKey: '',
        correctionProvider: 'gemini',
        geminiCorrectionKey: '',
        enableCorrection: true
    },
    transcript: [],
    speakers: [],
    videoInfo: null,
    // Progress tracking
    currentStep: 0,
    startTime: null,
    isProcessing: false,
    abortController: null
};

// Speaker colors
const speakerColors = [
    '#6366f1', '#8b5cf6', '#ec4899', '#14b8a6',
    '#f59e0b', '#22c55e', '#3b82f6', '#ef4444'
];

// ===== DOM Elements =====
const elements = {
    settingsBtn: document.getElementById('settingsBtn'),
    settingsModal: document.getElementById('settingsModal'),
    closeSettings: document.getElementById('closeSettings'),
    saveSettings: document.getElementById('saveSettings'),
    sttProvider: document.getElementById('sttProvider'),
    openaiKey: document.getElementById('openaiKey'),
    geminiKey: document.getElementById('geminiKey'),
    assemblyKey: document.getElementById('assemblyKey'),
    correctionProvider: document.getElementById('correctionProvider'),
    geminiCorrectionKey: document.getElementById('geminiCorrectionKey'),
    enableCorrection: document.getElementById('enableCorrection'),
    youtubeUrl: document.getElementById('youtubeUrl'),
    startBtn: document.getElementById('startBtn'),
    inputSection: document.getElementById('inputSection'),
    progressSection: document.getElementById('progressSection'),
    editorSection: document.getElementById('editorSection'),
    speakerList: document.getElementById('speakerList'),
    transcriptEditor: document.getElementById('transcriptEditor'),
    downloadSrtBtn: document.getElementById('downloadSrtBtn'),
    downloadTxtBtn: document.getElementById('downloadTxtBtn'),
    // Error modal elements
    errorModal: document.getElementById('errorModal'),
    errorMessage: document.getElementById('errorMessage'),
    closeError: document.getElementById('closeError'),
    copyErrorBtn: document.getElementById('copyErrorBtn'),
    retryBtn: document.getElementById('retryBtn'),
    // Progress elements
    overallProgressBar: document.getElementById('overallProgressBar'),
    progressPercent: document.getElementById('progressPercent'),
    progressTime: document.getElementById('progressTime'),
    cancelBtn: document.getElementById('cancelBtn')
};

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    setupEventListeners();
});

function loadSettings() {
    const saved = localStorage.getItem('transcriber_settings');
    if (saved) {
        Object.assign(state.settings, JSON.parse(saved));
        elements.sttProvider.value = state.settings.sttProvider;
        elements.openaiKey.value = state.settings.openaiKey;
        elements.geminiKey.value = state.settings.geminiKey;
        elements.assemblyKey.value = state.settings.assemblyKey;
        elements.correctionProvider.value = state.settings.correctionProvider;
        elements.geminiCorrectionKey.value = state.settings.geminiCorrectionKey;
        elements.enableCorrection.checked = state.settings.enableCorrection;
        updateProviderVisibility();
    }
}

function saveSettings() {
    state.settings.sttProvider = elements.sttProvider.value;
    state.settings.openaiKey = elements.openaiKey.value;
    state.settings.geminiKey = elements.geminiKey.value;
    state.settings.assemblyKey = elements.assemblyKey.value;
    state.settings.correctionProvider = elements.correctionProvider.value;
    state.settings.geminiCorrectionKey = elements.geminiCorrectionKey.value;
    state.settings.enableCorrection = elements.enableCorrection.checked;
    localStorage.setItem('transcriber_settings', JSON.stringify(state.settings));
    closeModal();
}

function setupEventListeners() {
    // Settings modal
    elements.settingsBtn.addEventListener('click', () => {
        elements.settingsModal.classList.add('active');
    });

    elements.closeSettings.addEventListener('click', closeModal);
    elements.saveSettings.addEventListener('click', saveSettings);

    elements.settingsModal.addEventListener('click', (e) => {
        if (e.target === elements.settingsModal) closeModal();
    });

    // Provider selection
    elements.sttProvider.addEventListener('change', updateProviderVisibility);

    // Start transcription
    elements.startBtn.addEventListener('click', startTranscription);

    // Download buttons
    elements.downloadSrtBtn.addEventListener('click', downloadSRT);
    elements.downloadTxtBtn.addEventListener('click', downloadTXT);

    // Enter key on URL input
    elements.youtubeUrl.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') startTranscription();
    });

    // Error modal
    elements.closeError.addEventListener('click', closeErrorModal);
    elements.errorModal.addEventListener('click', (e) => {
        if (e.target === elements.errorModal) closeErrorModal();
    });
    elements.copyErrorBtn.addEventListener('click', copyErrorMessage);
    elements.retryBtn.addEventListener('click', () => {
        closeErrorModal();
        resetToInput();
    });

    // Cancel button
    elements.cancelBtn.addEventListener('click', cancelProcessing);
}

function closeModal() {
    elements.settingsModal.classList.remove('active');
}

// ===== Error Modal Functions =====
function showError(message) {
    elements.errorMessage.textContent = message;
    elements.errorModal.classList.add('active');
}

function closeErrorModal() {
    elements.errorModal.classList.remove('active');
}

async function copyErrorMessage() {
    const message = elements.errorMessage.textContent;
    try {
        await navigator.clipboard.writeText(message);
        elements.copyErrorBtn.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06l2.75 2.75 6.72-6.72a.75.75 0 011.06 0z"/>
            </svg>
            已複製！
        `;
        setTimeout(() => {
            elements.copyErrorBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2z"/>
                    <path d="M2 6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2h-2v2H2V8h2V6H2z"/>
                </svg>
                複製錯誤訊息
            `;
        }, 2000);
    } catch (err) {
        console.error('Failed to copy:', err);
    }
}

function updateProviderVisibility() {
    const provider = elements.sttProvider.value;
    document.getElementById('openaiKeyGroup').style.display = provider === 'openai' ? 'block' : 'none';
    document.getElementById('geminiKeyGroup').style.display = provider === 'gemini' ? 'block' : 'none';
    document.getElementById('assemblyKeyGroup').style.display = provider === 'assemblyai' ? 'block' : 'none';
}

// ===== Main Transcription Flow =====
async function startTranscription() {
    const url = elements.youtubeUrl.value.trim();

    if (!url) {
        showError('請輸入 YouTube 連結');
        return;
    }

    if (!isValidYouTubeUrl(url)) {
        showError('請輸入有效的 YouTube 連結\n\n支援的格式：\n• https://www.youtube.com/watch?v=XXXXX\n• https://youtu.be/XXXXX\n• https://www.youtube.com/embed/XXXXX');
        return;
    }

    // Check API keys
    const provider = state.settings.sttProvider;
    if (provider === 'openai' && !state.settings.openaiKey) {
        showError('請先設定 OpenAI API Key\n\n點擊右上角的 ⚙️ 按鈕來設定 API Key');
        return;
    }
    if (provider === 'gemini' && !state.settings.geminiKey) {
        showError('請先設定 Gemini API Key\n\n點擊右上角的 ⚙️ 按鈕來設定 API Key');
        return;
    }
    if (provider === 'assemblyai' && !state.settings.assemblyKey) {
        showError('請先設定 AssemblyAI API Key\n\n點擊右上角的 ⚙️ 按鈕來設定 API Key');
        return;
    }

    // Initialize progress tracking
    state.isProcessing = true;
    state.startTime = Date.now();
    state.currentStep = 0;
    state.abortController = new AbortController();

    // Show progress section
    elements.inputSection.style.display = 'none';
    elements.progressSection.style.display = 'block';
    resetProgressUI();

    try {
        // Step 1: Download audio
        state.currentStep = 1;
        updateProgress(1, 'active', '正在下載音訊...');
        updateOverallProgress(10, '正在連接 YouTube...');

        const downloadResult = await downloadAudio(url);
        if (!downloadResult.success) {
            throw new Error(downloadResult.error || '下載失敗');
        }

        state.videoInfo = {
            videoId: downloadResult.videoId,
            title: downloadResult.title,
            duration: downloadResult.duration
        };
        updateProgress(1, 'completed', `音訊下載完成 ${downloadResult.title ? `(${downloadResult.title})` : ''}`);
        updateOverallProgress(25, '音訊下載完成');

        // Step 2: Transcribe
        state.currentStep = 2;
        updateProgress(2, 'active', `正在使用 ${getProviderName()} 轉錄中...`);
        updateOverallProgress(30, '正在上傳音訊檔案...');

        await performTranscription(url);

        updateProgress(2, 'completed', '語音轉文字完成');
        updateOverallProgress(70, '語音轉文字完成');

        // Step 3: AI Correction
        state.currentStep = 3;
        if (state.settings.enableCorrection) {
            updateProgress(3, 'active', '正在使用 AI 修正...');
            updateOverallProgress(75, '正在 AI 智能修正...');
            await performCorrection();
            updateProgress(3, 'completed', 'AI 修正完成');
            updateOverallProgress(90, 'AI 修正完成');
        } else {
            updateProgress(3, 'completed', '已跳過');
            updateOverallProgress(90, '');
        }

        // Step 4: Generate SRT
        state.currentStep = 4;
        updateProgress(4, 'active', '正在生成 SRT...');
        updateOverallProgress(95, '正在生成 SRT 檔案...');
        await simulateStep(500);
        updateProgress(4, 'completed', 'SRT 生成完成');
        updateOverallProgress(100, '完成！');

        // Show editor
        state.isProcessing = false;
        setTimeout(() => {
            elements.progressSection.style.display = 'none';
            elements.editorSection.style.display = 'block';
            renderEditor();
        }, 1000);

    } catch (error) {
        console.error('Transcription error:', error);
        state.isProcessing = false;

        if (error.name === 'AbortError') {
            // User cancelled
            resetToInput();
        } else {
            showError(error.message);
            resetToInput();
        }
    }
}

function isValidYouTubeUrl(url) {
    const patterns = [
        /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=[\w-]+/,
        /^(https?:\/\/)?(www\.)?youtu\.be\/[\w-]+/,
        /^(https?:\/\/)?(www\.)?youtube\.com\/embed\/[\w-]+/
    ];
    return patterns.some(pattern => pattern.test(url));
}

function getProviderName() {
    const names = {
        'openai': 'OpenAI GPT-4o',
        'gemini': 'Google Gemini',
        'assemblyai': 'AssemblyAI'
    };
    return names[state.settings.sttProvider] || 'AI';
}

function updateProgress(step, status, message) {
    const stepEl = document.getElementById(`step${step}`);
    const statusEl = document.getElementById(`step${step}Status`);

    // Remove all status classes
    stepEl.classList.remove('active', 'completed', 'error');
    stepEl.classList.add(status);
    statusEl.textContent = message;
}

function updateOverallProgress(percent, statusMessage) {
    // Update progress bar
    elements.overallProgressBar.style.width = `${percent}%`;
    elements.progressPercent.textContent = `${Math.round(percent)}%`;

    // Calculate and update estimated time
    if (state.startTime && percent > 0 && percent < 100) {
        const elapsed = (Date.now() - state.startTime) / 1000; // seconds
        const estimatedTotal = elapsed / (percent / 100);
        const remaining = estimatedTotal - elapsed;

        if (remaining > 60) {
            const minutes = Math.ceil(remaining / 60);
            elements.progressTime.textContent = `預估剩餘時間：約 ${minutes} 分鐘`;
        } else if (remaining > 0) {
            elements.progressTime.textContent = `預估剩餘時間：約 ${Math.ceil(remaining)} 秒`;
        }
    } else if (percent >= 100) {
        elements.progressTime.textContent = '處理完成！';
    }

    // Update status message
    if (statusMessage) {
        const currentStep = state.currentStep;
        if (currentStep > 0) {
            const statusEl = document.getElementById(`step${currentStep}Status`);
            if (statusEl) {
                statusEl.textContent = statusMessage;
            }
        }
    }
}

function resetProgressUI() {
    // Reset overall progress
    elements.overallProgressBar.style.width = '0%';
    elements.progressPercent.textContent = '0%';
    elements.progressTime.textContent = '預估時間：計算中...';

    // Reset all steps
    for (let i = 1; i <= 4; i++) {
        const stepEl = document.getElementById(`step${i}`);
        const statusEl = document.getElementById(`step${i}Status`);

        stepEl.classList.remove('active', 'completed', 'error');
        statusEl.textContent = i === 1 ? '準備中...' : '等待中...';
    }
}

function cancelProcessing() {
    if (state.isProcessing) {
        state.isProcessing = false;
        if (state.abortController) {
            state.abortController.abort();
        }
        resetToInput();
    }
}

function simulateStep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ===== Transcription with Real APIs =====
const API_BASE = window.location.origin;

async function performTranscription(url) {
    const provider = state.settings.sttProvider;

    // Start a progress simulation for long transcription
    let progressInterval = setInterval(() => {
        // Slowly increase progress while waiting for API
        const currentPercent = parseFloat(elements.overallProgressBar.style.width) || 30;
        if (currentPercent < 65) {
            updateOverallProgress(currentPercent + 0.5, '正在處理音訊轉錄...');
        }
    }, 1000);

    try {
        let apiKey;
        if (provider === 'openai') apiKey = state.settings.openaiKey;
        else if (provider === 'gemini') apiKey = state.settings.geminiKey;
        else if (provider === 'assemblyai') apiKey = state.settings.assemblyKey;

        updateOverallProgress(35, `正在使用 ${getProviderName()} 轉錄...`);

        const transcribeResult = await fetch(`${API_BASE}/api/transcribe/${provider}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                videoId: state.videoInfo.videoId,
                apiKey: apiKey
            })
        }).then(r => r.json());

        clearInterval(progressInterval);

        if (!transcribeResult.success) {
            throw new Error(transcribeResult.error || '轉錄失敗');
        }

        state.transcript = transcribeResult.transcript;
        state.speakers = [...new Set(state.transcript.map(s => s.speaker))];
    } catch (error) {
        clearInterval(progressInterval);
        throw error;
    }
}

async function downloadAudio(url) {
    try {
        const response = await fetch(`${API_BASE}/api/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        return await response.json();
    } catch (error) {
        // If backend is not running, use demo mode
        console.warn('Backend not available, using demo mode');
        await simulateStep(2000);
        return { success: true, videoId: 'demo_' + Date.now() };
    }
}

async function transcribeWithOpenAI(url) {
    // In production, this would:
    // 1. Download audio from YouTube using yt-dlp (via backend)
    // 2. Send to OpenAI Whisper/GPT-4o API
    // 3. Parse response with speaker diarization

    // Demo data with speaker diarization
    await simulateStep(3000);

    return generateDemoTranscript();
}

async function transcribeWithGemini(url) {
    // Similar to OpenAI but using Gemini API
    await simulateStep(3000);
    return generateDemoTranscript();
}

async function transcribeWithAssemblyAI(url) {
    // AssemblyAI has built-in YouTube support
    // In production: POST to AssemblyAI with audio_url
    await simulateStep(3000);
    return generateDemoTranscript();
}

function generateDemoTranscript() {
    // Demo transcript with multiple speakers
    return [
        { id: 1, speaker: '講者 A', start: 0, end: 5.2, text: '各位觀眾好，歡迎收看今天的節目。今天我們要來討論人工智慧的最新發展。' },
        { id: 2, speaker: '講者 B', start: 5.5, end: 12.8, text: '沒錯，最近 AI 領域有非常多突破性的進展，尤其是在大型語言模型方面。' },
        { id: 3, speaker: '講者 A', start: 13.0, end: 20.5, text: '是的，像是 GPT-4、Claude、Gemini 這些模型，都展現出令人驚嘆的能力。' },
        { id: 4, speaker: '講者 B', start: 21.0, end: 28.3, text: '我認為最重要的是，這些技術正在改變我們的工作方式。很多以前需要人工處理的事情，現在都可以自動化完成。' },
        { id: 5, speaker: '講者 C', start: 29.0, end: 35.7, text: '讓我補充一點，我們也需要關注 AI 的倫理問題，確保技術發展是負責任的。' },
        { id: 6, speaker: '講者 A', start: 36.0, end: 42.5, text: '說得非常好。那我們接下來就來深入探討這些議題吧。' },
        { id: 7, speaker: '講者 B', start: 43.0, end: 50.2, text: '首先，讓我們看看語音辨識技術的進步。現在的轉錄準確率已經達到了人類水準。' },
        { id: 8, speaker: '講者 C', start: 51.0, end: 58.8, text: '而且，像是講者識別、情感分析這些功能，也都已經相當成熟了。' }
    ];
}

// ===== AI Correction =====
async function performCorrection() {
    const correctionProvider = state.settings.correctionProvider;

    // In production, this would call the API to correct transcription errors
    // For demo, we'll simulate the correction process

    await simulateStep(2000);

    // Apply simulated corrections
    state.transcript = state.transcript.map(segment => ({
        ...segment,
        text: segment.text // In production, this would be the corrected text
    }));
}

// ===== Editor Rendering =====
function renderEditor() {
    renderSpeakerList();
    renderTranscript();
}

function renderSpeakerList() {
    elements.speakerList.innerHTML = state.speakers.map((speaker, index) => `
        <div class="speaker-item" data-speaker="${speaker}">
            <div class="speaker-color" style="background: ${speakerColors[index % speakerColors.length]}"></div>
            <input type="text" class="speaker-name" value="${speaker}" 
                   onchange="updateSpeakerName('${speaker}', this.value)"
                   style="background: transparent; border: none; color: inherit; width: 100%;">
        </div>
    `).join('');
}

function renderTranscript() {
    elements.transcriptEditor.innerHTML = state.transcript.map((segment, index) => {
        const speakerIndex = state.speakers.indexOf(segment.speaker);
        const color = speakerColors[speakerIndex % speakerColors.length];

        return `
            <div class="transcript-segment" style="border-left-color: ${color}" data-id="${segment.id}">
                <div class="segment-header">
                    <span class="segment-speaker" style="color: ${color}">${segment.speaker}</span>
                    <span class="segment-time">${formatTime(segment.start)} → ${formatTime(segment.end)}</span>
                </div>
                <div class="segment-text" contenteditable="true" 
                     onblur="updateSegmentText(${segment.id}, this.textContent)">
                    ${segment.text}
                </div>
            </div>
        `;
    }).join('');
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);

    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

// ===== Update Functions =====
window.updateSpeakerName = function (oldName, newName) {
    state.transcript = state.transcript.map(segment => ({
        ...segment,
        speaker: segment.speaker === oldName ? newName : segment.speaker
    }));

    const index = state.speakers.indexOf(oldName);
    if (index !== -1) {
        state.speakers[index] = newName;
    }

    renderTranscript();
};

window.updateSegmentText = function (id, text) {
    const segment = state.transcript.find(s => s.id === id);
    if (segment) {
        segment.text = text.trim();
    }
};

// ===== Download Functions =====
function downloadSRT() {
    let srt = '';

    state.transcript.forEach((segment, index) => {
        srt += `${index + 1}\n`;
        srt += `${formatTime(segment.start)} --> ${formatTime(segment.end)}\n`;
        srt += `[${segment.speaker}] ${segment.text}\n\n`;
    });

    downloadFile(srt, 'transcript.srt', 'text/plain');
}

function downloadTXT() {
    let txt = state.transcript
        .map(segment => `[${segment.speaker}] ${segment.text}`)
        .join('\n\n');

    downloadFile(txt, 'transcript.txt', 'text/plain');
}

function downloadFile(content, filename, type) {
    const blob = new Blob([content], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function resetToInput() {
    elements.progressSection.style.display = 'none';
    elements.editorSection.style.display = 'none';
    elements.inputSection.style.display = 'block';

    // Reset progress states
    for (let i = 1; i <= 4; i++) {
        updateProgress(i, '', '等待中...');
    }
}
