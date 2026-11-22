/* NEON RIG: tuner pitch detection (McLeod pitch method). Pure functions, no DOM, so
   tests/tuner-test.js can run it under Node. Used by app.js on the main thread. */
const NEON_RIG_TUNER = (() => {
  'use strict';

  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  // Standard tuning, low to high, as MIDI notes: E2 A2 D3 G3 B3 E4.
  const STRINGS = [40, 45, 50, 55, 59, 64];

  // Average every `d` samples: a cheap low-pass and downsample. The page already low-passes the
  // tuner feed at ~1 kHz, so the guitar's fundamentals (73-1320 Hz) pass, at a quarter of the work.
  function decimate(x, d) {
    if (d <= 1) return x;
    const out = new Float32Array(Math.floor(x.length / d));
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      for (let k = 0; k < d; k++) s += x[i * d + k];
      out[i] = s / d;
    }
    return out;
  }

  // Returns { freq, clarity, rms } or null when the input is too quiet or has no clear period.
  // Normalised square-difference function (NSDF), key maxima, then the first maximum within 93%
  // of the highest, which avoids the octave-down errors plain autocorrelation makes on guitar.
  function detect(x, sr, { minHz = 60, maxHz = 1400, minRms = 0.002 } = {}) {
    const N = x.length;
    let e = 0;
    for (let i = 0; i < N; i++) e += x[i] * x[i];
    const rms = Math.sqrt(e / N);
    if (!(rms >= minRms)) return null;
    const maxLag = Math.min(Math.ceil(sr / minHz) + 1, Math.floor(N / 2));
    const minLag = Math.max(2, Math.floor(sr / maxHz));
    const W = N - maxLag - 1;
    const sq = new Float64Array(N + 1);
    for (let i = 0; i < N; i++) sq[i + 1] = sq[i] + x[i] * x[i];
    const nsdf = new Float64Array(maxLag + 1);
    for (let t = 0; t <= maxLag; t++) {
      let acf = 0;
      for (let i = 0; i < W; i++) acf += x[i] * x[i + t];
      const m = sq[W] + sq[W + t] - sq[t];
      nsdf[t] = m > 0 ? 2 * acf / m : 0;
    }
    // Key maxima: the highest point of each positive lobe after the first negative dip.
    const peaks = [];
    let t = 1;
    while (t < maxLag && nsdf[t] > 0) t++;
    while (t < maxLag) {
      while (t < maxLag && nsdf[t] <= 0) t++;
      let best = -1;
      while (t < maxLag && nsdf[t] > 0) { if (best < 0 || nsdf[t] > nsdf[best]) best = t; t++; }
      if (best > 0 && t < maxLag) peaks.push(best); // a lobe cut off at maxLag is unreliable
    }
    const usable = peaks.filter((p) => p >= minLag);
    if (!usable.length) return null;
    const top = Math.max(...usable.map((p) => nsdf[p]));
    const p = usable.find((q) => nsdf[q] >= 0.93 * top);
    const a = nsdf[p - 1], b = nsdf[p], c = nsdf[p + 1];
    const den = a - 2 * b + c;
    const shift = den < 0 ? clampShift(0.5 * (a - c) / den) : 0;
    const clarity = b - 0.25 * (a - c) * shift;
    return { freq: sr / (p + shift), clarity, rms };
  }
  const clampShift = (s) => Math.max(-0.5, Math.min(0.5, s));

  // Nearest equal-tempered note to `freq`, with the offset in cents (-50..+50).
  function note(freq, a4 = 440) {
    const m = 69 + 12 * Math.log2(freq / a4);
    const midi = Math.round(m);
    return { midi, name: NAMES[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1, cents: (m - midi) * 100 };
  }

  return { decimate, detect, note, NAMES, STRINGS };
})();
if (typeof window !== 'undefined') window.NEON_RIG_TUNER = NEON_RIG_TUNER;
