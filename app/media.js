// Small ffmpeg wrappers for local media: probe(), trim() and extractAudio().
//
//   trim({ input, output, start, end, copy })         cut a time range; the output extension picks the format
//   extractAudio({ input, output, start, end, copy }) keep only the sound track (optionally trimmed too)
//
// start / end are seconds and both optional (omit one to trim only the other end). Both functions resolve to
// { ok: true } or { ok: false, error }. With copy: true the streams are copied, not re-encoded: nearly instant and
// lossless, but video can only be cut at keyframes, so the start may be off by a second or two.
const { spawn } = require('child_process');
const path = require('path');

// Encoders used when re-encoding to an audio file, keyed by output extension.
const AUDIO_CODEC = {
  mp3: ['-c:a', 'libmp3lame', '-q:a', '0'],
  m4a: ['-c:a', 'aac', '-b:a', '192k'],
  opus: ['-c:a', 'libopus', '-b:a', '160k'],
  ogg: ['-c:a', 'libvorbis', '-q:a', '5'],
  flac: ['-c:a', 'flac'],
  wav: ['-c:a', 'pcm_s16le'],
  mka: [],
};
const AUDIO_EXT = new Set(Object.keys(AUDIO_CODEC));

// Natural container extension for an audio stream that is copied out unchanged.
const EXT_FOR_CODEC = { aac: 'm4a', alac: 'm4a', mp3: 'mp3', opus: 'opus', vorbis: 'ogg', flac: 'flac' };
function audioExtFor(codec) {
  if (!codec) return null;
  if (codec.startsWith('pcm_')) return 'wav';
  return EXT_FOR_CODEC[codec] || 'mka'; // Matroska audio holds any codec
}

const extOf = (file) => path.extname(file).slice(1).toLowerCase();

// ffmpeg arguments for a trim / audio extraction. Pure, so it can be tested without running ffmpeg.
function buildArgs({ input, output, start, end, copy = false, height = 0 }, audioOnly = false) {
  const ext = extOf(output);
  const toAudio = audioOnly || AUDIO_EXT.has(ext);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];
  if (start != null) args.push('-ss', String(start)); // before -i: fast seek, still frame-accurate when re-encoding
  args.push('-i', input);
  if (end != null) args.push('-t', String(end - (start ?? 0)));

  if (toAudio) {
    args.push('-vn');
    if (copy) args.push('-c:a', 'copy');
    else args.push(...(AUDIO_CODEC[ext] ?? []));
  } else if (copy) {
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
  } else {
    if (height) args.push('-vf', `scale=-2:'min(ih,${Number(height)})'`); // cap the height, keep the aspect ratio
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k');
    if (ext === 'mp4') args.push('-movflags', '+faststart');
  }
  args.push(output);
  return args;
}

const lastLine = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';

// Runs ffmpeg and reports progress through `-progress pipe:1` (key=value lines on stdout).
// onSpawn(child) lets the caller keep the process so it can be cancelled.
function run(args, { clipLen = 0, onProgress, onSpawn } = {}) {
  return new Promise((resolve) => {
    let buf = '', err = '', outSec = null, speedX = 0;
    const child = spawn('ffmpeg', args, { windowsHide: true });
    onSpawn?.(child);
    const onLine = (line) => {
      let m;
      line = line.trim();
      if ((m = /^out_time_us=(\d+)/.exec(line))) outSec = Number(m[1]) / 1e6;
      else if ((m = /^speed=\s*([\d.]+)x/.exec(line))) speedX = parseFloat(m[1]);
      else if (line.startsWith('progress=') && outSec != null && clipLen > 0) {
        onProgress?.({
          fraction: Math.min(1, outSec / clipLen),
          eta: speedX > 0 ? Math.max(0, clipLen - outSec) / speedX : null,
        });
      }
    };
    child.stdout.on('data', (d) => { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop(); lines.forEach(onLine); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-20000); });
    child.on('error', (e) => resolve({
      ok: false,
      error: e.code === 'ENOENT' ? 'ffmpeg was not found – install ffmpeg and make sure it is on your PATH.' : e.message,
    }));
    child.on('close', (code) => {
      if (buf) onLine(buf);
      resolve(code === 0 ? { ok: true } : { ok: false, error: lastLine(err) || `ffmpeg exited with ${code}` });
    });
  });
}

function cut(opts, audioOnly) {
  const { start, end, duration, onProgress, onSpawn } = opts;
  if (start != null && end != null && end <= start) return Promise.resolve({ ok: false, error: 'End must be after start.' });
  if (path.resolve(opts.input).toLowerCase() === path.resolve(opts.output).toLowerCase()) {
    return Promise.resolve({ ok: false, error: 'The output would overwrite the source file – choose a different name or folder.' });
  }
  const clipLen = (end ?? duration ?? 0) - (start ?? 0);
  return run(buildArgs(opts, audioOnly), { clipLen, onProgress, onSpawn });
}

const trim = (opts) => cut(opts, false);
const extractAudio = (opts) => cut(opts, true);

// What is in a media file: duration, frame rate, whether it has picture / sound, and the audio codec.
function probe(file) {
  return new Promise((resolve) => {
    let out = '', err = '';
    const c = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true });
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', () => resolve({ ok: false, error: 'ffprobe was not found. It ships with ffmpeg – make sure ffmpeg is installed and on your PATH.' }));
    c.on('close', () => {
      let j;
      try { j = JSON.parse(out); } catch { j = null; }
      if (!j) return resolve({ ok: false, error: lastLine(err) || 'This file could not be read.' });
      const streams = j.streams || [];
      const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic); // skip cover art
      const audio = streams.find((s) => s.codec_type === 'audio');
      if (!video && !audio) return resolve({ ok: false, error: 'No audio or video stream found in this file.' });
      const rate = (str) => { const [a, b] = String(str || '').split('/').map(Number); return b ? a / b : a; };
      const fps = video ? [rate(video.avg_frame_rate), rate(video.r_frame_rate)].find((f) => f > 0 && f <= 240) || null : null;
      const duration = Number(j.format?.duration) || Math.max(0, ...streams.map((s) => Number(s.duration) || 0));
      resolve({
        ok: true,
        duration,
        fps: fps ? Math.round(fps * 100) / 100 : null,
        hasVideo: !!video,
        hasAudio: !!audio,
        audioCodec: audio?.codec_name ?? null,
        audioExt: audioExtFor(audio?.codec_name), // extension to use when copying the audio out unchanged
      });
    });
  });
}

module.exports = { trim, extractAudio, probe, buildArgs, audioExtFor, AUDIO_EXT };
