const $ = (id) => document.getElementById(id);

let pl = null; // active preview adapter: yt | html5 | noPreview
let duration = 0;
let start = 0;
let end = 0;
let currentUrl = null;
let currentFile = null; // set instead of currentUrl when trimming a local file
let playingSelection = false;
let downloading = false;
let loadToken = 0;
let fps = 30;
let cursor = null; // last frame-step target; the player's current time can lag right after a seek

// ---------- time helpers ----------
function fmt(sec, digits = 1) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec - h * 3600 - m * 60;
  const ss = s.toFixed(digits).padStart(digits + 3, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function parseTime(text) {
  const parts = text.trim().split(':');
  if (!text.trim() || parts.length > 3 || parts.some((p) => p.trim() === '' || isNaN(Number(p)))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

function videoId(url) {
  const m = url.trim().match(
    /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i);
  return m ? m[1] : null;
}

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = cls;
}

// ---------- preview adapters ----------
// Every adapter offers: play(), pause(), seek(t), seekPaused(t), time(), playing().
// yt and html5 also have load(src) -> Promise<{ duration }>.

// Used when a video can be downloaded but not played in the app: the timeline still works.
const noPreview = { play() {}, pause() {}, seek() {}, seekPaused() {}, time: () => 0, playing: () => false };

// Plain HTML5 <video> for direct stream URLs resolved by yt-dlp (any supported site).
const html5 = {
  el: $('video'),
  load(src) {
    const v = this.el;
    return new Promise((resolve, reject) => {
      const done = (fn, arg) => { clearTimeout(timer); v.onloadedmetadata = v.onerror = null; fn(arg); };
      const timer = setTimeout(() => done(reject, new Error('The stream took too long to load.')), 20000);
      v.onloadedmetadata = () => (isFinite(v.duration) && v.duration > 0
        ? done(resolve, { duration: v.duration, audioOnly: v.videoWidth === 0 })
        : done(reject, new Error('The stream has no known duration.')));
      v.onerror = () => done(reject, new Error('This stream cannot be played in the preview.'));
      v.src = src;
      v.load();
    });
  },
  unload() { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); },
  play() { this.el.play().catch(() => {}); },
  pause() { this.el.pause(); },
  seek(t) { this.el.currentTime = t; },
  seekPaused(t) { this.el.pause(); this.el.currentTime = t; },
  time() { return this.el.currentTime; },
  playing() { return !this.el.paused && !this.el.ended; },
};
$('video').addEventListener('click', () => { playingSelection = false; cursor = null; html5.playing() ? html5.pause() : html5.play(); });

// YouTube's embedded player (official IFrame API).
const apiReady = new Promise((resolve) => { window.onYouTubeIframeAPIReady = resolve; });
const tag = document.createElement('script');
tag.src = 'https://www.youtube.com/iframe_api';
document.head.appendChild(tag);

const YT_ERRORS = { 2: 'Invalid video ID.', 5: 'Player error.', 100: 'Video not found or private.',
  101: 'The owner disabled embedding for this video.', 150: 'The owner disabled embedding for this video.',
  153: 'Embedding blocked (player configuration error).' };
const EMBED_BLOCKED = [101, 150, 153];

const yt = {
  player: null, ready: false, videoId: null, waiter: null, poll: 0, pauseOnPlay: false,

  async load(id) {
    await apiReady;
    return new Promise((resolve, reject) => {
      this.videoId = id;
      this.waiter = { resolve, reject };
      this.pauseOnPlay = false;
      if (!this.player) this.create(id);
      // cue (not load) so nothing autoplays; works for the same id too. Before onReady the player has no
      // methods yet - onReady picks up this.videoId instead.
      else if (this.ready) { this.player.cueVideoById(id); this.waitDuration(); }
    });
  },

  create(id) {
    this.player = new YT.Player('player', {
      videoId: id,
      width: '100%', height: '100%',
      // disablekb: turn off YouTube's own keyboard shortcuts (they clash with the app's arrow keys)
      playerVars: { rel: 0, playsinline: 1, disablekb: 1, origin: location.origin },
      events: {
        onReady: () => {
          this.ready = true;
          if (this.player.getVideoData?.()?.video_id !== this.videoId) this.player.cueVideoById(this.videoId);
          this.waitDuration();
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING && this.pauseOnPlay) { // finish a frame step on a never-started player
            this.pauseOnPlay = false; this.player.pauseVideo(); if (cursor !== null) this.player.seekTo(cursor, true);
          }
        },
        onError: (e) => {
          const msg = YT_ERRORS[e.data] || `Player error ${e.data}`;
          if (this.waiter) this.fail(Object.assign(new Error(msg), { code: e.data }));
          else setStatus(msg, 'error');
        },
      },
    });
  },

  waitDuration() {
    const mine = ++this.poll; // a newer load cancels older polls
    const began = Date.now();
    const tick = () => {
      if (mine !== this.poll || !this.waiter) return;
      const p = this.player;
      const d = p.getDuration?.();
      if (d > 0 && p.getVideoData?.()?.video_id === this.videoId) {
        const w = this.waiter; this.waiter = null; w.resolve({ duration: d });
      } else if (Date.now() - began > 20000) this.fail(new Error('Could not load the video (timed out).'));
      else setTimeout(tick, 200);
    };
    tick();
  },

  fail(err) { this.poll++; const w = this.waiter; this.waiter = null; w?.reject(err); },

  play() { this.ready && this.player.playVideo(); },
  pause() { this.ready && this.player.pauseVideo(); },
  seek(t) { this.ready && this.player.seekTo(t, true); },
  seekPaused(t) {
    this.pause();
    this.seek(t);
    // A never-started (-1) or cued (5) player ignores seeks until it has played once.
    const st = this.player.getPlayerState();
    if (st === YT.PlayerState.UNSTARTED || st === YT.PlayerState.CUED) { this.pauseOnPlay = true; this.player.playVideo(); }
  },
  time() { return this.ready ? this.player.getCurrentTime() : 0; },
  playing() { return this.ready && this.player.getPlayerState() === YT.PlayerState.PLAYING; },
  title() { return (this.ready && this.player.getVideoData?.()?.title) || ''; },
};

