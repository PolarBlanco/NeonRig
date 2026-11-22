// Offline checks for dsp.js: run with `node tests/dsp-test.js`.
// Evaluates the real processor code under a minimal AudioWorklet stand-in and feeds it
// test signals. Exits non-zero if any check fails.
'use strict';
const fs = require('fs');
const path = require('path');

const SR = Number(process.env.SR) || 48000;
const BLOCK = 128;
const registry = {};
globalThis.sampleRate = SR;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { onmessage: null, postMessage() {} }; }
};
globalThis.registerProcessor = (name, cls) => { registry[name] = cls; };

const src = fs.readFileSync(path.join(__dirname, '..', 'dsp.js'), 'utf8');
const DSP = new Function(`${src}\nreturn NEON_RIG_DSP;`)()();

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

function make(name, params = {}, engaged = true) {
  return new registry[name]({ processorOptions: { params, engaged } });
}
function send(proc, msg) { proc.port.onmessage({ data: msg }); }

// Run a processor over a signal generator; returns {L, R, ms}.
function run(proc, seconds, gen, onBlock) {
  const total = Math.ceil(seconds * SR / BLOCK) * BLOCK;
  const L = new Float32Array(total), R = new Float32Array(total);
  const inL = new Float32Array(BLOCK), inR = new Float32Array(BLOCK);
  const oL = new Float32Array(BLOCK), oR = new Float32Array(BLOCK);
  const t0 = process.hrtime.bigint();
  for (let b = 0; b < total; b += BLOCK) {
    if (onBlock) onBlock(b / SR);
    for (let i = 0; i < BLOCK; i++) { const v = gen(b + i); inL[i] = v; inR[i] = v; }
    proc.process([[inL, inR]], [[oL, oR]]);
    L.set(oL, b); R.set(oR, b);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { L, R, ms, seconds: total / SR };
}

const rms = (a, from = 0, to = a.length) => {
  let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
const peak = (a) => { let m = 0; for (const v of a) { const x = Math.abs(v); if (!(x <= m)) m = x; } return m; };
const finite = (a) => a.every(Number.isFinite);
const sine = (f, amp) => (i) => amp * Math.sin(2 * Math.PI * f * i / SR);
let seed = 12345;
const noise = (amp) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return amp * (seed / 2 ** 32 * 2 - 1); };
const burst = (amp, secs) => { const n = noise(amp); return (i) => (i < secs * SR ? n() : 0); };
// A noise burst limited to the guitar's band (4 one-poles at 5 kHz) with the same level in that
// band at every sample rate. White noise spreads its power evenly up to SR/2, so at 96 kHz only half
// of it lands in the audio band; that made the reverb read ~3 dB quieter there (2026-11-22). Scaling
// by sqrt(SR / 48000) keeps the in-band level fixed. Its own seed, so it repeats.
const GB_AMP = 0.36; // reverb ROOM's early tail ~-44.4 dBFS, the same margin as the old white-noise burst
const guitarBurst = (amp, secs) => {
  let s = 777; const a = Math.exp(-2 * Math.PI * 5000 / SR), z = [0, 0, 0, 0], k0 = amp * Math.sqrt(SR / 48000);
  return (i) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    let x = i < secs * SR ? k0 * (s / 2 ** 32 * 2 - 1) : 0;
    for (let k = 0; k < 4; k++) { z[k] = x + a * (z[k] - x); x = z[k]; }
    return x;
  };
};
// A decaying plucked-string-ish note, roughly what a guitar DI looks like.
const pluck = (f, amp) => (i) => amp * Math.exp(-i / (SR * 0.6)) *
  (Math.sin(2 * Math.PI * f * i / SR) + 0.5 * Math.sin(4 * Math.PI * f * i / SR) + 0.25 * Math.sin(6 * Math.PI * f * i / SR));

// Goertzel power at one frequency, used to estimate harmonic distortion.
function tonePower(a, f, from, to) {
  const w = 2 * Math.PI * f / SR, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = from; i < to; i++) { const s0 = a[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}
function thd(a, f) {
  const from = Math.floor(a.length / 2), to = a.length;
  const fund = tonePower(a, f, from, to);
  let harm = 0;
  for (let h = 2; h <= 9; h++) harm += tonePower(a, f * h, from, to);
  return Math.sqrt(harm / fund);
}
const cpu = (r) => `${(r.ms / (r.seconds * 1000) * 100).toFixed(2)}% of one core`;
const dB = (x) => 20 * Math.log10(x + 1e-12);

// Run several processors in series (the way the app chains them); returns the left output.
function series(procs, input) {
  const out = new Float32Array(input.length);
  const bufs = Array.from({ length: procs.length + 1 }, () => [new Float32Array(BLOCK), new Float32Array(BLOCK)]);
  for (let b = 0; b + BLOCK <= input.length; b += BLOCK) {
    for (let i = 0; i < BLOCK; i++) bufs[0][0][i] = bufs[0][1][i] = input[b + i];
    procs.forEach((p, i) => p.process([bufs[i]], [bufs[i + 1]]));
    out.set(bufs[procs.length][0], b);
  }
  return out;
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, h = len / 2;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < h; k++) {
        const c = Math.cos(ang * k), s = Math.sin(ang * k), a = i + k, b = a + h;
        const vr = re[b] * c - im[b] * s, vi = re[b] * s + im[b] * c;
        re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
      }
    }
  }
}
// Aliasing: energy away from the harmonics of f0 relative to the harmonics (dB), up to maxHz.
function inharmonic(procs, f0, maxHz) {
  const M = 65536, input = Float32Array.from({ length: M + SR }, (_, i) => 0.3 * Math.sin(2 * Math.PI * f0 * i / SR));
  const o = series(procs, input).subarray(SR);
  const re = Float64Array.from(o, (v, i) => v * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / M))), im = new Float64Array(M);
  fft(re, im);
  let harm = 0, other = 0;
  for (let b = 1; b * SR / M <= maxHz; b++) {
    const f = b * SR / M, p = re[b] * re[b] + im[b] * im[b];
    if (Math.abs(f / f0 - Math.round(f / f0)) * f0 < 25) harm += p; else other += p;
  }
  return 10 * Math.log10(other / harm);
}

// ------------------------------------------------------------------ input conditioner
{
  const steady = (hz, f, amp = 0.05) => {
    const r = run(make('neon-input', { hum: hz }), 2, sine(f, amp));
    return dB(rms(r.L, SR) / (amp / Math.SQRT2));
  };
  const cut60 = steady(60, 60), cut180 = steady(60, 180), cut50 = steady(50, 50), cut100 = steady(50, 100);
  check(cut60 < -30 && cut180 < -30 && cut50 < -30 && cut100 < -30, 'Hum filter notches the mains line and its harmonics',
    `60 Hz ${cut60.toFixed(0)} dB, 180 Hz ${cut180.toFixed(0)} dB (60 mode); 50 Hz ${cut50.toFixed(0)} dB, 100 Hz ${cut100.toFixed(0)} dB (50 mode)`);
  const lowE = steady(60, 82.41), a2 = steady(60, 110), b2 = steady(60, 123.47), g4 = steady(60, 415.3);
  check([lowE, a2, b2, g4].every((v) => Math.abs(v) < 1), 'Hum filter leaves guitar notes alone',
    `E2 ${lowE.toFixed(2)} dB, A2 ${a2.toFixed(2)} dB, B2 ${b2.toFixed(2)} dB, G#4 ${g4.toFixed(2)} dB`);
  const thru = steady(0, 1000);
  check(Math.abs(thru) < 0.05, 'Conditioner with hum and gate off is transparent', `${thru.toFixed(3)} dB at 1 kHz`);

  // Gate: a -70 dBFS hiss floor should vanish; a note after it should open the gate at once.
  const hiss = noise(3.2e-4);
  const g = make('neon-input', { gate: -60 });
  const note = pluck(196, 0.2);
  const r = run(g, 2, (i) => hiss() + (i >= SR ? note(i - SR) : 0));
  const floorIn = rms(Float32Array.from({ length: SR / 2 }, hiss)), floorOut = rms(r.L, SR / 2, SR);
  check(dB(floorOut / floorIn) < -40, 'Gate silences the noise floor between notes', `${dB(floorOut / floorIn).toFixed(0)} dB`);
  let first = SR; while (Math.abs(r.L[first]) < 0.01) first++;
  const peakIn = (from, to) => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(note(i - SR))); return m; };
  let peakOut = 0; for (let i = SR; i < SR + 0.01 * SR; i++) peakOut = Math.max(peakOut, Math.abs(r.L[i]));
  check((first - SR) / SR < 0.002 && peakOut > 0.8 * peakIn(SR, SR + 0.01 * SR), 'Gate opens instantly on a pick attack',
    `first sound after ${((first - SR) / SR * 1000).toFixed(2)} ms, first-10 ms peak ${(peakOut / peakIn(SR, SR + 0.01 * SR) * 100).toFixed(0)}% of input`);

  // LEARN: hum + hiss should be identified and the gate set just above it.
  // Runs LEARN on hum + hiss, then keeps the same noise going for 2 s to see the gate hold shut.
  const learn = (mains, amp = 4e-4) => {
    const p = make('neon-input');
    let msg = null;
    p.port.postMessage = (m) => { if (m.type === 'learned') msg = m; };
    send(p, { type: 'learn' });
    const h = noise(1.5e-4);
    const gen = (i) => { let v = h(); for (let k = 1; k <= 6; k++) v += amp * Math.sin(2 * Math.PI * mains * k * i / SR + k) / k; return v; };
    const r = run(p, 4.4, gen);
    const input = Float32Array.from({ length: r.L.length }, (_, i) => gen(i));
    if (msg) msg.afterDb = dB(rms(r.L, 2.4 * SR, 4.4 * SR) / rms(input, 2.4 * SR, 4.4 * SR));
    return msg;
  };
  const l60 = learn(60), l50 = learn(50), lLoud = learn(60, 0.3);
  check(l60 && l60.hum === 60 && l50 && l50.hum === 50 && l60.humCutDb > 6, 'LEARN detects 50 vs 60 Hz hum',
    l60 ? `60 Hz rig: hum ${l60.hum}, ${l60.humCutDb.toFixed(1)} dB removed, floor ${l60.floorDb.toFixed(1)} dBFS, gate ${l60.gateDb} dB; 50 Hz rig: hum ${l50 && l50.hum}` : 'no result');
  check(l60 && l60.gateDb > l60.peakDb + 6 && l60.gateDb < l60.peakDb + 12 && l60.afterDb < -40 && l50.afterDb < -40,
    'LEARNed gate stays shut on the noise afterwards', l60 ? `gate ${l60.gateDb} dB vs noise peaks ${l60.peakDb.toFixed(1)} dBFS; noise after: ${l60.afterDb.toFixed(0)} dB (60), ${l50.afterDb.toFixed(0)} dB (50)` : '');
  check(lLoud && lLoud.tooLoud && lLoud.gateDb === undefined, 'LEARN refuses to set a gate while the guitar is being played');
  {
    const p = make('neon-input');
    let msg = null;
    p.port.postMessage = (m) => { if (m.type === 'learned') msg = m; };
    send(p, { type: 'learn' });
    run(p, 2.4, () => 0);
    check(msg && msg.noSignal && msg.gateDb === undefined, 'LEARN reports a dead input instead of setting a gate');
  }
  const perf = run(make('neon-input', { hum: 60, gate: -65 }), 10, pluck(110, 0.3));
  console.log(`      Input conditioner CPU: ${cpu(perf)}`);
}

