const $ = (id) => document.getElementById(id);

let player = null;
let duration = 0;
let start = 0;
let end = 0;
let currentId = null;
let playingSelection = false;
let downloading = false;

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

// ---------- YouTube player ----------
let playerReady = false;
let apiReady = new Promise((resolve) => { window.onYouTubeIframeAPIReady = resolve; });
const tag = document.createElement('script');
tag.src = 'https://www.youtube.com/iframe_api';
document.head.appendChild(tag);

async function loadVideo(id) {
  await apiReady;
  currentId = id;
  duration = 0;
  $('trim').classList.add('disabled');
  $('download').disabled = true;
  setStatus('Loading video…');
  playingSelection = false; pauseOnPlay = false; cursor = null;
  if (player) {
    // cue (not load) so nothing autoplays; works for the same id too. Before onReady the player has no
    // methods yet - onReady picks up currentId instead.
    if (playerReady) { player.cueVideoById(id); waitForDuration(); }
    return;
  }
  player = new YT.Player('player', {
    videoId: id,
    width: '100%', height: '100%',
    // disablekb: turn off YouTube's own keyboard shortcuts (they clash with the app's arrow keys)
    playerVars: { rel: 0, playsinline: 1, disablekb: 1, origin: location.origin },
    events: {
      onReady: () => {
        playerReady = true;
        if (player.getVideoData?.()?.video_id !== currentId) player.cueVideoById(currentId);
        waitForDuration();
      },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.PLAYING && pauseOnPlay) { // finish a frame step on a never-started player
          pauseOnPlay = false; player.pauseVideo(); if (cursor !== null) player.seekTo(cursor, true);
        }
      },
      onError: (e) => {
        durationPoll++;
        const msgs = { 2: 'Invalid video ID.', 5: 'Player error.', 100: 'Video not found or private.',
                       101: 'The owner disabled embedding for this video.', 150: 'The owner disabled embedding for this video.',
                       153: 'Embedding blocked (player configuration error).' };
        setStatus(msgs[e.data] || `Player error ${e.data}`, 'error');
      },
    },
  });
  $('player-wrap').classList.add('loaded');
}

// Frame stepping. The player API has no frame info, so assume 30 fps until yt-dlp reports the real rate.
let fps = 30;
let pauseOnPlay = false;
let cursor = null; // last frame-step target; getCurrentTime() can lag right after a seek

function loadFps(id) {
  fps = 30;
  $('fps').textContent = '30 fps (assumed)';
  api.videoFps(id).then((f) => {
    if (f && id === currentId) { fps = f; $('fps').textContent = `${+f.toFixed(2)} fps`; }
  });
}

function stepFrame(dir) {
  if (!player || !duration) return;
  playingSelection = false;
  player.pauseVideo();
  const t = cursor ?? player.getCurrentTime();
  const last = Math.max(0, Math.ceil(duration * fps) - 1);
  const frame = Math.min(last, Math.max(0, Math.floor(t * fps + 1e-3) + dir));
  cursor = (frame + 0.25) / fps; // aim inside the frame so float error can't land on a neighbour
  player.seekTo(cursor, true);
  // A never-started (-1) or cued (5) player ignores seeks until it has played once.
  const st = player.getPlayerState();
  if (st === YT.PlayerState.UNSTARTED || st === YT.PlayerState.CUED) { pauseOnPlay = true; player.playVideo(); }
}
$('prev-frame').onclick = () => stepFrame(-1);
$('next-frame').onclick = () => stepFrame(1);
window.addEventListener('keydown', (e) => {
  if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  if (!$('modal').hidden || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  e.preventDefault();
  stepFrame(e.key === 'ArrowLeft' ? -1 : 1);
});

let durationPoll = 0;
// Clicking the player gives the cross-origin iframe keyboard focus, so the page would never see the arrow
// keys. Hand focus straight back to the page.
window.addEventListener('blur', () => setTimeout(() => {
  if (document.activeElement && document.activeElement.tagName === 'IFRAME') document.activeElement.blur();
}, 0));

function waitForDuration() {
  const mine = ++durationPoll; // a newer load cancels older polls
  const began = Date.now();
  const tick = () => {
    if (mine !== durationPoll) return;
    const d = player.getDuration && player.getDuration();
    const loaded = player.getVideoData?.()?.video_id === currentId;
    if (d > 0 && loaded) {
      duration = d;
      start = 0; end = d;
      $('total').textContent = fmt(d);
      $('trim').classList.remove('disabled');
      $('download').disabled = downloading;
      setStatus('Ready — set your start and end markers');
      render();
      loadFps(currentId);
    } else if (Date.now() - began > 20000) {
      setStatus('Could not load the video (timed out).', 'error');
    } else setTimeout(tick, 200);
  };
  tick();
}

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

function seek(t) { cursor = null; if (player && duration) player.seekTo(t, true); }

function dragHandle(el, which) {
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag');
    playingSelection = false;
    if (player.getPlayerState() === YT.PlayerState.PLAYING) player.pauseVideo();
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

$('set-start').onclick = () => { start = Math.min(player.getCurrentTime(), end - 0.1); render(); };
$('set-end').onclick = () => { end = Math.max(player.getCurrentTime(), start + 0.1); render(); };

// ---------- playback controls ----------
$('play-toggle').onclick = () => {
  playingSelection = false; cursor = null;
  player.getPlayerState() === YT.PlayerState.PLAYING ? player.pauseVideo() : player.playVideo();
};
$('play-sel').onclick = () => {
  playingSelection = true; cursor = null;
  player.seekTo(start, true);
  player.playVideo();
};

setInterval(() => {
  if (!player || !duration || !player.getCurrentTime) return;
  const t = player.getCurrentTime();
  $('playhead').style.left = pct(t) + '%';
  $('now').textContent = fmt(cursor !== null ? Math.floor(cursor * fps + 1e-3) / fps : t, 2);
  if (cursor !== null && (Math.abs(t - cursor) > 0.5 || player.getPlayerState() === YT.PlayerState.PLAYING)) cursor = null;
  if (playingSelection && t >= end) {
    if ($('loop').checked) player.seekTo(start, true);
    else { player.pauseVideo(); player.seekTo(end, true); playingSelection = false; }
  }
}, 80);

// ---------- loading ----------
function onLoad() {
  const id = videoId($('url').value);
  if (!id) { setStatus('Please enter a valid youtube.com / youtu.be video URL.', 'error'); return; }
  loadVideo(id);
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
  if (!currentId || downloading) return;
  if (!ytdlpInstalled) { showModal(INSTALL_TEXT); return; }
  downloading = true;
  $('download').disabled = true;
  $('open-folder').hidden = true;
  $('bar').classList.add('indeterminate');
  $('bar-fill').style.width = '0';
  setStatus('Starting…');

  const trimmed = start > 0.05 || end < duration - 0.05;
  const result = await api.download({
    url: `https://www.youtube.com/watch?v=${currentId}`,
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
