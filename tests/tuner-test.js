// Offline checks for tuner.js: run with `node tests/tuner-test.js`.
// Feeds the detector what the page feeds it: the input low-passed at 1 kHz, a 4096-sample
// window, decimated to ~24 kHz. Exits non-zero if any check fails.
'use strict';
const fs = require('fs');
const path = require('path');

const T = new Function(`${fs.readFileSync(path.join(__dirname, '..', 'tuner.js'), 'utf8')}\nreturn NEON_RIG_TUNER;`)();

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

// RBJ low-pass, Butterworth Q (the page uses a BiquadFilterNode with the same response).
function lowpass(x, sr, fc) {
  const w = 2 * Math.PI * fc / sr, al = Math.sin(w) / (2 * Math.SQRT1_2), c = Math.cos(w), a0 = 1 + al;
  const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
// What the page does once per reading: the last 4096 samples, decimated to ~24 kHz.
function reading(gen, sr, at = 0.25) {
  const len = Math.ceil((at + 0.1) * sr), x = new Float32Array(len);
  for (let i = 0; i < len; i++) x[i] = gen(i / sr);
  const f = lowpass(x, sr, 1000);
  const start = Math.floor(at * sr) - 4096;
  const d = Math.max(1, Math.floor(sr / 20000));
  return T.detect(T.decimate(f.subarray(start, start + 4096), d), sr / d);
}
// A plucked string: decaying harmonics, a strong 2nd harmonic as from a bridge pickup.
const guitar = (f, amp = 0.2, harm = [1, 0.8, 0.5, 0.35, 0.2, 0.1]) => (t) =>
  amp * Math.exp(-t / 1.2) * harm.reduce((s, a, k) => s + a * Math.sin(2 * Math.PI * f * (k + 1) * t + k), 0);
const cents = (a, b) => 1200 * Math.log2(a / b);
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

// Every string, open, at 44.1, 48 and 96 kHz, to within 1 cent.
for (const sr of [44100, 48000, 96000]) {
  let worst = 0, missed = [];
  for (const midi of [38, 40, 45, 50, 55, 59, 64, 69, 76, 83, 88]) { // drop D .. 24th fret high E
    const r = reading(guitar(hz(midi)), sr);
    const n = r && T.note(r.freq);
    if (!r || n.midi !== midi || r.clarity < 0.85) { missed.push(midi); continue; }
    worst = Math.max(worst, Math.abs(n.cents));
  }
  check(!missed.length && worst < 1, `Every note from drop D to the 24th fret reads right at ${sr} Hz`,
    missed.length ? `missed MIDI ${missed.join(', ')}` : `worst error ${worst.toFixed(2)} cents`);
}
// A low E with a weak fundamental (neck pickup, thin bass) must not jump an octave.
{
  const r = reading(guitar(hz(40), 0.2, [0.25, 1, 0.7, 0.5, 0.3]), 48000);
  check(!!r && T.note(r.freq).midi === 40, 'Low E with a weak fundamental stays in its octave', r ? `${r.freq.toFixed(2)} Hz` : 'no reading');
}
// Out-of-tune strings read the right way, to within 1 cent.
for (const off of [-37, -13, 6, 22, 45]) {
  const f = hz(55) * 2 ** (off / 1200);
  const r = reading(guitar(f), 48000);
  const n = r && T.note(r.freq);
  check(!!n && n.midi === 55 && Math.abs(n.cents - off) < 1, `G string ${off > 0 ? '+' : ''}${off} cents reads as such`, n ? `${n.cents.toFixed(2)} cents` : 'no reading');
}
// Late in a note's decay, quieter but still clear.
{
  const r = reading(guitar(hz(45), 0.2), 48000, 3);
  check(!!r && T.note(r.freq).midi === 45 && Math.abs(cents(r.freq, hz(45))) < 1, 'A string still reads 3 s into the decay', r ? `rms ${r.rms.toFixed(4)}` : 'no reading');
}
// Silence, low hum and noise give no confident reading.
{
  check(reading(() => 0, 48000) === null, 'Silence gives no reading');
  const hum = (t) => 0.001 * (Math.sin(2 * Math.PI * 60 * t) + 0.5 * Math.sin(2 * Math.PI * 180 * t));
  check(reading(hum, 48000) === null, 'Background hum below the threshold gives no reading');
  let seed = 7;
  const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return 0.1 * (seed / 2 ** 32 * 2 - 1); };
  const r = reading(noise, 48000);
  check(!r || r.clarity < 0.8, 'White noise is not mistaken for a note', r ? `clarity ${r.clarity.toFixed(2)}` : 'no reading');
}
// Note naming.
{
  const ok = [[82.41, 'E', 2], [440, 'A', 4], [233.08, 'A#', 3], [261.63, 'C', 4]].every(([f, name, oct]) => {
    const n = T.note(f); return n.name === name && n.octave === oct && Math.abs(n.cents) < 1;
  });
  check(ok && T.STRINGS.map((m) => T.note(hz(m)).name).join('') === 'EADGBE', 'Note names, octaves and the six strings');
}
// Cheap enough to run 20 times a second on the main thread.
{
  const x = T.decimate(lowpass(Float32Array.from({ length: 4096 }, (_, i) => guitar(82.41)(i / 48000)), 48000, 1000), 2);
  for (let i = 0; i < 20; i++) T.detect(x, 24000);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) T.detect(x, 24000);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 100;
  check(ms < 4, 'One reading costs a few milliseconds at most', `${ms.toFixed(2)} ms`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll tuner checks passed');
process.exit(failures ? 1 : 0);
