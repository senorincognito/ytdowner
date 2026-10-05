# ytdown

Desktop app (Electron) that downloads the audio (or video) of a video, with start/end trim markers on a timeline. Works with YouTube (embedded player) and any site supported by yt-dlp (direct stream preview, or typed times when the stream cannot be played).

## Setup
1. `npm install`
2. Download `yt-dlp.exe` from https://github.com/yt-dlp/yt-dlp/releases/latest into `bin/`
3. Make sure `ffmpeg` and `node` are on your PATH
4. `npm start` (or run `start.bat`)

## Build (Windows)
```
npm run build        # installer + portable exe -> dist/
npm run build:dir    # unpacked app only (fast, for testing) -> dist/win-unpacked/
```
- Output: `dist/YouTube Audio Trimmer-Setup-<version>.exe` (installer) and `dist/YouTube Audio Trimmer-<version>-portable.exe`.
- Packaged builds store yt-dlp in `%APPDATA%\ytdown\bin` (the app offers to download it on first start); dev runs use `bin/`.
- Builds are unsigned and use the default Electron icon.