// ------------------------------------------------------------------ overdrive
{
  const dry = sine(196, 0.12);
  const inRms = rms(Float32Array.from({ length: SR }, (_, i) => dry(i)));
  const lo = run(make('neon-ts', { drive: 0, tone: 0.5, level: 0.5 }), 1, dry);
  const hi = run(make('neon-ts', { drive: 1, tone: 0.5, level: 0.5 }), 1, dry);
  check(finite(lo.L) && finite(hi.L), 'TS output finite');
  const tLo = thd(lo.L, 196), tHi = thd(hi.L, 196);
  check(tHi > tLo * 1.5 && tHi > 0.2, 'TS distortion rises with DRIVE', `THD drive0=${(tLo * 100).toFixed(1)}% drive10=${(tHi * 100).toFixed(1)}%`);
  const gLo = 20 * Math.log10(rms(lo.L, SR / 2) / inRms), gHi = 20 * Math.log10(rms(hi.L, SR / 2) / inRms);
  check(Math.abs(gLo) < 9 && Math.abs(gHi) < 9, 'TS level near unity at LEVEL 5', `drive0 ${gLo.toFixed(1)} dB, drive10 ${gHi.toFixed(1)} dB`);
  const bright = run(make('neon-ts', { drive: 0.5, tone: 1, level: 0.5 }), 1, sine(3000, 0.1));
  const dark = run(make('neon-ts', { drive: 0.5, tone: 0, level: 0.5 }), 1, sine(3000, 0.1));
  check(rms(bright.L, SR / 2) > rms(dark.L, SR / 2) * 2, 'TS TONE brightens', `3 kHz ${(20 * Math.log10(rms(bright.L, SR / 2) / rms(dark.L, SR / 2))).toFixed(1)} dB brighter`);
  const hot = run(make('neon-ts', { drive: 1, level: 1 }), 1, noise(1));
  check(finite(hot.L) && peak(hot.L) < 5, 'TS stable with full-scale noise', `peak ${peak(hot.L).toFixed(2)}`);
  const perf = run(make('neon-ts', { drive: 0.7 }), 10, pluck(110, 0.3));
  console.log(`      TS CPU: ${cpu(perf)}`);
}

// ------------------------------------------------------------------ chorus
for (const mode of ['S', 'C', 'V']) {
  const p = make('neon-chorus', { rate: 0.4, depth: 0.7, mode });
  const r = run(p, 2, pluck(220, 0.3));
  check(finite(r.L) && finite(r.R) && peak(r.L) < 1.5, `Chorus ${mode} finite and bounded`, `peak ${peak(r.L).toFixed(2)}`);
  let diff = 0; for (let i = 0; i < r.L.length; i++) diff += Math.abs(r.L[i] - r.R[i]);
  if (mode === 'C') check(diff > 1, 'Chorus C is stereo');
  else check(diff < 1e-3, `Chorus ${mode} is mono`);
}
{
  // Vibrato: wet-only, so a pure tone should come out frequency modulated
  // (zero-crossing spacing varies) at roughly the input level.
  const r = run(make('neon-chorus', { rate: 0.5, depth: 1, mode: 'V' }), 2, sine(440, 0.2));
  const zc = [];
  for (let i = SR; i < r.L.length; i++) if (r.L[i - 1] < 0 && r.L[i] >= 0) zc.push(i);
  const periods = zc.slice(1).map((z, i) => z - zc[i]);
  const spread = Math.max(...periods) - Math.min(...periods);
  check(spread >= 3, 'Chorus V modulates pitch', `period spread ${spread} samples`);
  const perf = run(make('neon-chorus', { mode: 'C' }), 10, pluck(110, 0.3));
  console.log(`      Chorus CPU: ${cpu(perf)}`);
}

// ------------------------------------------------------------------ wah
{
  for (const mode of ['AUTO', 'LFO', 'FIX']) {
    const r = run(make('neon-wah', { mode, pos: 0.3, sens: 1, rate: 1 }), 2, noise(1));
    check(finite(r.L) && peak(r.L) < 4, `Wah ${mode} stable with full-scale noise`, `peak ${peak(r.L).toFixed(2)}`);
  }
  const gainAt = (pos, f) => {
    const r = run(make('neon-wah', { mode: 'FIX', pos }), 1, sine(f, 0.1));
    return 20 * Math.log10(rms(r.L, SR / 2) / (0.1 / Math.SQRT2));
  };
  const heelLo = gainAt(0, 400), heelHi = gainAt(0, 2200), toeLo = gainAt(1, 400), toeHi = gainAt(1, 2200);
  check(heelLo > heelHi + 10 && toeHi > toeLo + 10, 'Wah FIX sweeps heel (low) to toe (high)',
    `heel: 400 Hz ${heelLo.toFixed(1)} dB / 2.2 kHz ${heelHi.toFixed(1)} dB; toe: 400 Hz ${toeLo.toFixed(1)} dB / 2.2 kHz ${toeHi.toFixed(1)} dB`);
  const dry = pluck(147, 0.3);
  const lv = run(make('neon-wah', { mode: 'FIX', pos: 0.5 }), 2, dry);
  const dryRms = rms(Float32Array.from({ length: 2 * SR }, (_, i) => dry(i)));
  const lvDb = 20 * Math.log10(rms(lv.L) / dryRms);
  check(Math.abs(lvDb) < 8, 'Wah level near unity mid-sweep', `${lvDb.toFixed(1)} dB vs bypass`);
  // AUTO: harder picking should push the sweep further toward the toe.
  const sweepMax = (amp) => {
    const p = make('neon-wah', { mode: 'AUTO', pos: 0, sens: 0.5 });
    let max = 0;
    p.port.postMessage = (m) => { if (m.type === 'pos') max = Math.max(max, m.value); };
    run(p, 1, pluck(147, amp));
    return max;
  };
  const soft = sweepMax(0.03), hard = sweepMax(0.3);
  check(hard > soft + 0.2, 'Wah AUTO follows picking strength', `sweep reached ${soft.toFixed(2)} soft vs ${hard.toFixed(2)} hard`);
  const perf = run(make('neon-wah', { mode: 'AUTO' }), 10, pluck(110, 0.3));
  console.log(`      Wah CPU: ${cpu(perf)}`);

  // NOTE mode: the wah follows the pitch played. Higher notes sit higher, a held note holds its
  // place, it never drops below POSITION (the floor), and it eases back there between phrases.
  const NOTE = { mode: 'NOTE', pos: 0.3, sens: 0.5, rate: 0.55 };
  const held = (f, harm) => (i) => 0.25 * Math.exp(-i / (SR * 1.5)) * harm.reduce((s, a, k) => s + a * Math.sin(2 * Math.PI * f * (k + 1) * i / SR + k * 0.7), 0);
  const posAfter = (f, harm, secs) => { const w = make('neon-wah', NOTE); run(w, secs, held(f, harm)); return w.sweep.v; };
  for (const [tone, harm] of [['neck', [1, 0.5, 0.25, 0.12]], ['bridge', [0.6, 1, 0.8, 0.6, 0.45, 0.3, 0.2]]]) {
    const ladder = [165, 220, 330, 440, 659].map((f) => posAfter(f, harm, 0.8));
    const rising = ladder.every((v, i) => i === 0 || v > ladder[i - 1] + 0.05);
    check(rising && ladder[0] > 0.35, `Wah NOTE: higher notes open it further (${tone} pickup)`, ladder.map((v) => v.toFixed(2)).join(' < '));
  }
  {
    const w = make('neon-wah', NOTE), seen = [];
    const r = run(w, 5, (i) => (i < 2 * SR ? held(440, [1, 0.5, 0.25])(i) : 0), (t) => { seen.push(w.sweep.v); });
    const at = (t) => seen[Math.floor(t * SR / BLOCK)];
    check(Math.abs(at(1.9) - at(0.6)) < 0.03, 'Wah NOTE: a held note holds its place as it rings',
      `${at(0.6).toFixed(2)} at 0.6 s, ${at(1.9).toFixed(2)} at 1.9 s`);
    check(Math.min(...seen) >= 0.3 - 1e-6 && Math.abs(seen[seen.length - 1] - 0.3) < 0.03 && finite(r.L) && peak(r.L) < 2,
      'Wah NOTE: never below POSITION, and back to it after the phrase', `${seen[seen.length - 1].toFixed(2)} 3 s after`);
  }
}