// Clicking the YouTube player gives the cross-origin iframe keyboard focus, so the page would never see
// the arrow keys. Hand focus straight back to the page.
window.addEventListener('blur', () => setTimeout(() => {
  if (document.activeElement && document.activeElement.tagName === 'IFRAME') document.activeElement.blur();
}, 0));

function setMode(mode, msg = '') {
  $('player-wrap').dataset.mode = mode;
  $('player-msg').textContent = msg;
  $('trim').classList.toggle('nopreview', mode === 'none');
  if (mode !== 'yt') yt.pause();
  if (mode !== 'html5' && html5.el.getAttribute('src')) html5.unload();
  pl = { yt, html5, none: noPreview }[mode];
}

// ---------- loading ----------
function setFps(f) {
  fps = f || 30;
  $('fps').textContent = f ? `${+f.toFixed(2)} fps` : '30 fps (assumed)';
}

// Common end of every successful load (online video or local file).
function showLoaded(len, title, defaultName) {
  duration = len;
  start = 0;
  end = len;
  $('total').textContent = fmt(len);
  $('trim').classList.remove('disabled');
  $('download').disabled = downloading;
  setStatus(title ? `Ready – ${title}` : 'Ready – set your start and end markers');
  setDefaultName(defaultName);
  render();
}

// Audio-only files have no video to export.
function setKindCaps(hasVideo) {
  $('kind').querySelector('option[value="video"]').disabled = !hasVideo;
  if (!hasVideo && $('kind').value === 'video') { $('kind').value = 'audio'; applyKind(); }
  updateActionLabel();
}

