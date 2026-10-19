// Tests for app/media.js. Needs ffmpeg + ffprobe on PATH; builds small fixtures in a temp folder.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { trim, extractAudio, probe, buildArgs, audioExtFor } = require('../app/media');

let dir;
const p = (name) => path.join(dir, name);
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdown-test-'));
  // 20 s video + audio with a keyframe every second, so stream-copy cuts are predictable
  ffmpeg('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-c:v', 'libx264', '-g', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', p('video.mp4'));
  ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=330:duration=30', '-c:a', 'libmp3lame', p('song.mp3'));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('buildArgs: re-encode video, with and without height cap', () => {
  const a = buildArgs({ input: 'in.mkv', output: 'out.mp4', start: 5, end: 12 });
  assert.deepEqual(a.slice(a.indexOf('-ss'), a.indexOf('-ss') + 2), ['-ss', '5']);
  assert.equal(a[a.indexOf('-t') + 1], '7');
  assert.ok(a.includes('libx264') && a.includes('+faststart') && !a.includes('-vf'));
  assert.ok(buildArgs({ input: 'a', output: 'b.mkv', height: 480 }).join(' ').includes("scale=-2:'min(ih,480)'"));
});

test('buildArgs: copy mode and audio targets', () => {
  const copy = buildArgs({ input: 'a.mp4', output: 'b.mp4', start: 1, copy: true });
  assert.ok(copy.join(' ').includes('-c copy') && !copy.includes('libx264') && !copy.includes('-t'));
  const mp3 = buildArgs({ input: 'a.mp4', output: 'b.mp3' }); // audio extension => audio only, even via trim()
  assert.ok(mp3.includes('-vn') && mp3.includes('libmp3lame'));
  const keep = buildArgs({ input: 'a.mp4', output: 'b.m4a', copy: true }, true);
  assert.ok(keep.includes('-vn') && keep.join(' ').includes('-c:a copy'));
});

test('audioExtFor maps codecs to a container that can hold them', () => {
  assert.equal(audioExtFor('aac'), 'm4a');
  assert.equal(audioExtFor('mp3'), 'mp3');
  assert.equal(audioExtFor('pcm_s16le'), 'wav');
  assert.equal(audioExtFor('ac3'), 'mka'); // anything else goes into Matroska audio
  assert.equal(audioExtFor(null), null);
});

test('probe reads duration, streams and the copyable audio extension', async () => {
  const v = await probe(p('video.mp4'));
  assert.ok(v.ok && v.hasVideo && v.hasAudio);
  assert.ok(Math.abs(v.duration - 20) < 0.2);
  assert.equal(v.fps, 25);
  assert.equal(v.audioExt, 'm4a');
  const a = await probe(p('song.mp3'));
  assert.ok(a.ok && !a.hasVideo && a.hasAudio);
  assert.equal(a.audioExt, 'mp3');
  assert.equal((await probe(p('missing.mp4'))).ok, false);
});

test('trim() re-encodes a video to the exact range', async () => {
  const out = p('trim_exact.mp4');
  const r = await trim({ input: p('video.mp4'), output: out, start: 5, end: 12 });
  assert.equal(r.ok, true, r.error);
  const i = await probe(out);
  assert.ok(Math.abs(i.duration - 7) < 0.1, `duration ${i.duration}`);
  assert.ok(i.hasVideo && i.hasAudio);
});

test('trim() with only a start or only an end', async () => {
  const a = p('trim_start.mp4'), b = p('trim_end.mp4');
  assert.equal((await trim({ input: p('video.mp4'), output: a, start: 15 })).ok, true);
  assert.equal((await trim({ input: p('video.mp4'), output: b, end: 4 })).ok, true);
  assert.ok(Math.abs((await probe(a)).duration - 5) < 0.1);
  assert.ok(Math.abs((await probe(b)).duration - 4) < 0.1);
});

test('trim() with copy keeps the codecs and lands near the range', async () => {
  const out = p('trim_copy.mp4');
  const r = await trim({ input: p('video.mp4'), output: out, start: 5, end: 12, copy: true });
  assert.equal(r.ok, true, r.error);
  const codecs = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out]).toString().trim().split(/\s+/).sort();
  assert.deepEqual(codecs, ['aac', 'h264']); // not re-encoded
  assert.ok(Math.abs((await probe(out)).duration - 7) < 1.5, 'cut should be within a keyframe of the request');
});

test('trim() caps the height when asked', async () => {
  const out = p('trim_small.mp4');
  assert.equal((await trim({ input: p('video.mp4'), output: out, start: 0, end: 3, height: 180 })).ok, true);
  const h = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', out]).toString().trim();
  assert.equal(h, '180');
});

test('extractAudio() from a video, re-encoded and copied', async () => {
  const mp3 = p('audio.mp3');
  assert.equal((await extractAudio({ input: p('video.mp4'), output: mp3, start: 5, end: 10 })).ok, true);
  const m = await probe(mp3);
  assert.ok(!m.hasVideo && m.audioCodec === 'mp3' && Math.abs(m.duration - 5) < 0.2);

  const m4a = p('audio_copy.m4a');
  assert.equal((await extractAudio({ input: p('video.mp4'), output: m4a, copy: true })).ok, true);
  const c = await probe(m4a);
  assert.ok(!c.hasVideo && c.audioCodec === 'aac' && Math.abs(c.duration - 20) < 0.3);
});

test('trim() an audio file, re-encoded and copied', async () => {
  const a = p('song_cut.mp3'), b = p('song_copy.mp3');
  assert.equal((await trim({ input: p('song.mp3'), output: a, start: 10, end: 20 })).ok, true);
  assert.equal((await trim({ input: p('song.mp3'), output: b, start: 10, end: 20, copy: true })).ok, true);
  assert.ok(Math.abs((await probe(a)).duration - 10) < 0.2);
  assert.ok(Math.abs((await probe(b)).duration - 10) < 0.2);
  assert.equal((await probe(b)).audioCodec, 'mp3');
});

test('progress is reported while cutting', async () => {
  const seen = [];
  const r = await trim({ input: p('video.mp4'), output: p('progress.mp4'), duration: 20, onProgress: (x) => seen.push(x.fraction) });
  assert.equal(r.ok, true);
  assert.ok(seen.length > 0 && seen.every((f) => f >= 0 && f <= 1));
});

test('errors: bad range, overwriting the source, missing input', async () => {
  assert.match((await trim({ input: p('video.mp4'), output: p('x.mp4'), start: 9, end: 3 })).error, /after start/);
  assert.match((await trim({ input: p('video.mp4'), output: p('video.mp4'), start: 1 })).error, /overwrite the source/);
  const missing = await trim({ input: p('nope.mp4'), output: p('y.mp4'), start: 1 });
  assert.equal(missing.ok, false);
  assert.ok(missing.error.length > 0);
});
