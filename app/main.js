const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
// Local/dev builds keep the binary in <project>/bin.
const BIN_DIR = path.join(ROOT, '..', 'bin');
const YTDLP = path.join(BIN_DIR, 'yt-dlp.exe');
const YTDLP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

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

function ytdlpVersion() {
  return new Promise((resolve) => {
    if (!fs.existsSync(YTDLP)) return resolve(null);
    let out = '';
    const c = spawn(YTDLP, ['--version'], { windowsHide: true });
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', () => resolve(null));
    c.on('close', (code) => resolve(code === 0 ? out.trim() : null));
  });
}

function fetchToFile(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'ytdown' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchToFile(new URL(res.headers.location, url).href, dest, onProgress, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (chunk) => { got += chunk.length; if (total) onProgress(got / total * 100); });
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

ipcMain.handle('ytdlp-status', async () => {
  const version = await ytdlpVersion();
  return { installed: !!version, version, path: YTDLP };
});

// Latest published release tag, e.g. "2026.08.19". Resolves null when offline / rate-limited.
ipcMain.handle('ytdlp-latest', () => new Promise((resolve) => {
  const req = https.get('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest',
    { headers: { 'User-Agent': 'ytdown', Accept: 'application/vnd.github+json' }, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 ? JSON.parse(body).tag_name || null : null); } catch { resolve(null); }
      });
    });
  req.on('error', () => resolve(null));
  req.on('timeout', () => { req.destroy(); resolve(null); });
}));

ipcMain.handle('ytdlp-install',async (event) => {
  const part = YTDLP + '.part';
  try {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    await fetchToFile(YTDLP_URL, part, (percent) => event.sender.send('ytdlp-install-progress', { percent }));
    fs.renameSync(part, YTDLP);
    const version = await ytdlpVersion();
    if (!version) throw new Error('Downloaded file does not run correctly');
    return { ok: true, version };
  } catch (e) {
    fs.rmSync(part, { force: true });
    return { ok: false, error: e.message };
  }
});

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