async function loadLocalFile(p) {
  const token = ++loadToken;
  const stale = () => token !== loadToken;
  currentUrl = null;
  currentFile = p;
  $('url').value = p;
  setDefaultName('');
  duration = 0;
  playingSelection = false;
  cursor = null;
  $('trim').classList.add('disabled');
  $('download').disabled = true;
  $('player-wrap').classList.add('loaded');
  setStatus('Reading file…');
  updateActionLabel();

  try {
    const meta = await api.prepareFile(p);
    if (stale()) return;
    if (!meta.ok) throw new Error(meta.error);
    setKindCaps(meta.hasVideo);

    let info = null;
    setMode('html5');
    try {
      info = await html5.load(meta.streamUrl);
      if (!meta.hasVideo) $('player-msg').textContent = 'Audio only';
    } catch { if (stale()) return; }
    if (!info) { // the browser engine can't play this codec/container; trimming still works
      if (!(meta.duration > 0)) throw new Error('Could not determine the length of this file.');
      setMode('none', 'No preview available for this file – type the start and end times below.');
      info = { duration: meta.duration };
    }
    if (stale()) return;

    showLoaded(info.duration, meta.title, `${meta.title} (trimmed)`);
    setFps(meta.fps);
  } catch (e) {
    if (!stale()) setStatus(e.message, 'error');
  }
}

async function loadVideo(url) {
  const token = ++loadToken;
  const stale = () => token !== loadToken;
  currentUrl = url;
  currentFile = null;
  setKindCaps(true);
  setDefaultName('');
  duration = 0;
  playingSelection = false;
  cursor = null;
  $('trim').classList.add('disabled');
  $('download').disabled = true;
  $('player-wrap').classList.add('loaded');
  setStatus('Loading video…');

  const ytId = videoId(url);
  let info = null;
  let meta = {};
  try {
    if (ytId) {
      setMode('yt');
      try { info = await yt.load(ytId); } catch (e) {
        if (stale()) return;
        if (!EMBED_BLOCKED.includes(e.code)) throw e;
        if (!ytdlpInstalled) throw new Error(`${e.message} Install yt-dlp to preview such videos.`);
        setStatus('Embedding is blocked – trying a direct stream…');
      }
    }
    if (stale()) return;

    if (!info) { // non-YouTube site, or a YouTube video that can't be embedded
      if (!ytdlpInstalled) { showModal(INSTALL_TEXT); throw new Error('yt-dlp is required for this site.'); }
      setStatus('Resolving video…');
      meta = await api.resolveMedia(url);
      if (stale()) return;
      if (!meta.ok) throw new Error(meta.error);
      if (meta.streamUrl) {
        setMode('html5');
        try {
          info = await html5.load(meta.streamUrl);
          if (info.audioOnly) $('player-msg').textContent = 'Audio only';
        } catch { if (stale()) return; }
      }
      if (!info) {
        if (!(meta.duration > 0)) throw new Error('Could not determine the length of this video.');
        setMode('none', 'No preview available for this video – type the start and end times below.');
        info = { duration: meta.duration };
      }
    }
    if (stale()) return;

    const title = meta.title || (ytId && !meta.ok ? yt.title() : '');
    showLoaded(info.duration, title, title);

    if (ytId && !meta.ok) { // YouTube embed: the player API has no fps, ask yt-dlp in the background
      setFps(null);
      api.videoFps(ytId).then((f) => { if (f && !stale()) setFps(f); });
    } else setFps(meta.fps);
  } catch (e) {
    if (!stale()) setStatus(e.message, 'error');
  }
}

