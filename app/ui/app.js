const $ = (id) => document.getElementById(id);

let pl = null; // active preview adapter: yt | html5 | noPreview
let duration = 0;
let start = 0;
let end = 0;
let currentUrl = null;
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

async function loadVideo(url) {
  const token = ++loadToken;
  const stale = () => token !== loadToken;
  currentUrl = url;
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

    duration = info.duration;
    start = 0;
    end = duration;
    $('total').textContent = fmt(duration);
    $('trim').classList.remove('disabled');
    $('download').disabled = downloading;
    setStatus(meta.title ? `Ready – ${meta.title}` : 'Ready – set your start and end markers');
    render();

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
  const url = $('url').value.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) { setStatus('Please enter a valid video URL (starting with http:// or https://).', 'error'); return; }
  loadVideo(url);
}
$('load').onclick = onLoad;
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') onLoad(); });

// ---------- download ----------
$('browse').onclick = async () => {
  const f = await api.chooseFolder($('folder').value);
  if (f) $('folder').value = f;
};
api.defaultFolder().then((f) => { $('folder').value = f; });
$('open-folder').onclick = () => api.openFolder($('folder').value);

api.onProgress((m) => {
  if (m.stage === 'downloading') {
    $('bar').classList.remove('indeterminate');
    $('bar-fill').style.width = m.percent + '%';
    setStatus(`Downloading… ${m.percent.toFixed(0)}%`);
  } else if (m.stage === 'converting') {
    $('bar').classList.add('indeterminate');
    setStatus('Converting…');
  }
});

$('download').onclick = async () => {
  if (!currentUrl || downloading) return;
  if (!ytdlpInstalled) { showModal(INSTALL_TEXT); return; }
  downloading = true;
  $('download').disabled = true;
  $('open-folder').hidden = true;
  $('bar').classList.add('indeterminate');
  $('bar-fill').style.width = '0';
  setStatus('Starting…');

  const trimmed = start > 0.05 || end < duration - 0.05;
  const result = await api.download({
    url: currentUrl,
    start: trimmed ? start : null,
    end: trimmed ? end : null,
    format: $('format').value,
    folder: $('folder').value,
  });

  downloading = false;
  $('download').disabled = false;
  $('bar').classList.remove('indeterminate');
  if (result.ok) {
    $('bar-fill').style.width = '100%';
    setStatus('Saved: ' + (result.file || $('folder').value), 'ok');
    $('open-folder').hidden = false;
  } else {
    $('bar-fill').style.width = '0';
    setStatus(result.error, 'error');
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
  text: "This app uses <b>yt-dlp</b> to fetch the audio. It isn't installed yet. Download it now (about 18&nbsp;MB, from the official GitHub releases)?" };
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
