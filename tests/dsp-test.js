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
  const by = run(make('neon-ts', { drive: 1 }, false), 0.2, dry);
  check(by.L.every((v, i) => Math.abs(v - Math.fround(dry(i))) < 1e-6), 'TS bypass is clean');
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
  const by = run(make('neon-chorus', { mode: 'C' }, false), 0.2, sine(330, 0.2));
  check(by.L.every((v, i) => Math.abs(v - Math.fround(sine(330, 0.2)(i))) < 1e-6), 'Chorus bypass is clean');
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
  const by = run(make('neon-wah', { mode: 'LFO' }, false), 0.2, sine(330, 0.2));
  check(by.L.every((v, i) => Math.abs(v - Math.fround(sine(330, 0.2)(i))) < 1e-6), 'Wah bypass is clean');
  const perf = run(make('neon-wah', { mode: 'AUTO' }), 10, pluck(110, 0.3));
  console.log(`      Wah CPU: ${cpu(perf)}`);
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
  const by = run(make('neon-fuzz', { fuzz: 1 }, false), 0.2, sine(330, 0.2));
  check(by.L.every((v, i) => Math.abs(v - Math.fround(sine(330, 0.2)(i))) < 1e-6), 'Fuzz bypass is clean');
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
  const by = run(make('neon-vibe', {}, false), 0.2, sine(330, 0.2));
  check(by.L.every((v, i) => Math.abs(v - Math.fround(sine(330, 0.2)(i))) < 1e-6), 'Vibe bypass is clean');
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
  const fClean = cleanThd('FENDER'), hClean = cleanThd('HIWATT');
  check(fClean < 1 && hClean < 1.5, 'Amp GAIN 0 is clean on a hot input', `THD FENDER ${fClean.toFixed(2)}%, HIWATT ${hClean.toFixed(2)}%`);
  // GAIN at noon on a typical hard-picked peak (-12 dBFS) is edge of breakup, as on the real amps.
  // Too hot here and an overdrive in front turns the amp into square-wave fizz (the SRV bug).
  const noon = (procs) => thd(series(procs, Float32Array.from({ length: 2 * SR }, (_, i) => sine(196, 0.25)(i))).subarray(SR), 196) * 100;
  const nF = noon([make('neon-amp', { voice: 'FENDER' })]), nH = noon([make('neon-amp', { voice: 'HIWATT' })]);
  const nP = noon([make('neon-amp', { voice: 'PLEXI' })]);
  const srv = noon([make('neon-ts', { drive: 0.2, tone: 0.55, level: 0.85 }), make('neon-amp', { voice: 'FENDER', gain: 0.55 })]);
  check(nF < 8 && nH < 10 && nP < 18 && srv < 30, 'Amp GAIN noon breaks up, but does not fizz with a drive in front',
    `THD at -12 dBFS: FENDER ${nF.toFixed(1)}%, HIWATT ${nH.toFixed(1)}%, PLEXI ${nP.toFixed(1)}%, SRV TS > FENDER ${srv.toFixed(1)}%`);
  // Aliasing: a high lead note through overdrive into a cranked Plexi.
  const aTs = inharmonic([make('neon-ts', { drive: 1 })], 2489, 20000);
  const aChain = inharmonic([make('neon-ts', { drive: 1 }), make('neon-amp', { voice: 'PLEXI', gain: 0.9 })], 2489, 20000);
  check(aTs < -55 && aChain < -45, 'Drive and amp keep aliasing (inharmonic fizz) low',
    `2.5 kHz note: TS ${aTs.toFixed(1)} dB, TS > PLEXI ${aChain.toFixed(1)} dB vs harmonics`);
  const by = run(make('neon-amp', { voice: 'PLEXI', gain: 1 }, false), 0.2, sine(330, 0.2));
  check(by.L.every((v, i) => Math.abs(v - Math.fround(sine(330, 0.2)(i))) < 1e-6), 'Amp off passes dry');
  const p = make('neon-amp', { voice: 'PLEXI' });
  let k = 0;
  const rv = run(p, 2, pluck(110, 0.2), (t) => { if (t >= k * 0.4) { send(p, { type: 'param', name: 'voice', value: ['PLEXI', 'HIWATT', 'FENDER'][k % 3] }); k++; } });
  check(finite(rv.L), 'Amp voice switching is safe');
  const perf = run(make('neon-amp', { voice: 'PLEXI', gain: 0.8 }), 10, pluck(110, 0.3));
  console.log(`      Amp CPU: ${cpu(perf)}`);
}

// ------------------------------------------------------------------ reverb
const MODES = DSP.RV_MODES;
for (let m = 0; m < MODES.length; m++) {
  const p = make('neon-reverb', { mode: m, level: 0.7, tone: 0.5, time: 0.6 });
  const r = run(p, 12, burst(0.3, 0.25));
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
  const q = make('neon-reverb', { mode: 1 }, false);
  const rq = run(q, 0.5, sine(500, 0.2));
  check(rq.L.every((v, i) => Math.abs(v - Math.fround(sine(500, 0.2)(i))) < 1e-6), 'Reverb bypass passes dry untouched');
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
  const q = make('neon-trem', { depth: 1 }, false);
  const rq = run(q, 0.5, sine(500, 0.2));
  check(rq.L.every((v, i) => Math.abs(v - Math.fround(sine(500, 0.2)(i))) < 1e-6), 'Tremolo bypass passes dry untouched');
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
  const q = make('neon-echo', { mix: 1 }, false);
  const rq = run(q, 0.5, sine(500, 0.2));
  check(rq.L.every((v, i) => Math.abs(v - Math.fround(sine(500, 0.2)(i))) < 1e-6), 'Tape echo bypass passes dry untouched');
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
  const q = make('neon-phaser', {}, false);
  const rq = run(q, 0.5, sine(500, 0.2));
  check(rq.L.every((v, i) => Math.abs(v - Math.fround(sine(500, 0.2)(i))) < 1e-6), 'Phaser bypass passes dry untouched');
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
  const q = make('neon-flanger', {}, false);
  const rq = run(q, 0.5, sine(500, 0.2));
  check(rq.L.every((v, i) => Math.abs(v - Math.fround(sine(500, 0.2)(i))) < 1e-6), 'Flanger bypass passes dry untouched');
}
{
  // Full default chain, the way the app wires it, for a CPU budget.
  const chain = [make('neon-input', { hum: 60, gate: -65 }), make('neon-wah'), make('neon-fuzz', { fuzz: 0.8 }),
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
  check(pct < 35, 'Full chain (input + all eleven pedals) fits the real-time budget', `${pct.toFixed(1)}% of one core (${(ms / (total / BLOCK) * 1000).toFixed(0)} µs per 128-sample block, budget ${(BLOCK / SR * 1e6).toFixed(0)} µs)`);
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
  for (const [name, params] of [['neon-input', { gate: -60 }], ['neon-wah', {}], ['neon-fuzz', {}], ['neon-ts', {}],
    ['neon-vibe', {}], ['neon-chorus', {}], ['neon-trem', {}], ['neon-echo', { repeats: 0.8 }], ['neon-phaser', { mode: 'BLOCK' }], ['neon-flanger', { res: 0.8 }], ['neon-amp', { voice: 'FENDER' }], ['neon-reverb', { mode: 3 }]]) {
    const p = make(name, params);
    const playing = cost(p, 2, pluck(110, 0.3));
    cost(p, 10, () => 0);
    const silent = cost(p, 2, () => 0);
    check(silent < playing * 1.5, `${name} stays cheap in silence (no denormal slowdown)`, `${(silent / playing).toFixed(2)}x the cost of playing`);
  }
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