function stepFrame(dir) {
  if (!pl || !duration) return;
  playingSelection = false;
  const t = cursor ?? pl.time();
  const last = Math.max(0, Math.ceil(duration * fps) - 1);
  const frame = Math.min(last, Math.max(0, Math.floor(t * fps + 1e-3) + dir));
  cursor = (frame + 0.25) / fps; // aim inside the frame so float error can't land on a neighbour
  pl.seekPaused(cursor);
}
$('prev-frame').onclick = () => stepFrame(-1);
$('next-frame').onclick = () => stepFrame(1);
window.addEventListener('keydown', (e) => {
  if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (!$('modal').hidden || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  e.preventDefault();
  stepFrame(e.key === 'ArrowLeft' ? -1 : 1);
});

// ---------- timeline ----------
const track = $('track');
const pct = (t) => (duration ? (t / duration) * 100 : 0);

function render() {
  $('h-start').style.left = pct(start) + '%';
  $('h-end').style.left = pct(end) + '%';
  $('range').style.left = pct(start) + '%';
  $('range').style.width = pct(end - start) + '%';
  if (document.activeElement !== $('t-start')) $('t-start').value = fmt(start);
  if (document.activeElement !== $('t-end')) $('t-end').value = fmt(end);
  $('sel-len').textContent = `Selection: ${fmt(end - start)}`;
}

function timeFromEvent(e) {
  const r = track.getBoundingClientRect();
  return Math.min(duration, Math.max(0, ((e.clientX - r.left) / r.width) * duration));
}

function seek(t) { cursor = null; if (pl && duration) pl.seek(t); }

function dragHandle(el, which) {
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag');
    playingSelection = false;
    if (pl.playing()) pl.pause();
    let last = 0;
    const move = (ev) => {
      let t = timeFromEvent(ev);
      if (which === 'start') start = Math.min(t, end - 0.1); else end = Math.max(t, start + 0.1);
      start = Math.max(0, start); end = Math.min(duration, end);
      render();
      const now = performance.now();
      if (now - last > 120) { last = now; seek(which === 'start' ? start : Math.max(start, end - 0.5)); }
    };
    const up = () => {
      el.classList.remove('drag');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      seek(which === 'start' ? start : Math.max(start, end - 0.5)); // final position
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });
}
dragHandle($('h-start'), 'start');
dragHandle($('h-end'), 'end');

track.addEventListener('pointerdown', (e) => {
  if (!duration) return;
  playingSelection = false;
  seek(timeFromEvent(e));
});

function commitTimeInput(input, which) {
  const t = parseTime(input.value);
  if (t != null) {
    if (which === 'start') start = Math.min(Math.max(0, t), end - 0.1);
    else end = Math.max(Math.min(duration, t), start + 0.1);
    seek(which === 'start' ? start : Math.max(start, end - 0.5));
  }
  input.value = '';
  render();
}
for (const [id, which] of [['t-start', 'start'], ['t-end', 'end']]) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $(id).addEventListener('blur', (e) => commitTimeInput(e.target, which));
}

$('set-start').onclick = () => { start = Math.min(pl.time(), end - 0.1); render(); };
$('set-end').onclick = () => { end = Math.max(pl.time(), start + 0.1); render(); };

// ---------- playback controls ----------
$('play-toggle').onclick = () => {
  playingSelection = false; cursor = null;
  pl.playing() ? pl.pause() : pl.play();
};
$('play-sel').onclick = () => {
  playingSelection = true; cursor = null;
  pl.seek(start);
  pl.play();
};

setInterval(() => {
  if (!pl || !duration) return;
  const t = pl.time();
  $('playhead').style.left = pct(t) + '%';
  $('now').textContent = fmt(cursor !== null ? Math.floor(cursor * fps + 1e-3) / fps : t, 2);
  if (cursor !== null && (Math.abs(t - cursor) > 0.5 || pl.playing())) cursor = null;
  if (playingSelection && t >= end) {
    if ($('loop').checked) pl.seek(start);
    else { pl.pause(); pl.seek(end); playingSelection = false; }
  }
}, 80);

function onLoad() {
  const url = $('url').value.trim().replace(/^"(.*)"$/, '$1'); // "Copy as path" adds quotes
  if (/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(url)) { loadLocalFile(url); return; } // a pasted file path
  if (!/^https?:\/\/\S+$/i.test(url)) { setStatus('Please enter a valid video URL (starting with http:// or https://) or a file path.', 'error'); return; }
  loadVideo(url);
}

// ---------- local files: picker + drag & drop ----------
$('open-file').onclick = async () => {
  const p = await api.openFile();
  if (p) loadLocalFile(p);
};

let dragDepth = 0;
const dragHasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (dragHasFiles(e)) { dragDepth++; $('drop').hidden = false; } });
window.addEventListener('dragleave', (e) => { if (dragHasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault()); // without this the page refuses drops
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  const file = e.dataTransfer.files[0];
  if (file) {
    const p = api.pathForFile(file);
    if (p) loadLocalFile(p); else setStatus('Could not read the path of the dropped file.', 'error');
    return;
  }
  const link = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').trim();
  if (/^https?:\/\/\S+$/i.test(link)) { $('url').value = link; onLoad(); } // dropped a link
});
$('load').onclick = onLoad;
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') onLoad(); });

