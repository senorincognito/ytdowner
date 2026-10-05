const $ = (id) => document.getElementById(id);

let player = null;
let duration = 0;
let start = 0;
let end = 0;
let currentId = null;
let playingSelection = false;
let downloading = false;

// ---------- time helpers ----------
function fmt(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec - h * 3600 - m * 60;
  const ss = s.toFixed(1).padStart(4, '0');
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
  if (player) { player.loadVideoById(id); player.pauseVideo(); return; }
  player = new YT.Player('player', {
    videoId: id,
    width: '100%', height: '100%',
    playerVars: { rel: 0, playsinline: 1, origin: location.origin },
    events: {
      onReady: () => waitForDuration(),
      onStateChange: (e) => { if (e.data === YT.PlayerState.PLAYING && !duration) waitForDuration(); },
      onError: (e) => {
        const msgs = { 2: 'Invalid video ID.', 5: 'Player error.', 100: 'Video not found or private.',
                       101: 'The owner disabled embedding for this video.', 150: 'The owner disabled embedding for this video.',
                       153: 'Embedding blocked (player configuration error).' };
        setStatus(msgs[e.data] || `Player error ${e.data}`, 'error');
      },
    },
  });
  $('player-wrap').classList.add('loaded');
}

function waitForDuration() {
  const tick = () => {
    const d = player.getDuration && player.getDuration();
    if (d > 0) {
      duration = d;
      start = 0; end = d;
      $('total').textContent = fmt(d);
      $('trim').classList.remove('disabled');
      $('download').disabled = downloading;
      setStatus('Ready — set your start and end markers');
      render();
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

function seek(t) { if (player && duration) player.seekTo(t, true); }

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
  playingSelection = false;
  player.getPlayerState() === YT.PlayerState.PLAYING ? player.pauseVideo() : player.playVideo();
};
$('play-sel').onclick = () => {
  playingSelection = true;
  player.seekTo(start, true);
  player.playVideo();
};

setInterval(() => {
  if (!player || !duration || !player.getCurrentTime) return;
  const t = player.getCurrentTime();
  $('playhead').style.left = pct(t) + '%';
  $('now').textContent = fmt(t);
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
