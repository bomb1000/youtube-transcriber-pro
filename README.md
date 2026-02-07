# 🎬 YouTube Transcriber Pro

![Website](https://youtube-transcriber-pro-production.up.railway.app/)

A professional-grade YouTube video transcription tool that leverages state-of-the-art AI models to convert video to text with high accuracy. Features speaker diarization, AI-powered refinement, and multi-language support.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)

## ✨ Key Features

- **📺 YouTube Integration**: Seamlessly downloads and processes audio from YouTube links using `yt-dlp`.
- **🤖 Multi-Model Support**:
  - **OpenAI Whisper**: Best for stability and standard SRT generation.
  - **Google Gemini**: Free tier available, supports speaker diarization and long context.
  - **AssemblyAI**: Professional-grade speaker separation and precise timestamping.
- **📝 Smart Editor**:
  - **Speaker Diarization**: Distinct speaker labels with color coding.
  - **Version History**: Track all changes with ability to restore previous versions.
  - **Chinese Conversion**: One-click Traditional ↔ Simplified Chinese conversion.
- **🧠 Advanced AI Refinement**:
  - **Context-Aware Correction**: Fixes typos and terminology using custom prompts.
  - **Web Grounding**: (Gemini only) Uses Google Search to verify proper nouns and technical terms.
  - **Context Overlap**: Smart chunking ensures no context is lost between processing batches for long videos.

## 🚀 Getting Started

### Prerequisites

- Node.js (v18 or higher)
- ffmpeg (installed and added to system PATH)
- API Keys (OpenAI, Google Gemini, or AssemblyAI)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/youtube-transcriber-pro.git
   cd youtube-transcriber-pro
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the application:
   ```bash
   npm start
   ```

4. Open your browser and navigate to:
   `http://localhost:3000`

## 🛠️ Configuration

Configure your API keys in the settings menu (⚙️ icon):

- **OpenAI API Key**: For Whisper and GPT-4o models.
- **Gemini API Key**: For transcription and correction with web search capabilities.
- **AssemblyAI API Key**: For specialized speaker diarization.

## 💡 How It Works

1. **Input**: Paste a YouTube URL.
2. **Download**: The server downloads the audio using `yt-dlp`.
3. **Transcribe**: Audio is sent to the selected AI provider.
4. **Refine**:
   - Use the built-in AI editor to correct mistakes.
   - Enable "Web Search" to let AI fact-check terms.
   - Convert between Traditional/Simplified Chinese if needed.
5. **Export**: Download as `.srt` (subtitles) or `.txt` (transcript).

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