// ---------- export kind (audio / video) ----------
const FORMATS = { audio: ['mp3', 'm4a', 'opus', 'wav'], video: ['mp4', 'mkv'] };
const lastFormat = { audio: 'mp3', video: 'mp4' };

function applyKind() {
  const kind = $('kind').value;
  $('format').innerHTML = FORMATS[kind].map((f) => `<option>${f}</option>`).join('');
  $('format').value = lastFormat[kind];
  $('quality-label').hidden = kind !== 'video';
  updateActionLabel();
  $('ext').textContent = `.${$('format').value}`;
}
function updateActionLabel() {
  $('download').textContent = `${currentFile ? 'Save' : 'Download'} ${$('kind').value}`;
}
$('kind').onchange = applyKind;
$('format').onchange = () => { lastFormat[$('kind').value] = $('format').value; $('ext').textContent = `.${$('format').value}`; };

// File name: prefilled from the video title, freely editable. Empty = let yt-dlp use the title.
function safeName(s) {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 150);
}
function setDefaultName(title) { $('filename').value = safeName(title || ''); }
applyKind();

// ---------- download ----------
$('browse').onclick = async () => {
  const f = await api.chooseFolder($('folder').value);
  if (f) $('folder').value = f;
};
api.defaultFolder().then((f) => { $('folder').value = f; });
$('open-folder').onclick = () => api.openFolder($('folder').value);

// Progress display: bar + "label 45% · 2.3 MB/s · 0:12 left". While nothing measurable is happening
// (finding the stream, converting) the bar is indeterminate and an elapsed timer shows it is still alive.
let phase = null; // { text, since } while indeterminate
let phaseTimer = null;

function fmtSpeed(bps) { return bps >= 1048576 ? `${(bps / 1048576).toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`; }
function clock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), r = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
function fmtEta(sec) { return `${clock(sec)} left`; }

function setBar(pctValue) {
  const determinate = pctValue != null;
  $('bar').classList.toggle('indeterminate', !determinate);
  $('bar-fill').style.width = determinate ? `${pctValue}%` : '';
  $('bar-label').textContent = determinate ? `${Math.floor(pctValue)}%` : '';
}

function startPhase(text) {
  if (!phase || phase.text !== text) phase = { text, since: Date.now() };
  setBar(null);
  tickPhase();
}
function tickPhase() {
  if (phase) setStatus(`${phase.text} (${clock((Date.now() - phase.since) / 1000)})`);
}
function stopPhase() { phase = null; }

api.onProgress((m) => {
  if (m.stage === 'preparing') startPhase(currentFile ? 'Preparing…' : 'Preparing – finding the stream…');
  else if (m.stage === 'converting') startPhase('Converting / merging…');
  else if (m.stage === 'downloading') {
    stopPhase();
    setBar(m.percent);
    const what = m.trim ? 'Cutting' : 'Downloading';
    const label = m.step ? `${what} (step ${m.step.n}/${m.step.of})` : what;
    const parts = [`${label} ${Math.floor(m.percent)}%`];
    if (m.speed) parts.push(fmtSpeed(m.speed));
    if (m.eta) parts.push(fmtEta(m.eta));
    setStatus(parts.join(' · '));
  }
});

$('cancel').onclick = async () => {
  $('cancel').disabled = true;
  setStatus('Cancelling…');
  await api.cancelDownload();
};