// ------------------------------------------------------------------ fuzz
{
  const dry = pluck(110, 0.2);
  const dryRms = rms(Float32Array.from({ length: 2 * SR }, (_, i) => dry(i)));
  for (const voice of Object.keys(DSP.FUZZ_VOICES)) {
    const hot = run(make('neon-fuzz', { voice, fuzz: 1, volume: 1 }), 1, noise(1));
    check(finite(hot.L) && peak(hot.L) < 4, `Fuzz ${voice} stable with full-scale noise`, `peak ${peak(hot.L).toFixed(2)}`);
    const t = (fuzz, amp) => thd(run(make('neon-fuzz', { voice, fuzz }), 2, sine(196, amp)).L, 196) * 100;
    const lo = t(0, 0.1), hi = t(1, 0.1);
    check(hi > lo * 1.3 && hi > 35, `Fuzz ${voice} FUZZ knob adds fuzz`, `THD fuzz0=${lo.toFixed(0)}% fuzz10=${hi.toFixed(0)}%`);
    // Playing softly (or rolling the guitar's volume back) should clean it up.
    const soft = t(0.5, 0.01), hard = t(0.5, 0.1);
    check(soft < hard / 3, `Fuzz ${voice} cleans up when you play softly`, `THD at FUZZ 5: ${soft.toFixed(1)}% soft vs ${hard.toFixed(0)}% hard`);
    const lv = run(make('neon-fuzz', { voice, fuzz: 0.7, volume: 0.5 }), 2, dry);
    const lvDb = dB(rms(lv.L) / dryRms);
    check(Math.abs(lvDb) < 6, `Fuzz ${voice} level near unity at VOLUME 5`, `${lvDb.toFixed(1)} dB vs bypass`);
  }
  const aFz = inharmonic([make('neon-fuzz', { voice: 'GE', fuzz: 1 })], 2489, 20000);
  check(aFz < -50, 'Fuzz keeps aliasing low', `2.5 kHz note: ${aFz.toFixed(1)} dB vs harmonics`);
  const p = make('neon-fuzz', { voice: 'GE' });
  let k = 0;
  const sw = run(p, 2, pluck(110, 0.2), (tt) => { if (tt >= k * 0.4) { send(p, { type: 'param', name: 'voice', value: k % 2 ? 'SI' : 'GE' }); k++; } });
  let jump = 0; for (let i = 1; i < sw.L.length; i++) jump = Math.max(jump, Math.abs(sw.L[i] - sw.L[i - 1]));
  check(finite(sw.L) && jump < 0.3, 'Fuzz GE/SI switching is click-safe', `max step ${jump.toFixed(3)}`);
  const perf = run(make('neon-fuzz', { fuzz: 0.8 }), 10, pluck(110, 0.3));
  console.log(`      Fuzz CPU: ${cpu(perf)}`);
}

// ------------------------------------------------------------------ vibe
{
  for (const mode of ['CHO', 'VIB']) {
    const r = run(make('neon-vibe', { mode, speed: 1, intensity: 1 }), 2, noise(1));
    check(finite(r.L) && peak(r.L) < 3, `Vibe ${mode} stable with full-scale noise`, `peak ${peak(r.L).toFixed(2)}`);
  }
  // CHORUS: moving notches make a steady tone's level swing up and down.
  const swing = (intensity) => {
    const r = run(make('neon-vibe', { mode: 'CHO', speed: 0.3, intensity }), 3, sine(800, 0.2));
    const w = SR / 100; let lo = Infinity, hi = 0;
    for (let i = SR; i + w <= r.L.length; i += w) { const v = rms(r.L, i, i + w); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return dB(hi / lo);
  };
  const full = swing(1), none = swing(0);
  check(full > 10 && none < 0.5, 'Vibe CHORUS notches sweep; INTENSITY 0 holds still', `800 Hz level swings ${full.toFixed(1)} dB at full, ${none.toFixed(2)} dB at zero`);
  const r = run(make('neon-vibe', { mode: 'VIB', speed: 0.8, intensity: 1 }), 2, sine(440, 0.2)); // ~4 Hz
  const zc = [];
  for (let i = SR; i < r.L.length; i++) if (r.L[i - 1] < 0 && r.L[i] >= 0) zc.push(i);
  const periods = zc.slice(1).map((z, i) => z - zc[i]);
  const spread = Math.max(...periods) - Math.min(...periods);
  check(spread >= 4, 'Vibe VIBRATO wobbles pitch', `period spread ${spread} samples`);
  // The lamp heats faster than it cools: its rise should take less of each cycle than its fall.
  const p = make('neon-vibe', { mode: 'CHO', speed: 0.6, intensity: 1 });
  const lamp = [];
  p.port.postMessage = (m) => { if (m.type === 'pos') lamp.push(m.value); };
  run(p, 4, sine(440, 0.1));
  let up = 0, down = 0;
  for (let i = 1; i < lamp.length; i++) { if (lamp[i] > lamp[i - 1]) up++; else if (lamp[i] < lamp[i - 1]) down++; }
  check(lamp.length > 20 && up < down, 'Vibe lamp rises faster than it falls', `${up} rising vs ${down} falling updates`);
  const perf = run(make('neon-vibe', { intensity: 0.8 }), 10, pluck(110, 0.3));
  console.log(`      Vibe CPU: ${cpu(perf)}`);
}

// ------------------------------------------------------------------ amp
{
  // Tone stack: compare the closed-form transfer function with an independent nodal
  // analysis of the circuit. Topology: Vin-C1-A, A-(1-t)R1-OUT, OUT-tR1-T, T-lR2-M,
  // M-mR3-gnd, Vin-R4-N, N-C2-T, N-C3-M; output unloaded.
  const cx = (re, im = 0) => ({ re, im });
  const add = (a, b) => cx(a.re + b.re, a.im + b.im), sub = (a, b) => cx(a.re - b.re, a.im - b.im);
  const mul = (a, b) => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
  const div = (a, b) => { const d = b.re * b.re + b.im * b.im; return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
  function nodal(c, t, m, l, w) {
    const s = cx(0, w);
    const nodes = ['A', 'W', 'T', 'M', 'N'], idx = Object.fromEntries(nodes.map((k, i) => [k, i]));
    const Y = nodes.map(() => nodes.map(() => cx(0))), I = nodes.map(() => cx(0));
    const elem = (p, q, y) => { // admittance y between nodes p and q ('in' = source node at 1 V, 'g' = ground)
      for (const [x, o] of [[p, q], [q, p]]) {
        if (!(x in idx)) continue;
        Y[idx[x]][idx[x]] = add(Y[idx[x]][idx[x]], y);
        if (o in idx) Y[idx[x]][idx[o]] = sub(Y[idx[x]][idx[o]], y);
        else if (o === 'in') I[idx[x]] = add(I[idx[x]], y);
      }
    };
    const R = (r) => cx(1 / Math.max(r, 1e-3)), Cap = (f) => mul(s, cx(f));
    elem('in', 'A', Cap(c.C1)); elem('A', 'W', R((1 - t) * c.R1)); elem('W', 'T', R(t * c.R1));
    elem('T', 'M', R(l * c.R2)); elem('M', 'g', R(m * c.R3)); elem('in', 'N', R(c.R4));
    elem('N', 'T', Cap(c.C2)); elem('N', 'M', Cap(c.C3));
    // Gaussian elimination with partial pivoting.
    const n = nodes.length, A = Y.map((row, i) => [...row, I[i]]);
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.hypot(A[r][col].re, A[r][col].im) > Math.hypot(A[piv][col].re, A[piv][col].im)) piv = r;
      [A[col], A[piv]] = [A[piv], A[col]];
      for (let r = col + 1; r < n; r++) {
        const f = div(A[r][col], A[col][col]);
        for (let k = col; k <= n; k++) A[r][k] = sub(A[r][k], mul(f, A[col][k]));
      }
    }
    const V = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let acc = A[r][n];
      for (let k = r + 1; k < n; k++) acc = sub(acc, mul(A[r][k], V[k]));
      V[r] = div(acc, A[r][r]);
    }
    return Math.hypot(V[idx.W].re, V[idx.W].im);
  }
  let worst = 0;
  for (const name of Object.keys(DSP.STACKS)) {
    for (const [t, m, l] of [[0.5, 0.5, 0.5], [0.1, 0.9, 0.3], [0.9, 0.1, 0.8], [0.3, 0.6, 0.05]]) {
      for (const f of [50, 150, 400, 1000, 3000, 8000]) {
        const w = 2 * Math.PI * f;
        const a = DSP.fmvMag(DSP.fmvCoeffs(DSP.STACKS[name], t, m, l), w), b = nodal(DSP.STACKS[name], t, m, l, w);
        worst = Math.max(worst, Math.abs(20 * Math.log10(a / b)));
      }
    }
  }
  check(worst < 0.05, 'Amp tone stack matches circuit analysis', `worst difference ${worst.toFixed(4)} dB`);
}
{
  const dry = pluck(110, 0.2);
  const dryRms = rms(Float32Array.from({ length: 2 * SR }, (_, i) => dry(i)));
  for (const voice of Object.keys(DSP.AMP_VOICES)) {
    const hot = run(make('neon-amp', { voice, gain: 1, bass: 1, mid: 1, treble: 1, volume: 1 }), 1, noise(1));
    check(finite(hot.L) && peak(hot.L) < 4, `Amp ${voice} stable at max settings`, `peak ${peak(hot.L).toFixed(2)}`);
    const lo = run(make('neon-amp', { voice, gain: 0.1 }), 1, sine(196, 0.1)), hi = run(make('neon-amp', { voice, gain: 0.9 }), 1, sine(196, 0.1));
    const tLo = thd(lo.L, 196), tHi = thd(hi.L, 196);
    const lv = run(make('neon-amp', { voice, gain: 0.5, volume: 0.5 }), 2, dry);
    const lvDb = 20 * Math.log10(rms(lv.L) / dryRms);
    check(tHi > tLo * 2 && Math.abs(lvDb) < 9, `Amp ${voice} GAIN adds drive; level sane at noon`,
      `THD gain1=${(tLo * 100).toFixed(1)}% gain9=${(tHi * 100).toFixed(1)}%, level ${lvDb.toFixed(1)} dB`);
    const bassy = run(make('neon-amp', { voice, gain: 0.1, bass: 1, treble: 0 }), 1, sine(100, 0.05));
    const bright = run(make('neon-amp', { voice, gain: 0.1, bass: 0, treble: 1 }), 1, sine(100, 0.05));
    check(rms(bassy.L, SR / 2) > rms(bright.L, SR / 2) * 1.5, `Amp ${voice} BASS knob works`);
  }
  // Clean headroom: low GAIN on a hot (-10 dBFS peak) input should stay clean.
  const cleanThd = (voice) => thd(run(make('neon-amp', { voice, gain: 0 }), 2, sine(196, 0.3)).L, 196) * 100;
  const fClean = cleanThd('FENDER'), hClean = cleanThd('HIWATT'), mClean = cleanThd('MESA');
  check(fClean < 1 && hClean < 1.5 && mClean < 1.5, 'Amp GAIN 0 is clean on a hot input', `THD FENDER ${fClean.toFixed(2)}%, HIWATT ${hClean.toFixed(2)}%, MESA ${mClean.toFixed(2)}%`);
  // GAIN at noon on a typical hard-picked peak (-12 dBFS) is edge of breakup, as on the real amps.
  // Too hot here and an overdrive in front turns the amp into square-wave fizz (the SRV bug).
  const noon = (procs) => thd(series(procs, Float32Array.from({ length: 2 * SR }, (_, i) => sine(196, 0.25)(i))).subarray(SR), 196) * 100;
  const nF = noon([make('neon-amp', { voice: 'FENDER' })]), nH = noon([make('neon-amp', { voice: 'HIWATT' })]);
  const nP = noon([make('neon-amp', { voice: 'PLEXI' })]), nM = noon([make('neon-amp', { voice: 'MESA' })]);
  const srv = noon([make('neon-ts', { drive: 0.2, tone: 0.55, level: 0.85 }), make('neon-amp', { voice: 'FENDER', gain: 0.55 })]);
  check(nF < 8 && nH < 10 && nP < 18 && nM < 14 && srv < 30, 'Amp GAIN noon breaks up, but does not fizz with a drive in front',
    `THD at -12 dBFS: FENDER ${nF.toFixed(1)}%, HIWATT ${nH.toFixed(1)}%, PLEXI ${nP.toFixed(1)}%, MESA ${nM.toFixed(1)}%, SRV TS > FENDER ${srv.toFixed(1)}%`);
  // Aliasing: a high lead note through overdrive into a cranked Plexi.
  const aTs = inharmonic([make('neon-ts', { drive: 1 })], 2489, 20000);
  const aChain = inharmonic([make('neon-ts', { drive: 1 }), make('neon-amp', { voice: 'PLEXI', gain: 0.9 })], 2489, 20000);
  check(aTs < -55 && aChain < -45, 'Drive and amp keep aliasing (inharmonic fizz) low',
    `2.5 kHz note: TS ${aTs.toFixed(1)} dB, TS > PLEXI ${aChain.toFixed(1)} dB vs harmonics`);
  const p = make('neon-amp', { voice: 'PLEXI' });
  let k = 0;
  const rv = run(p, 2, pluck(110, 0.2), (t) => { if (t >= k * 0.4) { send(p, { type: 'param', name: 'voice', value: ['PLEXI', 'HIWATT', 'FENDER', 'MESA'][k % 4] }); k++; } });
  check(finite(rv.L), 'Amp voice switching is safe');
  const perf = run(make('neon-amp', { voice: 'PLEXI', gain: 0.8 }), 10, pluck(110, 0.3));
  console.log(`      Amp CPU: ${cpu(perf)}`);
}

