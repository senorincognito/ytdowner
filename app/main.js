const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const YTDLP = fs.existsSync(path.join(ROOT, '..', 'bin', 'yt-dlp.exe'))
  ? path.join(ROOT, '..', 'bin', 'yt-dlp.exe')
  : 'yt-dlp';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// The YouTube player refuses to play when the page has no real http origin
// (file:// gives "error 153"), so the UI is served from a local http server.
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = req.url === '/' ? 'index.html' : path.basename(req.url.split('?')[0]);
      const file = path.join(ROOT, 'ui', name);
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

let win;
async function createWindow() {
  const port = await startServer();
  win = new BrowserWindow({
    width: 980, height: 820, minWidth: 720, minHeight: 640,
    title: 'YouTube Audio Trimmer',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  if (process.env.YTDOWN_DEBUG) {
    win.webContents.on('console-message', (_e, _l, msg) => console.log('[renderer]', msg));
  }
  win.loadURL(`http://127.0.0.1:${port}/`);
}

ipcMain.handle('default-folder', () => app.getPath('music'));

ipcMain.handle('choose-folder', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: current });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('open-folder', (_e, folder) => shell.openPath(folder));

ipcMain.handle('download', (event, { url, start, end, format, folder }) => new Promise((resolve) => {
  const args = [
    '--no-playlist', '--newline', '-x', '--audio-format', format, '--audio-quality', '0',
    '--js-runtimes', 'node',
    '--progress-template', 'download:PROGRESS %(progress._percent_str)s',
    '--print', 'after_move:FILE %(filepath)s',
    '-o', path.join(folder, '%(title)s.%(ext)s'),
  ];
  if (start != null || end != null) {
    const s = start ?? 0;
    args.push('--download-sections', `*${s}-${end ?? 'inf'}`, '--force-keyframes-at-cuts');
  }
  args.push(url);

  const send = (msg) => event.sender.send('download-progress', msg);
  let file = '', errText = '';
  const child = spawn(YTDLP, args, { windowsHide: true });
  const onLine = (line) => {
    line = line.trim();
    if (line.startsWith('PROGRESS')) {
      const pct = parseFloat(line.slice(8));
      if (!isNaN(pct)) send({ stage: 'downloading', percent: pct });
    } else if (line.startsWith('FILE ')) {
      file = line.slice(5);
    } else if (/\[(ExtractAudio|Merger|ffmpeg)\]/.test(line)) {
      send({ stage: 'converting' });
    }
  };
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach(onLine);
  });
  child.stderr.on('data', (d) => { errText += d; });
  child.on('error', (e) => resolve({ ok: false, error: `Could not start yt-dlp: ${e.message}` }));
  child.on('close', (code) => {
    if (buf) onLine(buf);
    if (code === 0) resolve({ ok: true, file });
    else resolve({ ok: false, error: errText.split('\n').filter((l) => l.startsWith('ERROR')).pop() || errText.slice(-500) || `yt-dlp exited with ${code}` });
  });
}));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