$('download').onclick = async () => {
  if ((!currentUrl && !currentFile) || downloading) return;
  if (currentUrl && !ytdlpInstalled) { showModal(INSTALL_TEXT); return; } // local files only need ffmpeg
  downloading = true;
  $('download').disabled = true;
  $('open-folder').hidden = true;
  $('cancel').hidden = false;
  $('cancel').disabled = false;
  startPhase('Starting…');
  phaseTimer = setInterval(tickPhase, 1000);

  const trimmed = start > 0.05 || end < duration - 0.05;
  const payload = {
    url: currentUrl,
    file: currentFile,
    start: trimmed ? start : null,
    end: trimmed ? end : null,
    duration,
    kind: $('kind').value,
    format: $('format').value,
    height: Number($('quality').value),
    folder: $('folder').value,
    name: $('filename').value,
  };
  let result = await api.download(payload);
  if (result.exists) { // the chosen file name is taken: ask before replacing it
    const existing = result.file.split(/[\\/]/).pop();
    result = confirm(`"${existing}" already exists in this folder.\n\nOverwrite it?`)
      ? await api.download({ ...payload, overwrite: true })
      : { ok: false, cancelled: true };
  }

  downloading = false;
  clearInterval(phaseTimer);
  stopPhase();
  $('download').disabled = false;
  $('cancel').hidden = true;
  if (result.ok) {
    setBar(100);
    setStatus('Saved: ' + (result.file || $('folder').value), 'ok');
    $('open-folder').hidden = false;
  } else {
    setBar(0);
    $('bar-label').textContent = '';
    if (result.cancelled) setStatus('Download cancelled.');
    else setStatus(result.error, 'error');
  }
};

// ---------- yt-dlp install / update ----------
let ytdlpInstalled = false;

async function refreshYtdlp() {
  const s = await api.ytdlpStatus();
  ytdlpInstalled = s.installed;
  $('ytdlp-version').textContent = s.installed ? `yt-dlp ${s.version}` : 'yt-dlp: not installed';
  $('update-ytdlp').textContent = s.installed ? 'Update yt-dlp' : 'Install yt-dlp';
  $('update-hint').hidden = true;
  if (s.installed) checkForUpdate(s.version);
  return s;
}

// true when version string a is newer than b (both like "2026.08.19" or "2026.08.19.232857")
function isNewer(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

async function checkForUpdate(installed) {
  const latest = await api.ytdlpLatest();
  if (!latest || !ytdlpInstalled || !isNewer(latest, installed)) return;
  $('update-text').textContent = `Update available: ${latest}`;
  $('update-hint').hidden = false;
}
$('update-now').onclick = () => { $('update-hint').hidden = true; showModal(UPDATE_TEXT); $('modal-go').click(); };

function showModal({ title, text, button }) {
  $('modal-title').textContent = title;
  $('modal-text').innerHTML = text;
  $('modal-go').textContent = button;
  $('modal-error').hidden = true;
  $('modal-bar').hidden = true;
  $('modal-fill').style.width = '0';
  $('modal-go').disabled = false;
  $('modal-later').disabled = false;
  $('modal').hidden = false;
}

const INSTALL_TEXT = { title: 'yt-dlp is required', button: 'Download yt-dlp',
  text: "This app uses <b>yt-dlp</b> to fetch the audio. It isn't installed yet. Download it now (roughly 20–40&nbsp;MB, from the official GitHub releases)?" };
const UPDATE_TEXT = { title: 'Update yt-dlp', button: 'Update',
  text: 'Download the latest yt-dlp release and replace the current one? Do this if downloads start failing.' };

$('modal-later').onclick = () => { $('modal').hidden = true; };
$('modal-go').onclick = async () => {
  $('modal-go').disabled = true;
  $('modal-later').disabled = true;
  $('modal-error').hidden = true;
  $('modal-bar').hidden = false;
  const r = await api.ytdlpInstall();
  if (r.ok) {
    await refreshYtdlp();
    $('modal').hidden = true;
    setStatus(`yt-dlp ${r.version} installed`, 'ok');
  } else {
    $('modal-error').textContent = 'Download failed: ' + r.error;
    $('modal-error').hidden = false;
    $('modal-go').textContent = 'Retry';
    $('modal-go').disabled = false;
    $('modal-later').disabled = false;
  }
};
api.onInstallProgress((m) => { $('modal-fill').style.width = m.percent + '%'; });
$('update-ytdlp').onclick = () => showModal(ytdlpInstalled ? UPDATE_TEXT : INSTALL_TEXT);

refreshYtdlp().then((s) => { if (!s.installed) showModal(INSTALL_TEXT); });