// ------------------------------------------------------------------ reverb
const MODES = DSP.RV_MODES;
for (let m = 0; m < MODES.length; m++) {
  const p = make('neon-reverb', { mode: m, level: 0.7, tone: 0.5, time: 0.6 });
  const r = run(p, 12, guitarBurst(GB_AMP, 0.25));
  const early = rms(r.L, Math.floor(0.3 * SR), Math.floor(0.8 * SR));
  const late = rms(r.L, Math.floor(10 * SR), Math.floor(12 * SR));
  // DYNAMIC is still releasing its ducking right after the burst, so its early tail is quieter.
  const ok = finite(r.L) && finite(r.R) && peak(r.L) < 3 && late < early * 0.25 && early > (MODES[m] === 'DYNAMIC' ? 0.002 : 0.005);
  check(ok, `Reverb ${MODES[m]} rings then decays`, `tail ${(20 * Math.log10(early)).toFixed(1)} dBFS -> ${(20 * Math.log10(late + 1e-12)).toFixed(1)} dBFS, peak ${peak(r.L).toFixed(2)}, ${cpu(r)}`);
}
{
  // Measure HALL RT60 from the Schroeder backward integral of an impulse response.
  for (const time of [0, 0.5, 1]) {
    const p = make('neon-reverb', { mode: 1, level: 1, tone: 0.8, time });
    const r = run(p, 12, (i) => (i === 0 ? 1 : 0));
    const e = new Float64Array(r.L.length);
    let acc = 0;
    for (let i = r.L.length - 1; i >= 0; i--) { acc += r.L[i] * r.L[i] + r.R[i] * r.R[i]; e[i] = acc; }
    const db = (i) => 10 * Math.log10(e[i] / e[0]);
    let i5 = 0, i25 = 0;
    while (i5 < e.length && db(i5) > -5) i5++;
    while (i25 < e.length && db(i25) > -25) i25++;
    const rt = 3 * (i25 - i5) / SR;
    const want = 0.9 * Math.pow(8 / 0.9, time);
    check(rt > want * 0.5 && rt < want * 1.5, `Reverb HALL TIME ${time * 10}: RT60 ≈ ${rt.toFixed(2)} s`, `(target ${want.toFixed(2)} s, high-cut shortens it)`);
  }
}
{
  // DYNAMIC: the wet signal (output minus dry) should swell once playing stops.
  const gen = burst(0.3, 2);
  const input = Float32Array.from({ length: 4 * SR }, (_, i) => gen(i));
  let j = 0;
  const r = run(make('neon-reverb', { mode: 7, level: 0.7, time: 0.6 }), 4, () => input[j++] || 0);
  const wet = r.L.map((v, i) => v - (input[i] || 0));
  const playing = rms(wet, 1.5 * SR, 2 * SR), after = rms(wet, 2.15 * SR, 2.6 * SR);
  check(after > playing, 'Reverb DYNAMIC blooms when you stop playing', `wet while playing ${(20 * Math.log10(playing)).toFixed(1)} dBFS, after ${(20 * Math.log10(after)).toFixed(1)} dBFS`);
}
{
  // Shimmer has feedback through a pitch shifter: drive it hard for a long time.
  const r = run(make('neon-reverb', { mode: 6, level: 1, tone: 1, time: 1 }), 30, burst(0.8, 10));
  const during = rms(r.L, 8 * SR, 10 * SR), after = rms(r.L, 28 * SR, 30 * SR);
  check(finite(r.L) && peak(r.L) < 4 && after < during, 'Reverb SHIMMER max settings stays stable', `peak ${peak(r.L).toFixed(2)}, last 2 s ${(20 * Math.log10(after + 1e-12)).toFixed(1)} dBFS`);
}
{
  // Mode/param changes mid-signal must not produce NaNs or big clicks.
  const p = make('neon-reverb', { mode: 0, level: 0.6 });
  let m = 0;
  const r = run(p, 9, pluck(147, 0.3), (t) => {
    if (t >= m + 1) { m++; send(p, { type: 'param', name: 'mode', value: m % 8 }); send(p, { type: 'param', name: 'time', value: (m % 3) / 2 }); }
  });
  let jump = 0; for (let i = 1; i < r.L.length; i++) jump = Math.max(jump, Math.abs(r.L[i] - r.L[i - 1]));
  check(finite(r.L) && jump < 0.5, 'Reverb mode switching is click-safe', `max step ${jump.toFixed(3)}`);
  const c = make('neon-chorus', { mode: 'S' });
  let k = 0;
  const rc = run(c, 3, sine(220, 0.3), (t) => { if (t >= k * 0.25) { send(c, { type: 'param', name: 'mode', value: 'SCV'[k % 3] }); k++; } });
  let cj = 0; for (let i = 1; i < rc.L.length; i++) cj = Math.max(cj, Math.abs(rc.L[i] - rc.L[i - 1]));
  check(finite(rc.L) && cj < 0.2, 'Chorus mode switching is click-safe', `max step ${cj.toFixed(3)}`);
}
{
  // Bypass: dry passes untouched, and an existing tail keeps ringing (spillover).
  const p = make('neon-reverb', { mode: 1, level: 0.7, time: 0.7 });
  const r = run(p, 3, burst(0.3, 0.2), (t) => { if (t >= 0.5 && p.engaged) send(p, { type: 'engaged', value: false }); });
  check(rms(r.L, 1.0 * SR, 1.5 * SR) > 1e-3, 'Reverb tail rings out after bypass');
}
// ------------------------------------------------------------------ tremolo
{
  // Full depth: the level swings from the input's peak down to near silence at RATE, never above.
  const env = (a) => { const w = Math.round(SR * 0.004), out = []; for (let i = 0; i + w <= a.length; i += w) out.push(rms(a, i, i + w)); return out; };
  for (const wave of ['SINE', 'OPTO', 'SQR']) {
    const r = run(make('neon-trem', { rate: 0.45, depth: 1, wave }), 3, sine(1000, 0.3));
    const e = env(r.L).slice(50), hi = Math.max(...e), lo = Math.min(...e);
    const mean = e.reduce((s, v) => s + v, 0) / e.length;
    const ups = []; for (let i = 1; i < e.length; i++) if (e[i - 1] < mean && e[i] >= mean) ups.push(i);
    const hz = (ups.length - 1) / ((ups[ups.length - 1] - ups[0]) * 0.004), want = 1.5 * Math.pow(8, 0.45);
    check(finite(r.L) && peak(r.L) <= 0.3 + 1e-6 && lo < hi * 0.06 && Math.abs(hz - want) / want < 0.06,
      `Tremolo ${wave}: full-depth swing at RATE, never louder than the input`,
      `${dB(lo / hi).toFixed(0)} dB dips, ${hz.toFixed(2)} Hz (want ${want.toFixed(2)}), peak ${peak(r.L).toFixed(3)}`);
  }
}
{
  const p = make('neon-trem', { rate: 0.6, depth: 1, wave: 'SINE' });
  let k = 0;
  const r = run(p, 3, sine(220, 0.3), (t) => { if (t >= k * 0.2) { send(p, { type: 'param', name: 'wave', value: ['SINE', 'SQR', 'OPTO'][k % 3] }); k++; } });
  let j = 0; for (let i = 1; i < r.L.length; i++) j = Math.max(j, Math.abs(r.L[i] - r.L[i - 1]));
  check(finite(r.L) && j < 0.02, 'Tremolo shape switching is click-safe', `max step ${j.toFixed(4)} (the sine alone steps ${(2 * Math.PI * 220 / SR * 0.3).toFixed(4)})`);
}

