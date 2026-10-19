const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const media = require('./media');
const path = require('path');

const ROOT = __dirname;
// Local/dev runs keep the binary in <project>/bin; packaged builds can't write next to the (read-only)
// app archive, so they use the per-user data folder instead.
const BIN_DIR = app.isPackaged ? path.join(app.getPath('userData'), 'bin') : path.join(ROOT, '..', 'bin');
// yt-dlp publishes one standalone binary per platform (macOS: a universal build for Intel and Apple silicon)
const YTDLP_ASSET = process.platform === 'win32' ? 'yt-dlp.exe'
  : process.platform === 'darwin' ? 'yt-dlp_macos'
  : process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
const YTDLP = path.join(BIN_DIR, YTDLP_ASSET);
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// The YouTube player refuses to play when the page has no real http origin
// (file:// gives "error 153"), so the UI is served from a local http server.
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/local/')) return serveLocal(req, res);
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
    title: 'Video and Audio Trimmer',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  if (process.env.YTDOWN_DEBUG) {
    win.webContents.on('console-message', (_e, _l, msg) => console.log('[renderer]', msg));
  }
  // A file dropped outside our drop handling would make the window navigate to it; never leave the app page.
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${port}/`)) e.preventDefault(); });
  win.loadURL(`http://127.0.0.1:${port}/`);
}

ipcMain.handle('default-folder', () => app.getPath('music'));

ipcMain.handle('choose-folder', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: current });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('open-folder', (_e, folder) => shell.openPath(folder));

// ---- local files: preview streaming, file dialog, probing ----
const MEDIA_EXT = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', '3gp',
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'mka'];
const MEDIA_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
};

// token -> absolute path. Only files the user picked or dropped are ever served to the page.
const localFiles = new Map();

