# 🎬 YouTube Transcriber Pro

AI 智能 YouTube 逐字稿生成器，支援多種語音辨識服務和講者識別。

![Demo](https://img.shields.io/badge/Status-Beta-blue)
![Node](https://img.shields.io/badge/Node.js-18+-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

## ✨ 功能特色

- 🎯 **多種 AI 服務支援** - OpenAI、Google Gemini、AssemblyAI
- 👥 **講者識別** - 自動識別不同講者
- ✏️ **AI 智能修正** - 自動修正語音辨識錯誤
- 📝 **可編輯逐字稿** - 即時編輯和修改
- 💾 **多格式輸出** - SRT 字幕檔、純文字檔
- 🎨 **現代化 UI** - 深色主題、動態動畫

## 🚀 快速開始

### 前置需求

- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (透過 winget 安裝: `winget install yt-dlp.yt-dlp`)
- API Key (至少一個):
  - [OpenAI API Key](https://platform.openai.com/api-keys)
  - [Google Gemini API Key](https://aistudio.google.com/apikey)
  - [AssemblyAI API Key](https://www.assemblyai.com/dashboard/signup)

### 安裝

```bash
# 複製專案
git clone https://github.com/YOUR_USERNAME/youtube-transcriber-pro.git
cd youtube-transcriber-pro

# 安裝依賴
npm install

# 啟動伺服器
npm start
```

### 使用

1. 開啟瀏覽器訪問 `http://localhost:3000`
2. 點擊 ⚙️ 設定你的 API Key
3. 貼上 YouTube 連結
4. 點擊「開始轉錄」

## 📁 專案結構

```
youtube-transcriber-pro/
├── index.html      # 主頁面
├── styles.css      # 樣式表
├── app.js          # 前端邏輯
├── server.js       # Node.js 後端
├── package.json    # 專案設定
└── temp/           # 暫存音訊檔案
```

## 🔧 技術架構

- **前端**: HTML5, CSS3, Vanilla JavaScript
- **後端**: Node.js, Express
- **下載**: yt-dlp
- **語音辨識**: OpenAI Whisper, Google Gemini, AssemblyAI

## 📝 License

MIT License - 自由使用和修改

## 🙏 致謝

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) - YouTube 下載
- [OpenAI](https://openai.com) - Whisper 語音辨識
- [Google Gemini](https://ai.google.dev) - AI 語音轉文字
- [AssemblyAI](https://www.assemblyai.com) - 語音辨識 API