// ------------------------------------------------------------------ compressor
{
  // A 20 dB spread of input levels comes out much narrower, more so with more SUSTAIN.
  const out = (sus, amp) => dB(rms(run(make('neon-comp', { sustain: sus, blend: 1 }), 1, sine(440, amp)).L, SR / 2) / (amp / Math.SQRT2)) + dB(amp / Math.SQRT2);
  const spread = (sus) => out(sus, 0.3) - out(sus, 0.03);
  const s0 = spread(0), s5 = spread(0.5), s10 = spread(1);
  check(s0 < 18 && s5 < 6 && s10 < 3 && s10 < s5 && s5 < s0, 'Compressor narrows a 20 dB spread, more with SUSTAIN',
    `out spread ${s0.toFixed(1)} / ${s5.toFixed(1)} / ${s10.toFixed(1)} dB at SUSTAIN 0 / 5 / 10`);
  // Default knobs: a picked note comes out near bypass level, and its tail holds up longer.
  const note = pluck(196, 0.3), dry = Float32Array.from({ length: 2 * SR }, (_, i) => note(i));
  const r = run(make('neon-comp', {}), 2, note);
  const lv = dB(rms(r.L) / rms(dry));
  const decay = (a) => dB(rms(a, 1.2 * SR, 1.4 * SR) / rms(a, 0.02 * SR, 0.2 * SR));
  check(finite(r.L) && Math.abs(lv) < 2 && decay(r.L) > decay(dry) + 6, 'Compressor at noon matches bypass level and adds sustain',
    `${lv.toFixed(1)} dB vs bypass; tail ${decay(dry).toFixed(1)} → ${decay(r.L).toFixed(1)} dB`);
  // Everything up, a full-scale input: bounded, no NaN.
  const ex = run(make('neon-comp', { sustain: 1, level: 1, blend: 1 }), 1, (i) => (i % 9973 < 5000 ? Math.sin(i * 0.05) : 0.001 * Math.sin(i * 0.05)));
  check(finite(ex.L) && peak(ex.L) <= 1, 'Compressor stays bounded at extreme settings', `peak ${peak(ex.L).toFixed(3)}`);
  // Knob moves while playing don't click.
  const p = make('neon-comp', {});
  let k = 0;
  const rm = run(p, 3, sine(220, 0.3), (t) => { if (t >= k * 0.15) { const v = k % 2; send(p, { type: 'param', name: ['sustain', 'level', 'blend'][k % 3], value: v }); k++; } });
  let j = 0; for (let i = SR / 2; i < rm.L.length; i++) j = Math.max(j, Math.abs(rm.L[i] - rm.L[i - 1]));
  check(finite(rm.L) && j < 0.12, 'Compressor knob moves are click-safe', `max step ${j.toFixed(3)}`);
  // A fresh pick comes out no hotter than the note it starts, relative to the input (no make-up
  // spike before the gain clamps down), and stays off the ceiling. 2026-11-15 review, finding 1.
  const onset = (params, amp) => {
    // Sized to the whole blocks run() renders (at 44.1 kHz one second is 44,160 samples, and reading
    // past a 44,100-long input fed NaN into the last block).
    const nt = pluck(110, amp), inp = Float32Array.from({ length: Math.ceil(SR / BLOCK) * BLOCK }, (_, i) => nt(i));
    const o = run(make('neon-comp', params), 1, (i) => inp[i]).L;
    const pk = (a) => peak(a.subarray(0, 0.01 * SR));
    const over = dB(pk(o) / pk(inp)) - dB(rms(o, 0.3 * SR, 0.5 * SR) / rms(inp, 0.3 * SR, 0.5 * SR));
    return { over, hot: o.some((v) => Math.abs(v) > 0.9), ok: finite(o) };
  };
  const firm = onset({}, 0.3), soft = onset({ sustain: 1, blend: 1 }, 0.05);
  check(firm.ok && soft.ok && firm.over < 2 && soft.over < 4 && !firm.hot && !soft.hot, 'Compressor pick onset does not spike',
    `onset over steady ${firm.over.toFixed(1)} dB firm at noon, ${soft.over.toFixed(1)} dB soft at SUSTAIN 10`);
  // Switching off while playing crossfades without a click.
  const xp = make('neon-comp', { sustain: 1, level: 1, blend: 1 });
  const rx = run(xp, 1, sine(220, 0.1), (t) => { if (t >= 0.5 && xp.engaged) send(xp, { type: 'engaged', value: false }); });
  let jx = 0; for (let i = 0.3 * SR; i < rx.L.length; i++) jx = Math.max(jx, Math.abs(rx.L[i] - rx.L[i - 1]));
  check(finite(rx.L) && jx < 0.12, 'Compressor switching off while playing is click-safe', `max step ${jx.toFixed(3)}`);
  // Different left and right signals, and a NaN/Infinity sample on the way in: both channels get
  // the same gain, and the pedal recovers at once instead of latching on NaN.
  const lr = (bad) => {
    const pr = make('neon-comp', { blend: 1 }), N = Math.ceil(SR / 2 / BLOCK) * BLOCK, oL = new Float32Array(N), oR = new Float32Array(N), gL = [], gR = [];
    const a = new Float32Array(BLOCK), b = new Float32Array(BLOCK), x = new Float32Array(BLOCK), y = new Float32Array(BLOCK);
    for (let s = 0; s < N; s += BLOCK) {
      for (let i = 0; i < BLOCK; i++) { a[i] = sine(220, 0.3)(s + i); b[i] = sine(330, 0.05)(s + i); }
      if (bad && s === 0.1 * SR - (0.1 * SR) % BLOCK) { a[3] = NaN; b[7] = Infinity; }
      pr.process([[a, b]], [[x, y]]); oL.set(x, s); oR.set(y, s);
      for (let i = 0; i < BLOCK; i++) if (s > 0.3 * SR && Math.abs(a[i]) > 0.1 && Math.abs(b[i]) > 0.02) { gL.push(x[i] / a[i]); gR.push(y[i] / b[i]); }
    }
    return { oL, oR, d: Math.max(...gL.map((g, i) => Math.abs(g - gR[i]))) };
  };
  const clean = lr(false), hit = lr(true);
  let nd = 0; for (let i = 0.2 * SR; i < clean.oL.length; i++) nd = Math.max(nd, Math.abs(hit.oL[i] - clean.oL[i]), Math.abs(hit.oR[i] - clean.oR[i]));
  check(clean.d < 1e-4, 'Compressor applies one gain to different left and right signals', `max gain difference ${clean.d.toExponential(1)}`);
  check(finite(hit.oL.subarray(0.11 * SR)) && finite(hit.oR.subarray(0.11 * SR)) && nd < 0.01, 'Compressor recovers from a NaN or Infinity input sample',
    `max difference from a clean twin ${nd.toFixed(4)} after 0.2 s`);
}

// ------------------------------------------------------------------ octave
{
  // Energy at a frequency over a window (Goertzel), for comparing the octave with the note.
  const amp = (a, f, from, to) => Math.sqrt(Math.max(0, tonePower(a, f, from, to))) / (to - from);
  const from = Math.floor(0.2 * SR), to = SR;
  let worst1 = Infinity, worst2 = Infinity;
  for (const f of [82.4, 110, 196, 330, 494, 660]) {
    const note = (i) => 0.2 * Math.exp(-i / (SR * 0.8)) * (Math.sin(2 * Math.PI * f * i / SR) + 0.5 * Math.sin(4 * Math.PI * f * i / SR) + 0.25 * Math.sin(6 * Math.PI * f * i / SR));
    const o1 = run(make('neon-octave', { direct: 0, oct1: 1, oct2: 0 }), 1, note).L;
    worst1 = Math.min(worst1, dB(amp(o1, f / 2, from, to) / amp(o1, f, from, to)));
    if (f >= 110) {
      const o2 = run(make('neon-octave', { direct: 0, oct1: 0, oct2: 1 }), 1, note).L;
      worst2 = Math.min(worst2, dB(amp(o2, f / 4, from, to) / amp(o2, f / 2, from, to)));
    }
  }
  check(worst1 > 30 && worst2 > 20, 'Octave tracks one and two octaves down, low E to the 12th fret',
    `OCT 1 sub over the note by at least ${worst1.toFixed(1)} dB, OCT 2 over OCT 1 by ${worst2.toFixed(1)} dB`);
  // Polarity flips only at zero crossings, so at unity level the sub-octave is never steeper than
  // the note itself (a flip away from zero would jump by up to twice the note's peak).
  const maxStep = (a) => { let m = 0; for (let i = 1; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1])); return m; };
  const dryStep = maxStep(Float32Array.from({ length: 2 * SR }, (_, i) => pluck(110, 0.3)(i)));
  const sub = run(make('neon-octave', { direct: 0, oct1: 0.7, oct2: 0 }), 2, pluck(110, 0.3)).L;
  const sub2 = run(make('neon-octave', { direct: 0, oct1: 0, oct2: 0.7 }), 2, pluck(110, 0.3)).L;
  const js = Math.max(maxStep(sub), maxStep(sub2)) / dryStep;
  check(finite(sub) && finite(sub2) && js < 1, 'Octave flips are click-free', `steepest step ${js.toFixed(2)}x the dry note's`);
  const ex = run(make('neon-octave', { direct: 1, oct1: 1, oct2: 1 }), 1, noise(1));
  check(finite(ex.L) && peak(ex.L) <= 1, 'Octave stays bounded at extreme settings', `peak ${peak(ex.L).toFixed(3)}`);
  // Knobs jump between 3 and 7 every 0.2 s while a note rings. All three at 7 is about 3x unity in
  // total, so a smooth output stays under ~3x the dry note's steepest step; an unsmoothed gain jump
  // or a flip away from zero goes well past it (review 2026-11-22, finding 2).
  const p = make('neon-octave', {});
  let k = 0;
  const rm = run(p, 2, pluck(110, 0.2), (t) => { if (t >= k * 0.2) { send(p, { type: 'param', name: ['direct', 'oct1', 'oct2'][k % 3], value: k % 2 ? 0.7 : 0.3 }); k++; } });
  const jm = maxStep(rm.L) / (dryStep * 0.2 / 0.3);
  check(finite(rm.L) && jm < 3.2, 'Octave knob moves are click-safe', `steepest step ${jm.toFixed(2)}x the dry note's`);
  // A fading high note: once the detector loses it, the octaves fade out instead of the note
  // coming through at its own pitch from a frozen flip-flop (finding 3).
  const hiNote = (i) => 0.2 * Math.exp(-i / (SR * 0.5)) * Math.sin(2 * Math.PI * 1047 * i / SR);
  const fade = run(make('neon-octave', { direct: 0, oct1: 0.7, oct2: 0.7 }), 4, hiNote).L;
  const tail = rms(fade, 2 * SR, 4 * SR), early = rms(fade, Math.round(0.2 * SR), SR);
  check(early > 1e-3 && tail < 1e-6, 'Octave fades out under a dying high note (no unison copy)',
    `octaves ${dB(early).toFixed(0)} dB while tracking, ${dB(tail).toFixed(0)} dB once lost (input -49 to -66 dBFS)`);
  // A NaN or a huge sample is ignored, so neither latches the filters or the detector (finding 6).
  const twin = run(make('neon-octave', {}), 1, pluck(110, 0.2)).L;
  const hit = run(make('neon-octave', {}), 1, (i) => (i === 1000 ? NaN : i === 2000 ? 1e30 : pluck(110, 0.2)(i))).L;
  const nd = hit.subarray(0.3 * SR).reduce((m, v, i) => Math.max(m, Math.abs(v - twin[0.3 * SR + i])), 0);
  check(finite(hit.subarray(0.3 * SR)) && nd < 0.01, 'Octave recovers from a NaN or huge input sample', `max difference from a clean twin ${nd.toFixed(4)} after 0.3 s`);
}