function serveLocal(req, res) {
  const p = localFiles.get(req.url.split('?')[0].slice('/local/'.length));
  if (!p) { res.writeHead(404); res.end(); return; }
  fs.stat(p, (err, st) => {
    if (err || !st.isFile() || st.size === 0) { res.writeHead(404); res.end(); return; }
    const size = st.size;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let s = 0, e = size - 1, status = 200;
    if (m && (m[1] || m[2])) { // <video> seeks with Range requests
      status = 206;
      if (m[1] === '') s = Math.max(0, size - Number(m[2])); // suffix range: last N bytes
      else { s = Number(m[1]); if (m[2] !== '') e = Math.min(e, Number(m[2])); }
      if (s > e) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    }
    const headers = {
      'Content-Type': MEDIA_MIME[path.extname(p).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': e - s + 1,
    };
    if (status === 206) headers['Content-Range'] = `bytes ${s}-${e}/${size}`;
    res.writeHead(status, headers);
    const rs = fs.createReadStream(p, { start: s, end: e });
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
    rs.pipe(res);
  });
}

ipcMain.handle('open-file', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Audio and video', extensions: MEDIA_EXT }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

// Validates a picked/dropped file, probes it and makes it playable in the preview.
ipcMain.handle('prepare-file', async (_e, p) => {
  let st;
  try { st = fs.statSync(p); } catch { return { ok: false, error: 'File not found.' }; }
  if (!st.isFile()) return { ok: false, error: 'That is not a file.' };
  const info = await media.probe(p);
  if (!info.ok) return info;
  const token = crypto.randomUUID();
  localFiles.set(token, p);
  return { ...info, path: p, title: path.basename(p, path.extname(p)), streamUrl: `/local/${token}` };
});


let ytdlpProblem = ''; // why the last version check failed, for the error shown after an install

function ytdlpVersion() {
  return new Promise((resolve) => {
    ytdlpProblem = '';
    if (!fs.existsSync(YTDLP)) return resolve(null);
    let out = '', err = '';
    const c = spawn(YTDLP, ['--version'], { windowsHide: true });
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', (e) => { ytdlpProblem = e.message; resolve(null); });
    c.on('close', (code) => {
      if (code !== 0) ytdlpProblem = err.trim().split('\n').pop() || `exited with code ${code}`;
      resolve(code === 0 ? out.trim() : null);
    });
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

// Resolve any yt-dlp-supported page URL to something the preview can play: a direct progressive stream
// (HLS/DASH can't be played by <video>), plus title / duration / fps. streamUrl is null if none is playable.
const PLAYABLE = '[protocol^=http][protocol!*=m3u8][protocol!*=dash]';
const PLAYABLE_EXT = ['mp4', 'webm', 'm4a', 'mp3', 'ogg', 'opus', 'wav']; // containers Chromium can play
// Prefer playable video (<=720p), then playable audio, then anything (the preview then falls back to "none").
const PREVIEW_FORMAT = [
  ...['mp4', 'webm'].flatMap((x) => [`b${PLAYABLE}[ext=${x}][height<=720]`, `b${PLAYABLE}[ext=${x}]`]),
  ...['m4a', 'mp3', 'webm', 'ogg', 'opus'].map((x) => `ba${PLAYABLE}[ext=${x}]`),
  'b', 'ba', 'best',
].join('/');
const mediaHeaders = new Map(); // host -> request headers the CDN expects (Referer, UA, cookies…)

ipcMain.handle('resolve-media', (_e, url) => new Promise((resolve) => {
  if (!fs.existsSync(YTDLP)) return resolve({ ok: false, error: 'yt-dlp is not installed.' });
  let out = '', err = '';
  const c = spawn(YTDLP, ['--no-playlist', '--no-warnings', '--js-runtimes', 'node', '-j',
    '-f', PREVIEW_FORMAT, url], { windowsHide: true });
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { err += d; });
  c.on('error', (e) => resolve({ ok: false, error: `Could not start yt-dlp: ${e.message}` }));
  c.on('close', (code) => {
    let info;
    try { info = JSON.parse(out); } catch { info = null; }
    if (code !== 0 || !info) {
      return resolve({ ok: false, error: err.split('\n').filter((l) => l.startsWith('ERROR')).pop() || 'yt-dlp could not read this URL.' });
    }
    const proto = info.protocol || '';
    const playable = info.url && /^https?/.test(proto) && !/m3u8|dash/.test(proto) && PLAYABLE_EXT.includes(info.ext);
    if (playable) {
      const h = {};
      for (const k of ['User-Agent', 'Referer', 'Origin', 'Cookie']) if (info.http_headers?.[k]) h[k] = info.http_headers[k];
      try { mediaHeaders.set(new URL(info.url).host, h); } catch { /* ignore */ }
    }
    resolve({
      ok: true,
      title: info.title || '',
      duration: info.duration || 0,
      fps: info.fps || null,
      streamUrl: playable ? info.url : null,
    });
  });
}));

// Frame rate of the video (YouTube's player API doesn't expose it). null if unknown.
const fpsCache = new Map();
ipcMain.handle('video-fps', (_e, id) => new Promise((resolve) => {
  if (fpsCache.has(id)) return resolve(fpsCache.get(id));
  if (!fs.existsSync(YTDLP)) return resolve(null);
  let out = '';
  const c = spawn(YTDLP, ['--no-playlist', '--skip-download', '--js-runtimes', 'node',
    '--print', '%(fps)s', `https://www.youtube.com/watch?v=${id}`], { windowsHide: true });
  c.stdout.on('data', (d) => { out += d; });
  c.on('error', () => resolve(null));
  c.on('close', () => {
    const fps = parseFloat(out.trim());
    const val = fps > 0 && fps <= 240 ? fps : null;
    if (val) fpsCache.set(id, val);
    resolve(val);
  });
}));

ipcMain.handle('ytdlp-install', async (event) => {
  const part = YTDLP + '.part';
  try {
    fs.mkdirSync(BIN_DIR, { recursive: true });
    await fetchToFile(YTDLP_URL, part, (percent) => event.sender.send('ytdlp-install-progress', { percent }));
    if (process.platform !== 'win32') fs.chmodSync(part, 0o755); // downloads are not executable by default
    fs.renameSync(part, YTDLP);
    const version = await ytdlpVersion();
    if (!version) {
      const why = ytdlpProblem;
      fs.rmSync(YTDLP, { force: true }); // don't leave a broken binary behind
      throw new Error(`Downloaded file does not run correctly${why ? ` (${why})` : ''}`);
    }
    return { ok: true, version };
  } catch (e) {
    fs.rmSync(part, { force: true });
    return { ok: false, error: e.message };
  }
});

let activeDownload = null; // { child, cancelled }

ipcMain.handle('cancel-download', () => {
  if (!activeDownload) return false;
  activeDownload.cancelled = true;
  const pid = activeDownload.child?.pid;
  // kill the whole tree: yt-dlp may have an ffmpeg child
  if (pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  return true;
});

// Runs a child process, feeding its stdout lines to onLine. It is registered on the job so it can be cancelled.
function runChild(job, cmd, args, onLine) {
  return new Promise((resolve) => {
    let buf = '', err = '';
    const child = spawn(cmd, args, { windowsHide: true });
    job.child = child;
    child.stdout.on('data', (d) => {
      buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach(onLine);
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-20000); }); // ffmpeg can be chatty
    child.on('error', (e) => resolve({ code: -1, err: `Could not start ${cmd}: ${e.message}` }));
    child.on('close', (code) => { if (buf) onLine(buf); resolve({ code, err }); });
  });
}

const lastError = (text, fallback) =>
  text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('ERROR') || (l && !l.startsWith('['))).pop() || fallback;

// Download flow.
//  - Whole video/audio: yt-dlp downloads + converts straight into the target folder.
//  - Trimmed: ffmpeg seeking over YouTube's HTTP streams stalls for anything but tiny files, so yt-dlp first
//    downloads the full stream(s) into a temp folder (fast, native downloader) and ffmpeg then cuts + encodes
//    the local file, which also gives exact progress.
// A safe Windows file name stem (no extension). Empty means "use the video title".
function sanitizeName(n) {
  let s = String(n ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 150);
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  return s;
}

const sameFile = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const SOURCE_CLASH = 'The output would overwrite the source file – choose a different name or folder.';

// `localPath` set = trim a file from disk: no yt-dlp, just the ffmpeg cut/encode step.
ipcMain.handle('download', async (event, { url, file: localPath, kind, start, end, duration, format, height, copy, folder, name, overwrite }) => {
  if (activeDownload) return { ok: false, error: 'A download is already running.' };
  const local = !!localPath;
  const cleanName = sanitizeName(name);
  const target = cleanName ? path.join(folder, `${cleanName}.${format}`) : null;
  if (local && target && sameFile(target, localPath)) return { ok: false, error: SOURCE_CLASH };
  if (target && !overwrite && fs.existsSync(target)) return { ok: false, exists: true, file: target };
  const job = activeDownload = { child: null, cancelled: false };
  const win = BrowserWindow.fromWebContents(event.sender);
  const send = (msg) => {
    event.sender.send('download-progress', msg);
    if (!win || win.isDestroyed()) return;
    if (msg.stage === 'downloading' && msg.percent != null) win.setProgressBar(Math.min(1, msg.percent / 100));
    else win.setProgressBar(2, { mode: 'indeterminate' });
  };

  const trimmed = start != null || end != null;
  let streams = local ? 0 : kind === 'video' ? 2 : 1; // yt-dlp tells us the real number once it has picked formats
  let stream = 0;
  const steps = () => streams + (trimmed || local ? 1 : 0); // one extra step for the local cut
  const dests = [];
  let file = local ? localPath : '', tmpDir = null, outFile = null;

  try {
    send({ stage: 'preparing' });
    tmpDir = trimmed && !local ? fs.mkdtempSync(path.join(os.tmpdir(), 'ytdown-')) : null;

    // ---- step 1..n: yt-dlp (skipped for local files) ----
    if (!local) {
      const args = [
        // --print implies --quiet, which would hide all progress/stage lines we parse below
        '--no-playlist', '--newline', '--no-quiet', '--progress', '--js-runtimes', 'node',
        '--progress-template', 'download:PROGRESS %(progress._percent_str)s|%(progress.speed)s|%(progress.eta)s',
        '--print', 'after_move:FILE %(filepath)s',
        // trimmed runs land in a temp folder and are renamed by the cut step; otherwise this is the final name
        // (% must be doubled to survive yt-dlp's output template)
        '-o', path.join(tmpDir ?? folder, `${!tmpDir && cleanName ? cleanName.replace(/%/g, '%%') : '%(title)s'}.%(ext)s`),
      ];
      if (overwrite) args.push('--force-overwrites');
      const res = `res:${Number(height) || 4320},ext`; // -S ext prefers mp4/m4a streams so merging is a cheap remux
      if (trimmed) {
        if (kind === 'video') args.push('-f', 'bv*+ba/b', '-S', res, '--merge-output-format', 'mkv'); // mkv holds anything
        else args.push('-f', 'ba/b');
      } else if (kind === 'video') {
        // --remux-video guarantees the chosen container even when the site serves one pre-merged file
        args.push('-f', 'bv*+ba/b', '-S', res, '--merge-output-format', format, '--remux-video', format);
      } else {
        args.push('-x', '--audio-format', format, '--audio-quality', '0');
      }
      args.push(url);

      const onYtdlpLine = (line) => {
        line = line.trim();
        let m;
        if (line.startsWith('PROGRESS')) {
          const [pctStr, speed, eta] = line.slice(8).split('|');
          const pct = parseFloat(pctStr);
          if (isNaN(pct)) return;
          const n = Math.max(stream, 1);
          send({
            stage: 'downloading',
            percent: ((n - 1 + pct / 100) / steps()) * 100,
            step: steps() > 1 ? { n, of: steps() } : null,
            speed: parseFloat(speed) || null,
            eta: steps() === 1 ? (parseFloat(eta) || null) : null,
          });
        } else if (line.startsWith('FILE ')) {
          file = line.slice(5);
        } else if ((m = /Downloading \d+ format\(s\):\s*(\S+)/.exec(line))) {
          streams = m[1].split('+').length;
        } else if (line.startsWith('[download] Destination:')) {
          stream++;
          dests.push(line.slice('[download] Destination:'.length).trim());
        } else if (/^\[(ExtractAudio|Merger|VideoRemuxer|VideoConvertor|Fixup\w*|ffmpeg)\]/.test(line)) {
          send({ stage: 'converting' });
        }
      };
      const dl = await runChild(job, YTDLP, args, onYtdlpLine);
      if (job.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
      if (dl.code !== 0) return { ok: false, error: lastError(dl.err, dl.code === -1 ? dl.err : `yt-dlp exited with ${dl.code}`) };
      if (!trimmed) return { ok: true, file };
      if (!file) return { ok: false, error: 'yt-dlp did not report the downloaded file.' };
    }

    // ---- last step: cut + encode locally ----
    const base = cleanName || path.basename(file, path.extname(file)) + (local ? ' (trimmed)' : '');
    fs.mkdirSync(folder, { recursive: true }); // yt-dlp would create it; here ffmpeg writes the output
    outFile = path.join(folder, `${base}.${format}`);
    if (local && sameFile(outFile, localPath)) { outFile = null; return { ok: false, error: SOURCE_CLASH }; }
    send({ stage: 'converting' });
    const doCut = kind === 'audio' ? media.extractAudio : media.trim; // the output extension picks the format
    const cut = await doCut({
      input: file, output: outFile, start, end, duration, copy: !!copy, height: Number(height) || 0,
      onSpawn: (child) => { job.child = child; },
      onProgress: ({ fraction, eta }) => send({
        stage: 'downloading',
        percent: ((steps() - 1 + fraction) / steps()) * 100,
        step: steps() > 1 ? { n: steps(), of: steps() } : null,
        trim: true,
        eta,
      }),
    });
    if (job.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
    if (!cut.ok) {
      fs.rmSync(outFile, { force: true });
      return { ok: false, error: cut.error };
    }
    return { ok: true, file: outFile };
  } catch (e) {
    if (!e.cancelled) return { ok: false, error: e.message };
    // Cancelled: remove what this run left behind (.part/.ytdl files, per-format intermediates like name.f399.mp4,
    // the temp folder, a half-written output). Never a plain destination: it may be an earlier finished download.
    for (const p of dests) {
      const targets = [p + '.part', p + '.ytdl'];
      if (/\.f\d+\.\w+$/.test(p)) targets.push(p);
      for (const t of targets) { try { fs.rmSync(t, { force: true }); } catch { /* still locked: leave it */ } }
    }
    if (outFile) { try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ } }
    return { ok: false, cancelled: true };
  } finally {
    activeDownload = null;
    if (win && !win.isDestroyed()) win.setProgressBar(-1);
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
});

app.whenReady().then(() => {
  // Some CDNs only serve the stream with the headers yt-dlp reported for it.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    let extra;
    try { extra = mediaHeaders.get(new URL(details.url).host); } catch { /* ignore */ }
    if (extra) Object.assign(details.requestHeaders, extra);
    cb({ requestHeaders: details.requestHeaders });
  });
  createWindow();
});
app.on('window-all-closed', () => app.quit());