// ------------------------------------------------------------------ tape echo
{
  // One click in: repeats arrive TIME apart (give or take the tape's wow), each quieter than the last.
  const p = make('neon-echo', { time: 0.5, repeats: 0.5, mix: 1 });
  const r = run(p, 1.2, (i) => (i < 48 ? 0.5 : 0));
  const want = 0.06 * Math.pow(12.5, 0.5);
  const peakNear = (t) => { let m = 0, at = 0; for (let i = Math.round((t - 0.02) * SR); i < (t + 0.02) * SR; i++) if (Math.abs(r.L[i]) > m) { m = Math.abs(r.L[i]); at = i; } return [m, at / SR]; };
  const [p1, t1] = peakNear(want), [p2, t2] = peakNear(2 * want), [p3] = peakNear(3 * want);
  check(Math.abs(t1 - want) < 0.004 && Math.abs(t2 - t1 - want) < 0.004 && p1 > p2 && p2 > p3 && p3 > 0.01,
    'Tape echo: repeats TIME apart, each one quieter', `${(t1 * 1000).toFixed(1)} / ${(t2 * 1000).toFixed(1)} ms (want ${(want * 1000).toFixed(1)}), peaks ${p1.toFixed(3)} > ${p2.toFixed(3)} > ${p3.toFixed(3)}`);
}
{
  // REPEATS flat out with a loud input for 10 s: the tape saturates instead of running away, and
  // the repeats still die away once the playing stops.
  const r = run(make('neon-echo', { time: 0.3, repeats: 1, mix: 1 }), 30, burst(0.8, 10));
  const during = rms(r.L, 8 * SR, 10 * SR), after = rms(r.L, 28 * SR, 30 * SR);
  check(finite(r.L) && peak(r.L) < 2.5 && after < during * 0.1, 'Tape echo at full REPEATS stays stable and dies away',
    `peak ${peak(r.L).toFixed(2)}, last 2 s ${dB(after).toFixed(1)} dBFS vs ${dB(during).toFixed(1)} while playing`);
}
{
  // Sweeping TIME while it repeats glides (pitch-bends) instead of clicking.
  const p = make('neon-echo', { time: 0.3, repeats: 0.6, mix: 0.8 });
  let k = 0;
  const r = run(p, 6, pluck(196, 0.3), (t) => { if (t >= k * 0.5) { send(p, { type: 'param', name: 'time', value: [0.1, 0.9, 0.4, 0][k % 4] }); k++; } });
  let j = 0; for (let i = 1; i < r.L.length; i++) j = Math.max(j, Math.abs(r.L[i] - r.L[i - 1]));
  check(finite(r.L) && j < 0.25, 'Tape echo TIME changes are click-safe', `max step ${j.toFixed(3)}`);
  // Bypass: dry untouched from the start; repeats already on the tape ring out.
  // Playing until 0.5 s, bypassed at 0.3 s: the repeats of what went onto the tape before 0.3 s
  // carry on after the playing stops.
  const e = make('neon-echo', { time: 0.4, repeats: 0.5, mix: 0.6 });
  const re = run(e, 1, burst(0.3, 0.5), (t) => { if (t >= 0.3 && e.engaged) send(e, { type: 'engaged', value: false }); });
  const tail = rms(re.L, 0.52 * SR, 0.62 * SR);
  check(tail > 1e-3, 'Tape echo repeats ring out after bypass', `${dB(tail).toFixed(1)} dBFS just after the playing stops`);
}
// ------------------------------------------------------------------ phaser
{
  // A 500 Hz tone through a slow sweep: a notch passes through it (deep dips), and SCRIPT
  // (no feedback) never makes it louder than it went in.
  const env = (a) => { const w = Math.round(SR * 0.004), out = []; for (let i = 0; i + w <= a.length; i += w) out.push(rms(a, i, i + w)); return out; };
  const r = run(make('neon-phaser', { speed: 0.3, mode: 'SCRIPT' }), 8, sine(500, 0.3));
  const e = env(r.L).slice(100), hi = Math.max(...e), lo = Math.min(...e);
  check(finite(r.L) && peak(r.L) <= 0.3 * 1.01 && lo < hi * 0.1, 'Phaser SCRIPT: a notch sweeps through, no gain',
    `${dB(lo / hi).toFixed(0)} dB dips, peak ${peak(r.L).toFixed(3)} for a 0.300 input`);
  const b = run(make('neon-phaser', { speed: 1, mode: 'BLOCK' }), 10, burst(0.8, 8));
  check(finite(b.L) && peak(b.L) < 2, 'Phaser BLOCK (feedback) at full speed stays stable', `peak ${peak(b.L).toFixed(2)}`);
}
{
  const p = make('neon-phaser', { speed: 0.5, mode: 'SCRIPT' });
  let k = 0;
  const r = run(p, 3, sine(220, 0.3), (t) => { if (t >= k * 0.25) { send(p, { type: 'param', name: 'mode', value: k % 2 ? 'BLOCK' : 'SCRIPT' }); k++; } });
  let j = 0; for (let i = 1; i < r.L.length; i++) j = Math.max(j, Math.abs(r.L[i] - r.L[i - 1]));
  check(finite(r.L) && j < 0.05, 'Phaser SCRIPT/BLOCK switching is click-safe', `max step ${j.toFixed(4)}`);
}

// ------------------------------------------------------------------ flanger
{
  // Held still (DEPTH 0), it is a comb filter: a tone at 1/(2 x delay) cancels, at 1/delay it
  // comes through at full level. MANUAL 0.5 = 0.5 ms x 12^0.5 = 1.73 ms.
  const d = 0.0005 * Math.pow(12, 0.5);
  const level = (f) => { const r = run(make('neon-flanger', { manual: 0.5, depth: 0, rate: 0.3, res: 0 }), 0.5, sine(f, 0.3)); return rms(r.L, SR * 0.25, SR * 0.5) / (0.3 / Math.SQRT2); };
  const cut = level(1 / (2 * d)), pass = level(1 / d);
  check(cut < 0.05 && Math.abs(pass - 1) < 0.05, 'Flanger: comb notch and peak where the delay puts them',
    `${(1 / (2 * d)).toFixed(0)} Hz ${dB(cut).toFixed(1)} dB, ${(1 / d).toFixed(0)} Hz ${dB(pass).toFixed(1)} dB`);
}
{
  const r = run(make('neon-flanger', { manual: 0.2, depth: 1, rate: 1, res: 1 }), 30, burst(0.8, 10));
  const during = rms(r.L, 8 * SR, 10 * SR), after = rms(r.L, 28 * SR, 30 * SR);
  check(finite(r.L) && peak(r.L) < 3 && after < during * 0.01, 'Flanger at full RES stays stable and goes quiet after',
    `peak ${peak(r.L).toFixed(2)}, last 2 s ${dB(after).toFixed(1)} dBFS`);
  const p = make('neon-flanger', { manual: 0.5, depth: 0.7, rate: 0.4, res: 0.6 });
  let k = 0;
  const rm = run(p, 4, pluck(196, 0.3), (t) => { if (t >= k * 0.5) { send(p, { type: 'param', name: 'manual', value: k % 2 }); k++; } });
  let j = 0; for (let i = 1; i < rm.L.length; i++) j = Math.max(j, Math.abs(rm.L[i] - rm.L[i - 1]));
  check(finite(rm.L) && j < 0.3, 'Flanger MANUAL moves are click-safe', `max step ${j.toFixed(3)}`);
}
{
  // Full default chain, the way the app wires it, for a CPU budget.
  const chain = [make('neon-input', { hum: 60, gate: -65 }), make('neon-comp'), make('neon-octave'), make('neon-wah'), make('neon-fuzz', { fuzz: 0.8 }),
    make('neon-ts', { drive: 0.5 }), make('neon-vibe'), make('neon-phaser'), make('neon-flanger'), make('neon-amp', { gain: 0.8 }),
    make('neon-chorus', { mode: 'C' }), make('neon-trem'), make('neon-echo'), make('neon-reverb', { mode: 6 })];
  const secs = 10, total = secs * SR;
  const bufs = Array.from({ length: chain.length + 1 }, () => [new Float32Array(BLOCK), new Float32Array(BLOCK)]);
  const g = pluck(98, 0.3);
  const t0 = process.hrtime.bigint();
  for (let s = 0; s < total; s += BLOCK) {
    for (let i = 0; i < BLOCK; i++) bufs[0][0][i] = bufs[0][1][i] = g(s + i);
    chain.forEach((p, i) => p.process([bufs[i]], [bufs[i + 1]]));
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const pct = ms / (secs * 1000) * 100;
  check(pct < 35, 'Full chain (input + all thirteen pedals) fits the real-time budget', `${pct.toFixed(1)}% of one core (${(ms / (total / BLOCK) * 1000).toFixed(0)} µs per 128-sample block, budget ${(BLOCK / SR * 1e6).toFixed(0)} µs)`);
}
{
  // Pickup selector: a neck and a bridge pickup must still sound different through drive. Synthetic
  // string plucked at 1/5 of the scale; harmonic n is picked up in proportion to sin(n*pi*d/L), with
  // the pickup d/L from the bridge (neck 0.25, bridge 0.06), then a loaded pickup resonance. Too much
  // gain in the first stage squares both into the same wave (the "selector does nothing" bug).
  const lp2 = (f, q) => { const w = 2 * Math.PI * f / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0; let z1 = 0, z2 = 0;
    return (x) => { const y = b0 * x + z1; z1 = b1 * x - a1 * y + z2; z2 = b0 * x - a2 * y; return y; }; };
  const pickup = (pos, resHz) => {
    const N = 2 * SR, out = new Float32Array(N), res = lp2(resHz, 2);
    for (let n = 1; 110 * n < 12000; n++) {
      const a = 0.25 * Math.sin(n * Math.PI * 0.2) / (n * n) * Math.sin(n * Math.PI * pos) * 4, tau = 1.2 / Math.sqrt(n);
      for (let i = 0; i < N; i++) out[i] += a * Math.exp(-i / SR / tau) * Math.sin(2 * Math.PI * 110 * n * i / SR);
    }
    return out.map(res);
  };
  const neck = pickup(0.25, 3200), bridge = pickup(0.06, 4200);
  const g = 0.32 / peak(neck);
  neck.forEach((v, i) => { neck[i] = v * g; bridge[i] *= g; });
  const tone = (a) => { const hp = 1 - Math.exp(-2 * Math.PI * 1000 / SR); let lp = 0, hi = 0, all = 0;
    for (const v of a) { lp += (v - lp) * hp; hi += (v - lp) ** 2; all += v * v; } return [10 * Math.log10(hi / all), 10 * Math.log10(all)]; };
  const diff = (mkProcs) => { const [nb, nl] = tone(series(mkProcs(), neck)), [bb, bl] = tone(series(mkProcs(), bridge)); return [bb - nb, bl - nl]; };
  const [ab, al] = diff(() => [make('neon-amp', { voice: 'PLEXI', gain: 0.7 })]);
  const [fb, fl] = diff(() => [make('neon-fuzz', { voice: 'GE', fuzz: 0.3 })]);
  check(ab > 2 && al < -3 && fb > 1 && fl < -3, 'Pickup selector still matters through drive',
    `bridge vs neck: PLEXI GAIN 7 ${ab.toFixed(1)} dB brighter, ${al.toFixed(1)} dB level; GE FUZZ 3 ${fb.toFixed(1)} dB brighter, ${fl.toFixed(1)} dB level`);
}
{
  // Behind a closed gate every pedal sees exact zeros. Decaying filter states must not turn
  // into denormals, which once made the TS and amp ~5x slower and choked the audio thread.
  const cost = (p, secs, gen) => { const t0 = process.hrtime.bigint(); run(p, secs, gen); return Number(process.hrtime.bigint() - t0); };
  for (const [name, params] of [['neon-input', { gate: -60 }], ['neon-comp', { sustain: 1 }], ['neon-octave', { oct2: 1 }], ['neon-wah', {}], ['neon-fuzz', {}], ['neon-ts', {}],
    ['neon-vibe', {}], ['neon-chorus', {}], ['neon-trem', {}], ['neon-echo', { repeats: 0.8 }], ['neon-phaser', { mode: 'BLOCK' }], ['neon-flanger', { res: 0.8 }], ['neon-amp', { voice: 'FENDER' }], ['neon-reverb', { mode: 3 }]]) {
    const p = make(name, params);
    const playing = cost(p, 2, pluck(110, 0.3));
    cost(p, 10, () => 0);
    const silent = cost(p, 2, () => 0);
    check(silent < playing * 1.5, `${name} stays cheap in silence (no denormal slowdown)`, `${(silent / playing).toFixed(2)}x the cost of playing`);
  }
}
{
  // The whole board is always loaded, so a bypassed pedal must go idle (cost next to nothing)
  // once its output has settled to the dry signal, and stay exact while idle.
  const cost = (p, secs, gen) => { const t0 = process.hrtime.bigint(); const r = run(p, secs, gen); return [Number(process.hrtime.bigint() - t0), r]; };
  const allTypes = ['neon-comp', 'neon-octave', 'neon-wah', 'neon-fuzz', 'neon-ts', 'neon-vibe', 'neon-phaser', 'neon-flanger', 'neon-amp', 'neon-chorus', 'neon-trem', 'neon-echo', 'neon-reverb'];
  // The signal is computed once up front, so the timing measures the pedals, not the test signal
  // (generating it per sample was most of the idle figure and pushed it toward the limit).
  const sigIn = Float32Array.from({ length: Math.ceil(SR / BLOCK) * BLOCK }, (_, i) => pluck(110, 0.3)(i));
  const gen = (i) => sigIn[i];
  let on = 0, off = 0, exact = true;
  for (const name of allTypes) {
    on += cost(make(name, {}), 1, gen)[0];
    const [t, r] = cost(make(name, {}, false), 1, gen);
    off += t;
    exact = exact && r.L.every((v, i) => v === sigIn[i]);
  }
  check(off < on * 0.2 && exact, 'Bypassed pedals idle: dry passes exactly, at a fraction of the cost',
    `all 13 bypassed cost ${(off / on * 100).toFixed(1)}% of all 13 engaged`);

  // A reverb switched off mid-tail keeps ringing, then idles; switched back on into silence,
  // it must not replay the old tail it stopped with.
  const rv = make('neon-reverb', { mode: 1, level: 0.8, time: 1 });
  run(rv, 0.5, burst(0.3, 0.3));
  send(rv, { type: 'engaged', value: false });
  const ring = run(rv, 1, () => 0);
  check(rms(ring.L, 0, 0.3 * SR) > 1e-3, 'Reverb tail still spills over after bypass');
  run(rv, 30, () => 0);
  // Time process() alone: the run() harness's own signal generation would swamp an idle pedal.
  const blockCost = (p, secs) => {
    const a = Float32Array.from({ length: BLOCK }, (_, i) => 0.2 * Math.sin(i / 7)), o = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    const t0 = process.hrtime.bigint();
    for (let b = 0; b < secs * SR / BLOCK; b++) p.process([[a, a]], [o]);
    return Number(process.hrtime.bigint() - t0);
  };
  const idleCost = blockCost(rv, 2);
  send(rv, { type: 'engaged', value: true });
  const back = run(rv, 1, () => 0);
  const liveCost = blockCost(rv, 2);
  check(idleCost < liveCost * 0.2, 'Reverb goes idle once its tail has died away', `${(idleCost / liveCost * 100).toFixed(1)}% of engaged cost`);
  check(peak(back.L) < 1e-3, 'Reverb switched back on does not replay an old tail', `${dB(peak(back.L)).toFixed(1)} dBFS`);

  // Going idle must be inaudible: a bypassed echo and reverb ring out the same as twins that
  // are never allowed to idle, all the way down.
  for (const [name, params] of [['neon-echo', { time: 0.9, repeats: 0.7, mix: 0.6 }], ['neon-reverb', { mode: 6, level: 1, time: 1 }]]) {
    const a = make(name, params), b = make(name, params);
    const note = pluck(220, 0.3), play = (i) => (i < 0.3 * SR ? note(i) : 0), off = (p) => (t) => { if (t >= 0.4 && p.engaged) send(p, { type: 'engaged', value: false }); };
    const ra = run(a, 25, play, off(a));
    const rb = run(b, 25, play, (t) => { off(b)(t); b.quiet = 0; });
    let d = 0; for (let i = 0; i < ra.L.length; i++) d = Math.max(d, Math.abs(ra.L[i] - rb.L[i]));
    check(d < 2e-5 && a.quiet >= SR, `${name} going idle after bypass is inaudible`, `max difference ${dB(d).toFixed(0)} dBFS`);
  }

  // Waking from idle: a preset sends new params, then switches the pedal on. Nothing ran while it
  // was idle, so every knob must land on its new value at once (no glide from the old one: an echo
  // TIME glide bends the first repeats), and delay lines must not replay audio from when it idled.
  const SNAP = { 'neon-echo': { time: 0.1, repeats: 0.6, mix: 0.6 }, 'neon-chorus': { rate: 0.9, depth: 0.9 },
    'neon-flanger': { manual: 0.9, depth: 0.1, rate: 0.9, res: 0.9 }, 'neon-ts': { level: 0.9, drive: 0.9 },
    'neon-trem': { wave: 'SQR', rate: 0.9, depth: 0.9 }, 'neon-amp': { volume: 0.9, voice: 'HIWATT' },
    'neon-reverb': { level: 0.9, mode: 6 }, 'neon-vibe': { speed: 0.9, intensity: 0.2 }, 'neon-phaser': { speed: 0.9, mode: 'BLOCK' },
    'neon-fuzz': { volume: 0.9, voice: 'SI' }, 'neon-wah': { pos: 0.9, mode: 'FIX' },
    'neon-comp': { sustain: 0.9, level: 0.9, blend: 0.2 }, 'neon-octave': { direct: 0.2, oct1: 0.9, oct2: 0.9 } };
  const smoothers = (p) => { const out = []; const seen = new Set();
    const walk = (o, d) => { if (!o || typeof o !== 'object' || d > 4 || seen.has(o) || ArrayBuffer.isView(o)) return; seen.add(o);
      if (o.constructor && o.constructor.name === 'Smoother') { if (o !== p.mix) out.push(o); return; }
      for (const k of Object.keys(o)) if (k !== 'port') walk(o[k], d + 1); };
    walk(p, 0); return out; };
  // Play, bypass, keep playing (it idles on a live signal too), stop, then a preset's params and the
  // switch-on, into silence. `never` = a twin that is never allowed to idle: the reference.
  // The woken pedal stays silent until it has really gone idle (a reverb tail takes ~10 s); the twin
  // waits exactly as long.
  const wakeRun = (name, params, never, wait) => {
    const p = make(name, {});
    const hold = never ? () => { p.quiet = 0; } : undefined;
    run(p, 0.5, pluck(196, 0.3), hold);
    send(p, { type: 'engaged', value: false });
    run(p, 2, pluck(196, 0.3), hold);
    let waited = 0;
    while (wait ? waited < wait : p.quiet < SR && waited < 30) { run(p, 0.5, () => 0, hold); waited += 0.5; }
    const idle = p.quiet >= SR;
    for (const [k, v] of Object.entries(params)) send(p, { type: 'param', name: k, value: v });
    send(p, { type: 'engaged', value: true });
    const landed = smoothers(p).every((s) => s === p.fade || Math.abs(s.v - s.t) <= 1e-9);
    return { idle, waited, landed, out: run(p, 0.3, () => 0, hold).L };
  };
  const glides = [], stale = [];
  let worst = -Infinity;
  for (const [name, params] of Object.entries(SNAP)) {
    const woken = wakeRun(name, params, false), twin = wakeRun(name, params, true, woken.waited);
    if (!woken.idle || !woken.landed) glides.push(woken.idle ? name : `${name} (never went idle)`);
    let d = 0; for (let i = 0; i < woken.out.length; i++) d = Math.max(d, Math.abs(woken.out[i] - twin.out[i]));
    worst = Math.max(worst, dB(d));
    if (dB(d) > -40) stale.push(`${name} ${dB(d).toFixed(0)} dBFS`);
  }
  check(!glides.length, 'Pedals woken from idle land on their new knob values at once', glides.join(', '));
  check(!stale.length, 'Pedals woken from idle replay nothing stale (match a never-idled twin)',
    stale.length ? stale.join('; ') : `worst difference ${worst.toFixed(0)} dBFS`);
}

// ---- Switching a pedal off while playing (review 2026-11-22, findings 1 and its follow-up)
// A pedal created switched off starts idle and never renders, so a check built that way passes even if
// the pedal ignores its off switch. Here each pedal is on and playing a steady note, is switched off,
// and must then pass the guitar exactly (once its bypass fade has settled, about 70 ms, or once its echo or reverb trail has died
// away: those spill over on purpose) and go idle. A pedal that ignores the switch fails.
{
  const OFF_CASES = [
    ['neon-comp', { sustain: 1 }, 0.15], ['neon-octave', { oct1: 1, oct2: 1 }, 0.15], ['neon-wah', { mode: 'LFO' }, 0.15],
    ['neon-fuzz', { fuzz: 1 }, 0.15], ['neon-ts', { drive: 1 }, 0.15], ['neon-vibe', {}, 0.15], ['neon-phaser', {}, 0.15],
    ['neon-flanger', {}, 0.15], ['neon-amp', { voice: 'PLEXI', gain: 1 }, 0.15], ['neon-chorus', { mode: 'C' }, 0.15],
    ['neon-trem', { depth: 1 }, 0.15], ['neon-echo', { mix: 1 }, 4], ['neon-reverb', { mode: 1 }, 6]]; // trails measured 2.3 and 3.4 s (2026-11-22)
  const note = sine(330, 0.2);
  for (const [name, params, allow] of OFF_CASES) {
    const p = make(name, params);
    const off = Math.round(0.5 * SR / BLOCK) * BLOCK;
    const r = run(p, 0.5 + allow + 1.5, note, (t) => { if (t * SR >= off && p.engaged) send(p, { type: 'engaged', value: false }); });
    let changed = 0, last = off;
    for (let i = 0; i < r.L.length; i++) {
      const d = Math.max(Math.abs(r.L[i] - Math.fround(note(i))), Math.abs(r.R[i] - Math.fround(note(i))));
      if (i >= 0.1 * SR && i < off) changed = Math.max(changed, d);
      if (i >= off && d >= 1e-6) last = i + 1;
    }
    const dryAfter = (last - off) / SR;
    check(changed > 1e-3 && dryAfter <= allow && p.quiet >= SR, `${name} switched off while playing passes dry exactly, then idles`,
      `on: differs by ${changed.toFixed(3)}; exact dry ${(dryAfter * 1000).toFixed(0)} ms after the switch (allowed ${allow * 1000}); idle ${p.quiet >= SR}`);
  }
}

// ---- Locked presets: the owner signed these off by ear (Echoplex Lead, 2026-11-14). Their settings in
// app.js and the sound of their whole chain are pinned, so no later DSP change alters them by accident.
// If a check here fails, the preset's sound changed: only update the pinned values with the owner's OK.
{
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const LOCKED = {
    name: 'Echoplex Lead (tape echo)',
    text: `{ name: 'Echoplex Lead (tape echo)', pedals: [
      ['ts', true, { drive: 0.55, tone: 0.55, level: 0.6 }],
      ['amp', true, { voice: 'PLEXI', gain: 0.6, bass: 0.55, mid: 0.65, treble: 0.55, volume: 0.5 }],
      ['echo', true, { time: 0.62, repeats: 0.35, mix: 0.32 }],
      ['reverb', true, { level: 0.15, tone: 0.5, time: 0.35, mode: 2 }]] },`,
    chain: [['neon-ts', { drive: 0.55, tone: 0.55, level: 0.6 }],
      ['neon-amp', { voice: 'PLEXI', gain: 0.6, bass: 0.55, mid: 0.65, treble: 0.55, volume: 0.5 }],
      ['neon-echo', { time: 0.62, repeats: 0.35, mix: 0.32 }],
      ['neon-reverb', { level: 0.15, tone: 0.5, time: 0.35, mode: 2 }]],
    // [level 0-1.2 s, 1.2-2 s, echo tail 2-3.5 s, low band, mid band, high band], dB. From the 2026-11-14 build.
    // The bands use one-pole filters, whose shape shifts with the sample rate, so these hold at 48 kHz only.
    print: [-16.91, -31.53, -60.48, -24.58, -25.15, -37.29],
    // The same output's exact (FFT) energy in 60-300 / 300-2500 / 2500-10000 Hz, dB. Rate-independent:
    // measured 2026-11-22 at 44.1 / 48 / 96 kHz as -22.33/-22.32/-22.30, -29.41/-29.41/-29.42 and
    // -38.82/-38.79/-38.82, so the locked sound is the same at every rate an interface may run at.
    bands: [-22.32, -29.41, -38.79],
  };
  check(appSrc.includes(LOCKED.text), `${LOCKED.name}: preset settings unchanged in app.js`);
  // A short phrase (G, B, D, held a little), then silence so the echo and plate tail are measured.
  const notes = [196, 246.94, 293.66];
  const input = Float32Array.from({ length: Math.round(3.5 * SR) }, (_, i) => {
    const k = Math.floor(i / (0.4 * SR));
    return k < notes.length ? pluck(notes[k], 0.3)(i - k * 0.4 * SR) : 0;
  });
  const out = series(LOCKED.chain.map(([n, p]) => make(n, p)), input);
  const band = (lo, hi) => { // energy between lo and hi Hz, by one-pole high/low-pass
    const a = Math.exp(-2 * Math.PI * hi / SR), b = Math.exp(-2 * Math.PI * lo / SR);
    let l = 0, h = 0, e = 0;
    for (const v of out) { l = v + a * (l - v); h = l + b * (h - l); const x = l - h; e += x * x; }
    return 10 * Math.log10(e / out.length + 1e-20);
  };
  const print = [dB(rms(out, 0, 1.2 * SR)), dB(rms(out, 1.2 * SR, 2 * SR)), dB(rms(out, 2 * SR, 3.5 * SR)),
    band(60, 300), band(300, 2500), band(2500, 10000)];
  const off = print.map((v, i) => Math.abs(v - LOCKED.print[i]));
  if (SR === 48000) {
    check(finite(out) && off.every((d) => d < 0.1), `${LOCKED.name}: sound of the whole chain unchanged (within 0.1 dB)`,
      `[${print.map((v) => v.toFixed(2)).join(', ')}]`);
  } else console.log(`SKIP  ${LOCKED.name}: 48 kHz fingerprint (pinned at 48 kHz; the band check below covers ${SR} Hz)`);
  // Exact band energies by FFT of the whole output (zero-padded), the same measure at every rate.
  let M = 1; while (M < out.length) M <<= 1;
  const re = new Float64Array(M), im = new Float64Array(M); re.set(out); fft(re, im);
  const exact = (lo, hi) => { let e = 0; for (let b = Math.ceil(lo * M / SR); b <= Math.floor(hi * M / SR); b++) e += re[b] * re[b] + im[b] * im[b]; return 10 * Math.log10(2 * e / (M * out.length)); };
  const bands = [exact(60, 300), exact(300, 2500), exact(2500, 10000)];
  const levels = print.slice(0, 3).map((v, i) => Math.abs(v - LOCKED.print[i]));
  check(finite(out) && bands.every((v, i) => Math.abs(v - LOCKED.bands[i]) < 0.15) && levels.every((d) => d < 0.15),
    `${LOCKED.name}: same sound at ${SR / 1000} kHz (levels and exact bands within 0.15 dB)`,
    `bands [${bands.map((v) => v.toFixed(2)).join(', ')}], levels [${print.slice(0, 3).map((v) => v.toFixed(2)).join(', ')}]`);
}

// ---- Loop recorder: segments land on exact frames of the audio clock, whatever the block edges
{
  const rec = new registry['neon-rec']();
  const takes = [];
  rec.port.postMessage = (m) => takes.push(m);
  // Two overlapping segments (as the looper arms them: each chord carries a short crossfade tail),
  // starting mid-block and ending mid-block. Input sample value = its frame number.
  // 'b' brings its own buffers, as the page sends them, so the audio thread allocates nothing.
  const given = [new Float32Array(333), new Float32Array(333)];
  const segs = [{ key: 'a', start: 1000, len: 700 }, { key: 'b', start: 1650, len: 333, ch: given }];
  send(rec, { type: 'arm', session: 7, segs });
  const inL = new Float32Array(BLOCK), inR = new Float32Array(BLOCK);
  for (let f = 0; f < 4096; f += BLOCK) {
    globalThis.currentFrame = f;
    for (let i = 0; i < BLOCK; i++) { inL[i] = f + i; inR[i] = -(f + i); }
    rec.process([[inL, inR]], [[new Float32Array(BLOCK)]]);
  }
  const exact = segs.every((s) => {
    const t = takes.find((m) => m.key === s.key);
    return t && t.session === 7 && t.ch[0].length === s.len &&
      t.ch[0].every((v, i) => v === s.start + i) && t.ch[1].every((v, i) => v === -(s.start + i));
  });
  check(exact && takes.length === 2, 'Loop recorder captures each segment sample-exact on the audio clock',
    takes.map((t) => `${t.key}: ${t.ch[0][0]}..${t.ch[0][t.ch[0].length - 1]}`).join(', '));
  const order = takes.map((t) => t.key).join('');
  check(order === 'ab', 'Loop recorder hands each segment over as soon as it is full', `order ${order}`);
  const tb = takes.find((t) => t.key === 'b');
  check(!!tb && tb.ch[0] === given[0] && tb.ch[1] === given[1], 'Loop recorder fills the buffers the page hands it (no audio-thread allocation)');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll DSP checks passed');
process.exit(failures ? 1 : 0);
