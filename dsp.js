/* NEON RIG pedal DSP. Runs inside an AudioWorklet (the browser's real-time audio thread).
 *
 * Everything lives in one function so index.html can load this file as an ordinary
 * <script> and hand the function's source to audioWorklet.addModule() via a Blob URL.
 * That lets the app run straight from disk (file://) with no web server.
 * tests/dsp-test.js evaluates the same function under Node.
 *
 * The models are behavioural approximations written for this app, not circuit-exact
 * clones: Cry Baby style wah, Fuzz Face style fuzz, TS-808 style overdrive, Uni-Vibe
 * style vibe, Phase 90 style phaser, BF-2 style flanger, CE-2W style chorus/vibrato, TR-2 style tremolo,
 * Echoplex style tape echo, RV-6 style reverb,
 * a three-voice amp head, plus the input conditioner (hum filter
 * and noise gate) that sits in front of them, and the looper's recorder.
 */
function NEON_RIG_DSP() {
  'use strict';

  const SR = sampleRate;
  const TAU = Math.PI * 2;
  const DENORM = 1e-20;
  // Rounds anything below ~1e-34 (-680 dB) to exactly 0. Filter states decaying in silence
  // (e.g. behind a closed noise gate) otherwise reach denormal numbers, which most CPUs process
  // tens of times slower: enough to choke the audio thread.
  const flush = (x) => x + 1e-18 - 1e-18;

  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const num = (v, fallback) => (Number.isFinite(+v) ? +v : fallback);
  // Approximate "A" (audio) taper pot: half rotation gives ~15% of full value.
  const audioTaper = (x) => (Math.exp(3.5 * x) - 1) / (Math.exp(3.5) - 1);
  const softLimit = (x) => x / Math.sqrt(1 + x * x);

  // ---------------------------------------------------------------- building blocks

  class Smoother {
    constructor(value, ms) {
      this.v = value;
      this.t = value;
      this.k = 1 - Math.exp(-1000 / (SR * ms));
    }
    set(t) { this.t = t; }
    snap() { this.v = this.t; }
    next() { const d = this.t - this.v; this.v = d > 1e-9 || d < -1e-9 ? this.v + d * this.k : this.t; return this.v; }
  }

  class OnePole {
    constructor() { this.a = 0; this.z = 0; }
    setCutoff(fc, fs = SR) { this.a = Math.exp(-TAU * Math.min(fc, fs * 0.49) / fs); return this; }
    lp(x) { this.z = flush(x + this.a * (this.z - x)); return this.z; }
    hp(x) { return x - this.lp(x); }
    reset() { this.z = 0; }
  }

  // RBJ biquad, transposed direct form II.
  class Biquad {
    constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
    set(b0, b1, b2, a0, a1, a2) {
      this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
      return this;
    }
    lowpass(fc, q, fs = SR) {
      const w = TAU * Math.min(fc, fs * 0.49) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
      return this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
    }
    notch(fc, q, fs = SR) {
      const w = TAU * Math.min(fc, fs * 0.49) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
      return this.set(1, -2 * c, 1, 1 + al, -2 * c, 1 - al);
    }
    process(x) {
      const y = this.b0 * x + this.z1;
      this.z1 = flush(this.b1 * x - this.a1 * y + this.z2);
      this.z2 = flush(this.b2 * x - this.a2 * y);
      return y;
    }
    reset() { this.z1 = 0; this.z2 = 0; }
  }

  // First-order antiderivative anti-aliasing (Parker et al., DAFx 2016). Instead of f(x)
  // at each sample it outputs the average of f over the step from the previous input,
  // (F(x1) - F(x0)) / (x1 - x0), with F the antiderivative of f. Hard-driven clippers
  // make harmonics far above Nyquist; this removes most of what would fold back down as
  // inharmonic fizz. Costs a half-sample delay, which is negligible when oversampled.
  class ADAA {
    constructor(f, F) { this.f = f; this.F = F; this.x = 0; this.Fx = F(0); }
    process(x) {
      const dx = x - this.x, Fx = this.F(x);
      const y = Math.abs(dx) > 1e-5 ? (Fx - this.Fx) / dx : this.f(0.5 * (x + this.x));
      this.x = x;
      this.Fx = Fx;
      return y;
    }
  }
  // log(cosh(x)), the antiderivative of tanh, without overflow for large |x|.
  const logCosh = (x) => { const a = Math.abs(x); return a + Math.log1p(Math.exp(-2 * a)) - Math.LN2; };

  // 8th-order Butterworth low-pass just under the base-rate Nyquist, used on both sides of
  // the oversampled clippers: removes the zero-stuffing images going up, and everything that
  // would alias coming down.
  const antiAlias = (fsOS) => [0.5098, 0.6013, 0.9, 2.5629].map((q) => new Biquad().lowpass(SR * 0.42, q, fsOS));

  // Circular delay line. read(d) returns the sample written d samples ago (d = 1 is the
  // most recent write), with fractional interpolation.
  class DelayLine {
    constructor(maxSamples) {
      let size = 1;
      while (size < maxSamples + 4) size <<= 1;
      this.buf = new Float32Array(size);
      this.mask = size - 1;
      this.w = 0;
    }
    write(x) { this.buf[this.w] = flush(x); this.w = (this.w + 1) & this.mask; }
    read(d) {
      const p = this.w - d, i = Math.floor(p), f = p - i, m = this.mask, b = this.buf;
      const a = b[i & m];
      return a + (b[(i + 1) & m] - a) * f;
    }
    // Cubic Hermite; needs d >= 2.
    readCubic(d) {
      const p = this.w - d, i = Math.floor(p), f = p - i, m = this.mask, b = this.buf;
      const xm1 = b[(i - 1) & m], x0 = b[i & m], x1 = b[(i + 1) & m], x2 = b[(i + 2) & m];
      const c1 = 0.5 * (x1 - xm1);
      const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
      const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
      return ((c3 * f + c2) * f + c1) * f + x0;
    }
    clear() { this.buf.fill(0); }
  }

  // Schroeder allpass diffuser with a fixed delay.
  class Allpass {
    constructor(len, g) { this.buf = new Float32Array(len); this.len = len; this.i = 0; this.g = g; }
    process(x) {
      const d = this.buf[this.i];
      const w = x + this.g * d;
      this.buf[this.i] = flush(w);
      if (++this.i >= this.len) this.i = 0;
      return d - this.g * w;
    }
    clear() { this.buf.fill(0); }
  }

  // ---------------------------------------------------------------- pedal base class

  // Messages from the page: {type:'param', name, value} | {type:'engaged', value} | {type:'dispose'}
  class PedalProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super(options);
      const o = (options && options.processorOptions) || {};
      this.initial = o.params || {};
      this.alive = true;
      this.engaged = o.engaged !== false;
      this.mix = new Smoother(this.engaged ? 1 : 0, 6);
      this.silence = null;
      this.port.onmessage = (e) => this.onMessage(e.data);
    }
    applyInitial() { for (const k in this.initial) this.setParam(k, this.initial[k]); }
    onMessage(m) {
      if (!m) return;
      if (m.type === 'param') this.setParam(m.name, m.value);
      else if (m.type === 'engaged') { this.engaged = !!m.value; this.mix.set(this.engaged ? 1 : 0); }
      else if (m.type === 'dispose') this.alive = false;
    }
    setParam() {}
    process(inputs, outputs) {
      const out = outputs[0];
      const oL = out[0], oR = out[1] || out[0];
      const n = oL.length;
      const inp = inputs[0];
      let iL = inp && inp[0], iR = inp && inp[1];
      if (!iL) {
        if (!this.silence || this.silence.length !== n) this.silence = new Float32Array(n);
        iL = this.silence;
      }
      if (!iR) iR = iL;
      this.render(iL, iR, oL, oR, n);
      return this.alive;
    }
  }

  // ---------------------------------------------------------------- TS-808 style overdrive
  //
  // Clipping stage: a non-inverting op-amp whose gain only applies above ~720 Hz
  // (4.7 kΩ + 47 nF to ground), with antiparallel silicon diodes and 51 pF in the
  // feedback loop. The op-amp output is the input plus the diode-limited gain branch,
  // which keeps the bass clean and gives the famous mid hump. Then the passive 723 Hz
  // low-pass and the treble-blend tone control, then the level pot.
  // The clipping stage runs 4x oversampled with ADAA to keep aliasing down.

  const TS_VOLT = 4;    // digital full scale ≈ 4 V peak at an interface's instrument input
  const TS_VD = 0.55;   // diode knee voltage
  // Diode pair as a smooth limiter in units of TS_VD: x / sqrt(1 + x²), antiderivative sqrt(1 + x²).
  const diodeShape = (x) => x / Math.sqrt(1 + x * x);
  const diodeShapeF = (x) => Math.sqrt(1 + x * x);

  class TubeScreamer extends PedalProcessor {
    constructor(options) {
      super(options);
      this.os = SR > 60000 ? 2 : 4;
      const fsOS = SR * this.os;
      this.gainHP = new OnePole().setCutoff(720, fsOS);
      this.fbLP = new OnePole();
      this.clip = new ADAA(diodeShape, diodeShapeF);
      this.up = antiAlias(fsOS);
      this.down = antiAlias(fsOS);
      this.toneLP = new OnePole().setCutoff(723);
      this.dcBlock = new OnePole().setCutoff(12);
      this.p = { drive: 0.5, tone: 0.5, level: 0.5 };
      this.level = new Smoother(0, 20);
      this.setParam('level', this.p.level);
      this.applyInitial();
      this.level.snap();
    }
    setParam(k, v) {
      if (!(k in this.p)) return;
      this.p[k] = clamp(num(v, this.p[k]), 0, 1);
      if (k === 'level') this.level.set(4 * audioTaper(this.p.level));
    }
    render(iL, iR, oL, oR, n) {
      const rf = 51e3 + 500e3 * audioTaper(this.p.drive);
      const gain = rf / 4.7e3;
      this.fbLP.setCutoff(1 / (TAU * rf * 51e-12), SR * this.os);
      const toneGain = 0.15 * Math.pow(1.6 / 0.15, this.p.tone);
      const os = this.os, [u0, u1, u2, u3] = this.up;
      const [d0, d1, d2, d3] = this.down;
      for (let s = 0; s < n; s++) {
        const dryL = iL[s], dryR = iR[s];
        const x = 0.5 * (dryL + dryR) * TS_VOLT;
        let y = 0;
        for (let k = 0; k < os; k++) {
          const u = u3.process(u2.process(u1.process(u0.process(k === 0 ? x * os : 0))));
          const v = u + TS_VD * this.clip.process(this.fbLP.lp(this.gainHP.hp(u) * gain) / TS_VD);
          y = d3.process(d2.process(d1.process(d0.process(v))));
        }
        const lo = this.toneLP.lp(y);
        const wet = this.dcBlock.hp(lo + (y - lo) * toneGain) * this.level.next() / TS_VOLT;
        const m = this.mix.next();
        oL[s] = dryL + (wet - dryL) * m;
        oR[s] = dryR + (wet - dryR) * m;
      }
    }
  }

  // ---------------------------------------------------------------- CE-2W style chorus
  //
  // S = CE-2: triangle LFO, mono BBD chorus mixed with the dry signal.
  // C = CE-1 chorus: preamp warmth, sine LFO, stereo (right side uses the inverted LFO).
  // V = CE-1 vibrato: wet only, so the modulation is heard as pitch wobble.
  // The bucket-brigade delay's dark top end is modelled with a low-pass on the wet path.

  class Chorus extends PedalProcessor {
    constructor(options) {
      super(options);
      this.line = new DelayLine(Math.ceil(SR * 0.03));
      this.phase = 0;
      this.wetLP = [new Biquad().lowpass(6800, 0.6), new Biquad().lowpass(6800, 0.6)];
      this.p = { rate: 0.35, depth: 0.5, mode: 'S' };
      this.mode = 'S';
      this.pending = null;
      this.fade = new Smoother(1, 5);
      this.rateHz = new Smoother(1, 60);
      this.depth = new Smoother(0.5, 60);
      this.setParam('rate', this.p.rate);
      this.setParam('depth', this.p.depth);
      this.applyInitial();
      if (this.pending) { this.mode = this.pending; this.pending = null; this.fade.set(1); this.fade.snap(); }
      this.rateHz.snap();
      this.depth.snap();
    }
    setParam(k, v) {
      if (k === 'mode') {
        const m = v === 'C' || v === 'V' ? v : 'S';
        this.p.mode = m;
        if (m !== this.mode) { this.pending = m; this.fade.set(0); }
      } else if (k === 'rate') {
        this.p.rate = clamp(num(v, this.p.rate), 0, 1);
        this.rateHz.set(0.1 * Math.pow(80, this.p.rate)); // 0.1 .. 8 Hz
      } else if (k === 'depth') {
        this.p.depth = clamp(num(v, this.p.depth), 0, 1);
        this.depth.set(this.p.depth);
      }
    }
    render(iL, iR, oL, oR, n) {
      const msToS = SR / 1000;
      const lpA = this.wetLP[0], lpB = this.wetLP[1], line = this.line;
      for (let s = 0; s < n; s++) {
        const dryL = iL[s], dryR = iR[s];
        const x = 0.5 * (dryL + dryR);
        const hz = this.rateHz.next(), depth = this.depth.next();
        this.phase += hz / SR;
        if (this.phase >= 1) this.phase -= 1;
        const mode = this.mode;

        line.write(mode === 'S' ? x : Math.tanh(x * 1.6) / 1.6);
        let yL, yR;
        if (mode === 'S') {
          const tri = 4 * Math.abs(this.phase - 0.5) - 1;
          const w = lpA.process(line.readCubic((1.8 + depth * 5.2 * (0.5 + 0.5 * tri)) * msToS + 2));
          yL = 0.7 * (dryL + w);
          yR = 0.7 * (dryR + w);
        } else {
          const sn = Math.sin(TAU * this.phase);
          if (mode === 'C') {
            const span = depth * 4.5;
            const wA = lpA.process(line.readCubic((3 + span * (0.5 + 0.5 * sn)) * msToS + 2));
            const wB = lpB.process(line.readCubic((3 + span * (0.5 - 0.5 * sn)) * msToS + 2));
            yL = 0.7 * (dryL + wA);
            yR = 0.7 * (dryR + wB);
          } else {
            const w = lpA.process(line.readCubic((1.5 + depth * 5 * (0.5 + 0.5 * sn)) * msToS + 2));
            yL = w;
            yR = w;
          }
        }

        const f = this.fade.next();
        if (this.pending && f < 0.001) { this.mode = this.pending; this.pending = null; this.fade.set(1); }
        const m = this.mix.next() * f;
        oL[s] = dryL + (yL - dryL) * m;
        oR[s] = dryR + (yR - dryR) * m;
      }
    }
  }

  // ---------------------------------------------------------------- TR-2 style tremolo
  //
  // The volume pulses with a low-frequency oscillator, as in the Boss TR-2 or the "vibrato"
  // channel of an old Fender amp (which is really tremolo). Peaks stay at unity: the pedal only
  // dips the level, it never adds any. Shapes:
  // SINE = smooth, even swell.
  // OPTO = Fender's lamp-and-photocell tremolo: a quick dip, then a slower recovery.
  // SQR  = choppy on/off, with the edges rounded (~15 ms) so they don't click.
  // Changing shape crossfades between them, so it never jumps.

  class Tremolo extends PedalProcessor {
    constructor(options) {
      super(options);
      this.p = { rate: 0.45, depth: 0.6, wave: 'SINE' };
      this.phase = 0;
      this.rateHz = new Smoother(4, 60);
      this.depth = new Smoother(0.6, 30);
      this.w = { SINE: new Smoother(1, 20), OPTO: new Smoother(0, 20), SQR: new Smoother(0, 20) };
      for (const k in this.p) this.setParam(k, this.p[k]);
      this.applyInitial();
      this.rateHz.snap();
      this.depth.snap();
      for (const k in this.w) this.w[k].snap();
    }
    setParam(k, v) {
      if (k === 'wave') {
        this.p.wave = v === 'OPTO' || v === 'SQR' ? v : 'SINE';
        for (const s in this.w) this.w[s].set(s === this.p.wave ? 1 : 0);
      } else if (k === 'rate') {
        this.p.rate = clamp(num(v, this.p.rate), 0, 1);
        this.rateHz.set(1.5 * Math.pow(8, this.p.rate)); // 1.5 .. 12 Hz
      } else if (k === 'depth') {
        this.p.depth = clamp(num(v, this.p.depth), 0, 1);
        this.depth.set(this.p.depth);
      }
    }
    render(iL, iR, oL, oR, n) {
      const SQ = Math.tanh(5);
      for (let s = 0; s < n; s++) {
        this.phase += this.rateHz.next() / SR;
        if (this.phase >= 1) this.phase -= 1;
        const ph = this.phase;
        // How far down each shape pulls the volume, 0 (none) .. 1 (all the way, at full DEPTH).
        const sine = 0.5 - 0.5 * Math.cos(TAU * ph);
        const opto = ph < 0.25 ? 0.5 - 0.5 * Math.cos(Math.PI * ph / 0.25) : 0.5 + 0.5 * Math.cos(Math.PI * (ph - 0.25) / 0.75);
        const sqr = 0.5 - 0.5 * Math.tanh(5 * Math.cos(TAU * ph)) / SQ;
        const dip = this.w.SINE.next() * sine + this.w.OPTO.next() * opto + this.w.SQR.next() * sqr;
        const g = 1 - this.depth.next() * dip;
        const m = this.mix.next();
        oL[s] = iL[s] + (iL[s] * g - iL[s]) * m;
        oR[s] = iR[s] + (iR[s] * g - iR[s]) * m;
      }
    }
  }

  // ---------------------------------------------------------------- Echoplex style tape echo
  //
  // A tape loop: the playback head trails the record head by TIME (60-750 ms, like the EP-3's
  // sliding head). Each repeat goes back round through the record amp, so it returns a little
  // darker (low-pass ~3 kHz), thinner (high-pass ~120 Hz) and softly saturated, and the tape
  // speed wanders slightly (slow wow plus faster flutter). Moving TIME glides the head, which
  // bends the pitch of the repeats as on the real thing instead of clicking. The saturation also
  // keeps full REPEATS from running away. Bypass stops new sound going onto the tape, so the
  // repeats already there die away naturally (trails), as with the reverb.

  class TapeEcho extends PedalProcessor {
    constructor(options) {
      super(options);
      this.line = new DelayLine(Math.ceil(SR * 0.8));
      this.p = { time: 0.5, repeats: 0.35, mix: 0.35 };
      this.secs = new Smoother(0.2, 250);
      this.fb = new Smoother(0.3, 30);
      this.wet = new Smoother(0.3, 30);
      this.tone = new Biquad().lowpass(3000, 0.6);
      this.thin = new OnePole().setCutoff(120);
      this.wow = 0;
      this.flutter = 0;
      for (const k in this.p) this.setParam(k, this.p[k]);
      this.applyInitial();
      this.secs.snap();
      this.fb.snap();
      this.wet.snap();
    }
    setParam(k, v) {
      if (!(k in this.p)) return;
      this.p[k] = clamp(num(v, this.p[k]), 0, 1);
      if (k === 'time') this.secs.set(0.06 * Math.pow(12.5, this.p.time)); // 60 .. 750 ms
      else if (k === 'repeats') this.fb.set(0.95 * this.p.repeats);
      else this.wet.set(0.9 * this.p.mix);
    }
    render(iL, iR, oL, oR, n) {
      const line = this.line;
      for (let s = 0; s < n; s++) {
        this.wow += 0.6 / SR;
        this.flutter += 5.5 / SR;
        if (this.wow >= 1) this.wow -= 1;
        if (this.flutter >= 1) this.flutter -= 1;
        const speed = 1 + 0.0025 * Math.sin(TAU * this.wow) + 0.0008 * Math.sin(TAU * this.flutter);
        const rep = line.readCubic(Math.max(2, this.secs.next() * SR * speed));
        const back = this.tone.process(this.thin.hp(rep)) * this.fb.next();
        const x = 0.5 * (iL[s] + iR[s]) * this.mix.next();
        line.write(Math.tanh(x + back));
        const w = rep * this.wet.next();
        oL[s] = iL[s] + w;
        oR[s] = iR[s] + w;
      }
    }
  }

  // ---------------------------------------------------------------- Phase 90 style phaser
  //
  // Four first-order allpass stages swept together by an LFO, mixed 50/50 with the dry signal:
  // where the stages put the signal 180° out of phase it cancels, giving two moving notches.
  // The sweep is exponential in frequency (as the Phase 90's JFETs are), so it sounds even.
  // SCRIPT = the early, smooth version; BLOCK = the later one, with feedback for a sharper,
  // more vocal sweep. Switching crossfades the feedback amount, so it never clicks.

  class Phaser extends PedalProcessor {
    constructor(options) {
      super(options);
      this.p = { speed: 0.35, mode: 'SCRIPT' };
      this.s = new Float64Array(4);
      this.last = 0;
      this.phase = 0;
      this.rateHz = new Smoother(0.5, 60);
      this.fb = new Smoother(0, 30);
      for (const k in this.p) this.setParam(k, this.p[k]);
      this.applyInitial();
      this.rateHz.snap();
      this.fb.snap();
    }
    setParam(k, v) {
      if (k === 'mode') {
        this.p.mode = v === 'BLOCK' ? 'BLOCK' : 'SCRIPT';
        this.fb.set(this.p.mode === 'BLOCK' ? 0.45 : 0);
      } else if (k === 'speed') {
        this.p.speed = clamp(num(v, this.p.speed), 0, 1);
        this.rateHz.set(0.08 * Math.pow(100, this.p.speed)); // 0.08 .. 8 Hz
      }
    }
    render(iL, iR, oL, oR, n) {
      const s = this.s;
      for (let i = 0; i < n; i++) {
        this.phase += this.rateHz.next() / SR;
        if (this.phase >= 1) this.phase -= 1;
        // Allpass corner swept 180 Hz .. 2.2 kHz on a sine, exponentially.
        const fc = 180 * Math.pow(2.2 / 0.18, 0.5 - 0.5 * Math.cos(TAU * this.phase));
        const t = Math.tan(Math.PI * fc / SR), a = (t - 1) / (t + 1);
        const x = 0.5 * (iL[i] + iR[i]);
        let y = x + this.fb.next() * this.last;
        for (let k = 0; k < 4; k++) {
          const out = a * y + s[k];
          s[k] = flush(y - a * out);
          y = out;
        }
        this.last = y;
        const wet = 0.5 * (x + y);
        const m = this.mix.next();
        oL[i] = iL[i] + (wet - iL[i]) * m;
        oR[i] = iR[i] + (wet - iR[i]) * m;
      }
    }
  }

  // ---------------------------------------------------------------- BF-2 style flanger
  //
  // A very short delay (MANUAL sets its centre, about 0.5-6 ms) swept by a triangle LFO and mixed
  // 50/50 with the dry signal, which puts a comb of notches through the sound and sweeps it: the
  // "jet plane". RES feeds the delayed signal back for a sharper, ringing sweep; only the feedback
  // is softly saturated, so even full RES can't run away while the signal itself stays clean. MANUAL glides, so turning it sweeps by hand.

  class Flanger extends PedalProcessor {
    constructor(options) {
      super(options);
      this.line = new DelayLine(Math.ceil(SR * 0.015));
      this.p = { manual: 0.5, depth: 0.6, rate: 0.3, res: 0.5 };
      this.phase = 0;
      this.centre = new Smoother(0.002, 80);
      this.depth = new Smoother(0.6, 40);
      this.rateHz = new Smoother(0.3, 60);
      this.fb = new Smoother(0.4, 30);
      this.last = 0;
      for (const k in this.p) this.setParam(k, this.p[k]);
      this.applyInitial();
      this.centre.snap();
      this.depth.snap();
      this.rateHz.snap();
      this.fb.snap();
    }
    setParam(k, v) {
      if (!(k in this.p)) return;
      this.p[k] = clamp(num(v, this.p[k]), 0, 1);
      if (k === 'manual') this.centre.set(0.0005 * Math.pow(12, this.p.manual)); // 0.5 .. 6 ms
      else if (k === 'depth') this.depth.set(this.p.depth);
      else if (k === 'rate') this.rateHz.set(0.05 * Math.pow(100, this.p.rate)); // 0.05 .. 5 Hz
      else this.fb.set(0.9 * this.p.res);
    }
    render(iL, iR, oL, oR, n) {
      const line = this.line;
      for (let i = 0; i < n; i++) {
        this.phase += this.rateHz.next() / SR;
        if (this.phase >= 1) this.phase -= 1;
        const tri = 4 * Math.abs(this.phase - 0.5) - 1; // -1 .. 1
        // DEPTH sweeps up to two octaves either side of MANUAL, kept between 0.15 and 12 ms.
        const d = clamp(this.centre.next() * Math.pow(4, this.depth.next() * tri), 0.00015, 0.012);
        const x = 0.5 * (iL[i] + iR[i]);
        line.write(x + Math.tanh(this.fb.next() * this.last)); // bounded feedback, clean dry path
        const wet = line.readCubic(d * SR);
        this.last = wet;
        const y = 0.5 * (x + wet);
        const m = this.mix.next();
        oL[i] = iL[i] + (y - iL[i]) * m;
        oR[i] = iR[i] + (y - iR[i]) * m;
      }
    }
  }

  // ---------------------------------------------------------------- RV-6 style reverb
  //
  // Core: 8-line feedback delay network (Householder matrix, damped and gently
  // modulated lines) behind a predelay and four input diffusers. Modes reshape it:
  // SPRING adds two dispersive spring loops, +DELAY feeds an echo into the tank,
  // SHIMMER feeds an octave-up pitch shift back in, DYNAMIC ducks the tail while
  // you play. The pedal switch gates the reverb input only, so tails ring out.

  const RV_MODES = ['ROOM', 'HALL', 'PLATE', 'SPRING', 'MODULATE', '+DELAY', 'SHIMMER', 'DYNAMIC'];
  // size: FDN delay scale. rt: decay range in seconds swept by TIME. pre: predelay (s).
  // mod: delay modulation depth (ms). damp: high-cut multiplier. diff: input diffusion.
  const RV_CFG = [
    { size: 0.45, rt: [0.25, 2.2], pre: 0.004, mod: 0.05, damp: 0.75, diff: 0.62 }, // ROOM
    { size: 1.2, rt: [0.9, 8], pre: 0.02, mod: 0.15, damp: 1.0, diff: 0.7 },        // HALL
    { size: 0.75, rt: [0.6, 6], pre: 0.0, mod: 0.08, damp: 1.8, diff: 0.78 },       // PLATE
    { size: 0.5, rt: [0.7, 4], pre: 0.0, mod: 0.05, damp: 0.6, diff: 0.5 },         // SPRING
    { size: 1.25, rt: [1.0, 9], pre: 0.02, mod: 1.1, damp: 0.9, diff: 0.7 },        // MODULATE
    { size: 1.0, rt: [0.8, 5], pre: 0.008, mod: 0.15, damp: 0.9, diff: 0.7 },       // +DELAY
    { size: 1.4, rt: [2.0, 12], pre: 0.025, mod: 0.3, damp: 1.4, diff: 0.75 },      // SHIMMER
    { size: 1.15, rt: [0.9, 7], pre: 0.02, mod: 0.15, damp: 1.0, diff: 0.7 },       // DYNAMIC
  ];
  const FDN_MS = [31.3, 37.9, 41.7, 47.3, 53.9, 59.1, 67.3, 71.9];
  const IN_SIGN = [1, 1, -1, 1, -1, -1, 1, -1];
  const OUT_L = [1, -1, 1, -1, 1, -1, 1, -1];
  const OUT_R = [1, 1, -1, -1, 1, 1, -1, -1];

  // A spring tank loop: a chain of first-order allpasses makes low frequencies arrive
  // later than highs, which gives the characteristic chirp and "drip".
  class Spring {
    constructor(ms, stages, coef) {
      this.len = ms * SR / 1000;
      this.line = new DelayLine(Math.ceil(this.len) + 8);
      this.st = new Float64Array(stages);
      this.a = coef;
      this.lp = new Biquad().lowpass(4500, 0.7);
      this.g = 0.7;
    }
    setDecay(rt) { this.g = Math.pow(10, -3 * this.len / (SR * rt)); }
    setTone(hz) { this.lp.lowpass(hz, 0.7); }
    process(x) {
      let v = x + this.line.read(this.len) * this.g + DENORM;
      const a = this.a, st = this.st;
      for (let k = 0; k < st.length; k++) {
        const y = a * v + st[k];
        st[k] = v - a * y;
        v = y;
      }
      v = this.lp.process(v);
      this.line.write(v);
      return v;
    }
    clear() { this.line.clear(); this.st.fill(0); this.lp.reset(); }
  }

  // Two crossfaded read heads sweeping through a short buffer: +12 semitones.
  class OctaveUp {
    constructor() {
      this.win = Math.round(SR * 0.05);
      this.line = new DelayLine(this.win + 8);
      this.ph = 0;
    }
    process(x) {
      this.line.write(x);
      this.ph += 1 / this.win;
      if (this.ph >= 1) this.ph -= 1;
      const p2 = this.ph >= 0.5 ? this.ph - 0.5 : this.ph + 0.5;
      const wa = Math.sin(Math.PI * this.ph), wb = Math.sin(Math.PI * p2);
      return this.line.read(1 + this.win * (1 - this.ph)) * wa * wa +
        this.line.read(1 + this.win * (1 - p2)) * wb * wb;
    }
    clear() { this.line.clear(); }
  }

  class Reverb extends PedalProcessor {
    constructor(options) {
      super(options);
      const maxLen = Math.ceil(SR * 0.16);
      this.lines = FDN_MS.map(() => new DelayLine(maxLen));
      this.damp = FDN_MS.map(() => new OnePole());
      this.len = new Float64Array(8);
      this.gain = new Float64Array(8);
      this.v = new Float64Array(8);
      // Quadrature LFOs (rotating phasors) for delay modulation, one rate per line.
      this.lc = new Float64Array(8); this.ls = new Float64Array(8);
      this.rc = new Float64Array(8); this.rs = new Float64Array(8);
      for (let i = 0; i < 8; i++) {
        const w = TAU * (0.11 + 0.067 * i) / SR;
        this.rc[i] = Math.cos(w); this.rs[i] = Math.sin(w);
        this.lc[i] = Math.cos(i * 1.7); this.ls[i] = Math.sin(i * 1.7);
      }
      this.diffusers = [4.77, 3.59, 12.73, 9.3].map((ms) => new Allpass(Math.round(ms * SR / 1000), 0.7));
      this.pre = new DelayLine(Math.ceil(SR * 0.05));
      this.echo = new DelayLine(Math.ceil(SR * 0.7));
      this.echoLP = new OnePole().setCutoff(3200);
      this.springs = [new Spring(37.1, 48, -0.68), new Spring(43.3, 48, -0.66)];
      this.springHP = new OnePole().setCutoff(280);
      this.shimmer = new OctaveUp();
      this.shimHP = new OnePole().setCutoff(400);
      this.shimSig = 0;
      this.env = 0;
      this.envA = 1 - Math.exp(-1 / (SR * 0.005));
      this.envR = 1 - Math.exp(-1 / (SR * 0.15));
      this.duck = new Smoother(1, 40);
      this.outHP = [new OnePole().setCutoff(90), new OnePole().setCutoff(90)];
      this.outLP = [new Biquad(), new Biquad()];
      this.level = new Smoother(0, 20);
      this.fade = new Smoother(1, 6);
      this.p = { level: 0.35, tone: 0.5, time: 0.45, mode: 1 };
      this.mode = 1;
      this.pending = -1;
      this.setParam('level', this.p.level);
      this.applyInitial();
      if (this.pending >= 0) { this.mode = this.pending; this.pending = -1; this.fade.set(1); this.fade.snap(); }
      this.level.snap();
      this.configure();
    }
    setParam(k, v) {
      if (k === 'mode') {
        const m = clamp(Math.round(num(v, this.p.mode)), 0, RV_MODES.length - 1);
        this.p.mode = m;
        if (m !== this.mode) { this.pending = m; this.fade.set(0); }
        return;
      }
      if (!(k in this.p)) return;
      this.p[k] = clamp(num(v, this.p[k]), 0, 1);
      if (k === 'level') this.level.set(1.6 * Math.pow(this.p.level, 1.6));
      else this.configure();
    }
    configure() {
      const c = RV_CFG[this.mode], p = this.p;
      const rt = c.rt[0] * Math.pow(c.rt[1] / c.rt[0], p.time);
      const toneHz = 1800 * Math.pow(7, p.tone); // 1.8 .. 12.6 kHz
      for (let i = 0; i < 8; i++) {
        this.len[i] = Math.round(FDN_MS[i] * c.size * SR / 1000);
        this.gain[i] = Math.pow(10, -3 * this.len[i] / (SR * rt));
        this.damp[i].setCutoff(toneHz * c.damp);
      }
      this.modDepth = c.mod * SR / 1000;
      this.preLen = Math.max(1, Math.round(c.pre * SR));
      this.diffusers.forEach((d, i) => { d.g = i < 2 ? c.diff : c.diff * 0.83; });
      const lpHz = toneHz * 1.4;
      this.outLP[0].lowpass(lpHz, 0.6);
      this.outLP[1].lowpass(lpHz, 0.6);
      for (const s of this.springs) { s.setDecay(rt); s.setTone(1500 + 4500 * p.tone); }
      this.echoLen = Math.round(SR * (0.12 + 0.5 * p.time));
    }
    switchMode() {
      this.mode = this.pending;
      this.pending = -1;
      for (const l of this.lines) l.clear();
      for (const d of this.damp) d.reset();
      for (const d of this.diffusers) d.clear();
      for (const s of this.springs) s.clear();
      this.pre.clear(); this.echo.clear(); this.shimmer.clear();
      this.shimSig = 0;
      this.configure();
      this.fade.set(1);
    }
    render(iL, iR, oL, oR, n) {
      const mode = this.mode;
      const isSpring = mode === 3, isDelay = mode === 5, isShimmer = mode === 6, isDynamic = mode === 7;
      const L = this.lines, len = this.len, g = this.gain, dmp = this.damp, v = this.v, dif = this.diffusers;
      const lc = this.lc, ls = this.ls, rc = this.rc, rs = this.rs, md = this.modDepth;
      for (let s = 0; s < n; s++) {
        const dryL = iL[s], dryR = iR[s];
        const x = 0.5 * (dryL + dryR) * this.mix.next();

        if (isDynamic) {
          const a = Math.abs(x);
          this.env += (a - this.env) * (a > this.env ? this.envA : this.envR);
          this.duck.set(1 / (1 + 30 * this.env));
        }
        let echoOut = 0;
        if (isDelay) {
          echoOut = this.echo.read(this.echoLen);
          this.echo.write(x + this.echoLP.lp(echoOut) * 0.42);
        }

        let t = this.pre.read(this.preLen);
        this.pre.write(x + echoOut * 0.7 + this.shimSig);
        t = dif[3].process(dif[2].process(dif[1].process(dif[0].process(t))));

        let sum = 0;
        for (let i = 0; i < 8; i++) {
          const c = lc[i], sn = ls[i];
          lc[i] = c * rc[i] - sn * rs[i];
          ls[i] = sn * rc[i] + c * rs[i];
          const y = dmp[i].lp(L[i].read(len[i] + md * (1 + ls[i]))) * g[i];
          v[i] = y;
          sum += y;
        }
        const h = sum * 0.25; // Householder reflection: I - (2/N)·11ᵀ
        let wl = 0, wr = 0;
        for (let i = 0; i < 8; i++) {
          L[i].write(v[i] - h + t * IN_SIGN[i] * 0.35 + DENORM);
          wl += v[i] * OUT_L[i];
          wr += v[i] * OUT_R[i];
        }
        wl *= 0.3;
        wr *= 0.3;

        if (isSpring) {
          const sx = this.springHP.hp(x) * 0.5;
          wl = wl * 0.35 + this.springs[0].process(sx) * 0.9;
          wr = wr * 0.35 + this.springs[1].process(sx) * 0.9;
        } else if (isShimmer) {
          const up = this.shimmer.process(0.5 * (wl + wr));
          this.shimSig = softLimit(this.shimHP.hp(up) * 0.32);
        } else if (isDelay) {
          wl += echoOut * 0.5;
          wr += echoOut * 0.5;
        }

        wl = this.outLP[0].process(this.outHP[0].hp(wl));
        wr = this.outLP[1].process(this.outHP[1].hp(wr));
        let k = this.level.next() * this.fade.next();
        if (isDynamic) k *= this.duck.next();
        oL[s] = dryL + wl * k;
        oR[s] = dryR + wr * k;

        if (this.pending >= 0 && this.fade.v < 0.001) this.switchMode();
      }
    }
  }

  // ---------------------------------------------------------------- Cry Baby style wah
  //
  // A resonant band-pass (zero-delay-feedback state-variable filter, stable under fast
  // sweeps) swept from ~380 Hz (heel) to ~2.3 kHz (toe), with Q rising toward the toe
  // and a little low-pass bleed for body, roughly like the GCB95's inductor filter.
  // Nobody has a free foot for a virtual treadle, so the sweep comes from:
  // AUTO = picking dynamics (envelope), LFO = steady sweep, FIX = POSITION knob only.
  // The live sweep position is posted back to the page ~30x/s to animate the pedal.

  class Wah extends PedalProcessor {
    constructor(options) {
      super(options);
      this.p = { pos: 0.15, sens: 0.5, rate: 0.35, mode: 'AUTO' };
      this.ic1 = 0; this.ic2 = 0;
      this.env = 0;
      this.envA = 1 - Math.exp(-1 / (SR * 0.004));
      this.envR = 1 - Math.exp(-1 / (SR * 0.12));
      this.phase = 0;
      this.sweep = new Smoother(0.15, 6);
      this.base = new Smoother(0.15, 30);
      this.inHP = new OnePole().setCutoff(60);
      this.blocks = 0;
      this.lastSent = -1;
      this.applyInitial();
      this.base.snap();
    }
    setParam(k, v) {
      if (k === 'mode') { this.p.mode = v === 'LFO' || v === 'FIX' ? v : 'AUTO'; return; }
      if (!(k in this.p)) return;
      this.p[k] = clamp(num(v, this.p[k]), 0, 1);
      if (k === 'pos') this.base.set(this.p.pos);
    }
    render(iL, iR, oL, oR, n) {
      const mode = this.p.mode, sens = this.p.sens;
      const lfoHz = 0.2 * Math.pow(30, this.p.rate); // 0.2 .. 6 Hz
      for (let s = 0; s < n; s++) {
        const dryL = iL[s], dryR = iR[s];
        const x = this.inHP.hp(0.5 * (dryL + dryR));
        const base = this.base.next();

        let target = base;
        if (mode === 'AUTO') {
          const a = Math.abs(x);
          this.env += (a - this.env) * (a > this.env ? this.envA : this.envR);
          target = base + (1 - base) * (1 - Math.exp(-this.env * 60 * sens));
        } else if (mode === 'LFO') {
          this.phase += lfoHz / SR;
          if (this.phase >= 1) this.phase -= 1;
          target = base + (1 - base) * (0.5 - 0.5 * Math.cos(TAU * this.phase));
        }
        this.sweep.set(target);
        const pos = this.sweep.next();

        const fc = 380 * Math.pow(2300 / 380, pos);
        const k = 1 / (4 + 2.5 * pos);
        const g = Math.tan(Math.PI * fc / SR);
        const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
        const v3 = x - this.ic2;
        const v1 = a1 * this.ic1 + a2 * v3;
        const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
        this.ic1 = 2 * v1 - this.ic1 + DENORM;
        this.ic2 = 2 * v2 - this.ic2 + DENORM;
        const wet = 2.6 * k * v1 + 0.5 * v2;

        const m = this.mix.next();
        oL[s] = dryL + (wet - dryL) * m;
        oR[s] = dryR + (wet - dryR) * m;
      }
      if (++this.blocks >= 12) {
        this.blocks = 0;
        const pos = this.engaged ? this.sweep.v : 0;
        if (Math.abs(pos - this.lastSent) > 0.004) { this.lastSent = pos; this.port.postMessage({ type: 'pos', value: pos }); }
      }
    }
  }

  // ---------------------------------------------------------------- amp head
  //
  // Two triode gain stages (asymmetric soft clipping, coupling high-pass, Miller-cap
  // low-pass), the passive bass/mid/treble tone stack these amps share, then a push-pull
  // power stage with supply sag and a presence lift. A bright cap adds sparkle that fades
  // as GAIN rises, as on the real amps. The Fender voice puts its tone stack between the
  // two preamp stages (as Blackface amps do); the British voices put it after them.
  // The whole amp runs 4x oversampled.

  // Bass/mid/treble ("FMV") tone stack, solved from the circuit itself.
  // Nodes A (treble pot top), W (output wiper), T (treble pot bottom / bass pot top),
  // M (mid pot top), N (slope-resistor junction); Vin drives C1 and R4. By Cramer's rule
  // V_W = det(Y_W) / det(Y). Every admittance is G or sC, so both determinants are cubics
  // in s: evaluate them at four real s values and interpolate to get exact coefficients.
  // t, m, l = treble, mid and bass pot positions (0..1). Returns
  // H(s) = (b0 + b1 s + b2 s² + b3 s³) / (1 + a1 s + a2 s² + a3 s³).
  // tests/dsp-test.js checks it against an independent complex-valued nodal solve.
  function det5(M) {
    const A = M.map((r) => r.slice());
    let d = 1;
    for (let c = 0; c < 5; c++) {
      let p = c;
      for (let r = c + 1; r < 5; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (p !== c) { const tmp = A[c]; A[c] = A[p]; A[p] = tmp; d = -d; }
      d *= A[c][c];
      for (let r = c + 1; r < 5; r++) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < 5; k++) A[r][k] -= f * A[c][k];
      }
    }
    return d;
  }
  // Coefficients of the cubic through (0,f0) (1,f1) (2,f2) (3,f3), via forward differences.
  function cubicThrough([f0, f1, f2, f3]) {
    const d1 = f1 - f0, d2 = f2 - 2 * f1 + f0, d3 = f3 - 3 * f2 + 3 * f1 - f0;
    return [f0, d1 - d2 / 2 + d3 / 3, d2 / 2 - d3 / 2, d3 / 6];
  }
  function fmvCoeffs(c, t, m, l) {
    const g = (r) => 1 / Math.max(r, 1); // a pot at its end stop still has ~1 Ω
    const Ra = g((1 - t) * c.R1), Rb = g(t * c.R1), Rl = g(l * c.R2), Rm = g(m * c.R3), G4 = 1 / c.R4;
    const w0 = TAU * 1000, num = [], den = [];
    for (let k = 0; k < 4; k++) {
      const s = k * w0, y1 = s * c.C1, y2 = s * c.C2, y3 = s * c.C3;
      const Y = [
        [y1 + Ra, -Ra, 0, 0, 0],
        [-Ra, Ra + Rb, -Rb, 0, 0],
        [0, -Rb, Rb + Rl + y2, -Rl, -y2],
        [0, 0, -Rl, Rl + Rm + y3, -y3],
        [0, 0, -y2, -y3, y2 + y3 + G4],
      ];
      const I = [y1, 0, 0, 0, G4];
      den.push(det5(Y));
      num.push(det5(Y.map((row, i) => row.map((v, j) => (j === 1 ? I[i] : v)))));
    }
    const N = cubicThrough(num), D = cubicThrough(den);
    const b = N.map((v, k) => v / Math.pow(w0, k) / D[0]);
    const a = D.map((v, k) => v / Math.pow(w0, k) / D[0]);
    return { b, a };
  }
  // |H(jω)| of the analog tone stack.
  function fmvMag({ b, a }, w) {
    const nr = b[0] - b[2] * w * w, ni = b[1] * w - b[3] * w * w * w;
    const dr = a[0] - a[2] * w * w, di = a[1] * w - a[3] * w * w * w;
    return Math.hypot(nr, ni) / Math.hypot(dr, di);
  }

  // Component values (F, Ω). Marshall and Blackface are the published circuits; the
  // Hiwatt network differs in the real amp, so this is a Marshall-style stack retuned
  // for the Hiwatt's firmer mids.
  const STACKS = {
    marshall: { C1: 470e-12, C2: 22e-9, C3: 22e-9, R1: 220e3, R2: 1e6, R3: 22e3, R4: 33e3 },
    blackface: { C1: 250e-12, C2: 100e-9, C3: 47e-9, R1: 250e3, R2: 250e3, R3: 10e3, R4: 100e3 },
    hiwatt: { C1: 330e-12, C2: 22e-9, C3: 22e-9, R1: 220e3, R2: 1e6, R3: 25e3, R4: 47e3 },
  };
  // g1: first-stage gain range; GAIN 5..10 sweeps sqrt(g1[0]·g1[1])..g1[1]. clean: the
  // first-stage gain at GAIN 0, so the lower half of the knob has real clean headroom
  // (the output is partly made up so it doesn't just get quieter). g2: second stage. hp1/lp1: coupling and
  // Miller filtering around stage 1 (Hz). asym: how much later the negative half clips
  // (even harmonics). bright: bright-cap treble lift at GAIN 0. power: power-stage drive.
  // sag: supply sag depth. presence: post-power treble lift. pre: tone stack before stage 2.
  const AMP_VOICES = {
    PLEXI: { stack: 'marshall', pre: false, g1: [0.12, 20], clean: 0.35, g2: 3, hp1: 120, lp1: 7500, asym: 1.6, bright: 1.0, power: 1.4, sag: 0.5, presence: 0.35, out: 0.53 },
    HIWATT: { stack: 'hiwatt', pre: false, g1: [0.0427, 12], clean: 0.15, g2: 2.5, hp1: 90, lp1: 9000, asym: 1.25, bright: 0.4, power: 1.6, sag: 0.2, presence: 0.2, out: 0.72 },
    FENDER: { stack: 'blackface', pre: true, g1: [0.1225, 8], clean: 0.2, g2: 2.5, hp1: 50, lp1: 11000, asym: 1.35, bright: 0.8, power: 1.1, sag: 0.8, presence: 0.15, out: 1.0 },
  };
  const tube = (x, asym) => (x >= 0 ? Math.tanh(x) : asym * Math.tanh(x / asym));
  const tubeF = (x, asym) => (x >= 0 ? logCosh(x) : asym * asym * logCosh(x / asym));
  const tubeStage = (asym) => new ADAA((x) => tube(x, asym), (x) => tubeF(x, asym));

  class Amp extends PedalProcessor {
    constructor(options) {
      super(options);
      this.os = SR > 60000 ? 2 : 4;
      const fsOS = (this.fsOS = SR * this.os);
      this.up = antiAlias(fsOS);
      this.down = antiAlias(fsOS);
      this.inHP = new OnePole().setCutoff(35, fsOS);
      this.brightLP = new OnePole().setCutoff(1500, fsOS);
      this.hp1 = new OnePole();
      this.lp1 = new OnePole();
      this.hp2 = new OnePole().setCutoff(25, fsOS);
      this.presLP = new OnePole().setCutoff(3000, fsOS);
      this.outDC = new OnePole().setCutoff(10);
      this.sb = [0, 0, 0, 0];
      this.sa = [0, 0, 0];
      this.sz = new Float64Array(3);
      this.env = 0;
      this.envA = 1 - Math.exp(-1 / (fsOS * 0.01));
      this.envR = 1 - Math.exp(-1 / (fsOS * 0.2));
      this.powerStage = new ADAA(Math.tanh, logCosh);
      this.p = { gain: 0.5, bass: 0.5, mid: 0.5, treble: 0.5, volume: 0.5, voice: 'PLEXI' };
      this.voiceName = 'PLEXI';
      this.pending = null;
      this.fade = new Smoother(1, 5);
      this.vol = new Smoother(0, 20);
      this.setParam('volume', this.p.volume);
      this.applyInitial();
      if (this.pending) { this.voiceName = this.pending; this.pending = null; this.fade.set(1); this.fade.snap(); }
      this.vol.snap();
      this.configure();
    }
    setParam(k, v) {
      if (k === 'voice') {
        const name = AMP_VOICES[v] ? v : 'PLEXI';
        this.p.voice = name;
        if (name !== this.voiceName) { this.pending = name; this.fade.set(0); }
        return;
      }
      if (!(k in this.p)) return;
      this.p[k] = clamp(num(v, this.p[k]), 0, 1);
      if (k === 'volume') this.vol.set(1.6 * this.p.volume * this.p.volume);
      else if (k !== 'gain' && this.voice) this.setStack();
    }
    configure() {
      const v = (this.voice = AMP_VOICES[this.voiceName]);
      this.hp1.setCutoff(v.hp1, this.fsOS);
      this.lp1.setCutoff(v.lp1, this.fsOS);
      this.stage1 = tubeStage(v.asym);
      this.stage2 = tubeStage(v.asym);
      // Normalise the stack to unity at 700 Hz with the knobs at noon, so voices match in level.
      this.makeup = 1 / fmvMag(fmvCoeffs(STACKS[v.stack], 0.5, 0.5, audioTaper(0.5)), TAU * 700);
      this.setStack();
    }
    setStack() {
      const p = this.p;
      const { b, a } = fmvCoeffs(STACKS[this.voice.stack], p.treble, p.mid, audioTaper(p.bass));
      // Bilinear transform of the 3rd-order analog filter.
      const c = 2 * this.fsOS, c2 = c * c, c3 = c2 * c;
      const B0 = b[0] + b[1] * c + b[2] * c2 + b[3] * c3, B1 = 3 * b[0] + b[1] * c - b[2] * c2 - 3 * b[3] * c3;
      const B2 = 3 * b[0] - b[1] * c - b[2] * c2 + 3 * b[3] * c3, B3 = b[0] - b[1] * c + b[2] * c2 - b[3] * c3;
      const A0 = 1 + a[1] * c + a[2] * c2 + a[3] * c3, A1 = 3 + a[1] * c - a[2] * c2 - 3 * a[3] * c3;
      const A2 = 3 - a[1] * c - a[2] * c2 + 3 * a[3] * c3, A3 = 1 - a[1] * c + a[2] * c2 - a[3] * c3;
      this.sb = [B0 / A0, B1 / A0, B2 / A0, B3 / A0];
      this.sa = [A1 / A0, A2 / A0, A3 / A0];
    }
    stack(x) { // transposed direct form II
      const b = this.sb, a = this.sa, z = this.sz;
      const y = b[0] * x + z[0];
      z[0] = b[1] * x - a[0] * y + z[1];
      z[1] = b[2] * x - a[1] * y + z[2];
      z[2] = b[3] * x - a[2] * y;
      return y;
    }
    switchVoice() {
      this.voiceName = this.pending;
      this.pending = null;
      this.sz.fill(0);
      this.env = 0;
      this.configure();
      this.fade.set(1);
    }
    render(iL, iR, oL, oR, n) {
      const v = this.voice, os = this.os, [u0, u1, u2, u3] = this.up;
      const [d0, d1, d2, d3] = this.down;
      const gain = this.p.gain;
      const mid = Math.sqrt(v.g1[0] * v.g1[1]);
      const g1 = gain < 0.5 ? v.clean * Math.pow(mid / v.clean, 2 * gain) : mid * Math.pow(v.g1[1] / mid, 2 * gain - 1);
      // Level make-up, so GAIN mostly changes drive rather than volume. Gentler above noon,
      // where the stages are already saturating and limit the level themselves.
      const lift = Math.pow(mid / g1, g1 < mid ? 0.5 : 0.25);
      const bright = v.bright * (1 - gain);
      const makeup = this.makeup, st1 = this.stage1, st2 = this.stage2, pw = this.powerStage;
      for (let s = 0; s < n; s++) {
        const dryL = iL[s], dryR = iR[s];
        const x = 0.5 * (dryL + dryR);
        let y = 0;
        for (let k = 0; k < os; k++) {
          let u = this.inHP.hp(u3.process(u2.process(u1.process(u0.process(k === 0 ? x * os : 0)))));
          u += (u - this.brightLP.lp(u)) * bright;
          u = this.lp1.lp(this.hp1.hp(st1.process(u * g1)));
          if (v.pre) u = this.stack(u) * makeup;
          u = this.hp2.hp(st2.process(u * v.g2));
          if (!v.pre) u = this.stack(u) * makeup;
          let w = pw.process(u * v.power / (1 + v.sag * this.env));
          const aw = Math.abs(w);
          this.env += (aw - this.env) * (aw > this.env ? this.envA : this.envR);
          w += (w - this.presLP.lp(w)) * v.presence;
          y = d3.process(d2.process(d1.process(d0.process(w + DENORM))));
        }
        const wet = this.outDC.hp(y) * v.out * lift * this.vol.next();
        const f = this.fade.next();
        if (this.pending && f < 0.001) this.switchVoice();
        const m = this.mix.next() * f;
        oL[s] = dryL + (wet - dryL) * m;
        oR[s] = dryR + (wet - dryR) * m;
      }
    }
  }

  // ---------------------------------------------------------------- Fuzz Face style fuzz
  //
  // Two transistors: a fixed-gain first stage feeding a second whose gain the FUZZ knob
  // sets (the real pedal's 1 kΩ emitter pot), both clipping asymmetrically. The second
  // stage's bias shifts as it's driven harder, which gives the spitty, blooming decay.
  // On the real pedal, turning the guitar's volume down cleans it up because the pickup's
  // impedance loads the fuzz's low input impedance and cuts its gain. Here, a slow input
  // envelope lowers the gain for quiet playing to get the same feel.
  // GE = germanium (warm, the 1967 sound), SI = silicon (brighter, more gain, 1969-70).
  // Runs 4x oversampled with ADAA.

  // g1: first-stage gain. g2: second-stage gain range swept by FUZZ. asym1/asym2: how much
  // later each stage's negative half clips. bias: stage-2 operating point. bloom: how far
  // the bias moves with level. preLP: pickup loading of the low input impedance (Hz).
  // postLP: transistor roll-off (Hz).
  const FUZZ_VOICES = {
    GE: { g1: 0.8, g2: [1.5, 45], asym1: 1.3, asym2: 2.2, bias: 0.25, bloom: 0.6, preLP: 5000, postLP: 6000, out: 0.1 },
    SI: { g1: 1.2, g2: [2, 70], asym1: 1.2, asym2: 1.7, bias: 0.15, bloom: 0.4, preLP: 7500, postLP: 9000, out: 0.1 },
  };
  const FZ_VOLT = 4;      // same input scaling as the overdrive
  const FZ_PLAYING = 0.05; // input envelope (digital) of ordinary playing; quieter cleans up

  class Fuzz extends PedalProcessor {
    constructor(options) {
      super(options);
      this.os = SR > 60000 ? 2 : 4;
      const fsOS = (this.fsOS = SR * this.os);
      this.up = antiAlias(fsOS);
      this.down = antiAlias(fsOS);
      this.inHP = new OnePole().setCutoff(40, fsOS);
      this.preLP = new OnePole();
      this.postLP = new OnePole();
      this.outHP = new OnePole().setCutoff(30);
      this.env = 0;
      this.envA = 1 - Math.exp(-1 / (fsOS * 0.005));
      this.envR = 1 - Math.exp(-1 / (fsOS * 0.15));
      this.inEnv = 0;
      this.inA = 1 - Math.exp(-1 / (SR * 0.005));
      this.inR = 1 - Math.exp(-1 / (SR * 0.3));
      this.p = { fuzz: 0.7, volume: 0.5, voice: 'GE' };
      this.voiceName = 'GE';
      this.pending = null;
      this.fade = new Smoother(1, 5);
      this.vol = new Smoother(0, 20);
      this.setParam('volume', this.p.volume);
      this.applyInitial();
      if (this.pending) { this.voiceName = this.pending; this.pending = null; this.fade.set(1); this.fade.snap(); }
      this.vol.snap();
      this.configure();
    }
    setParam(k, v) {
      if (k === 'voice') {
        const name = FUZZ_VOICES[v] ? v : 'GE';
        this.p.voice = name;
        if (name !== this.voiceName) { this.pending = name; this.fade.set(0); }
        return;
      }
      if (!(k in this.p)) return;
      this.p[k] = clamp(num(v, this.p[k]), 0, 1);
      if (k === 'volume') this.vol.set(4 * audioTaper(this.p.volume));
    }
    configure() {
      const v = (this.voice = FUZZ_VOICES[this.voiceName]);
      this.preLP.setCutoff(v.preLP, this.fsOS);
      this.postLP.setCutoff(v.postLP, this.fsOS);
      this.st1 = tubeStage(v.asym1);
      this.st2 = tubeStage(v.asym2);
      this.env = 0;
    }
    render(iL, iR, oL, oR, n) {
      const v = this.voice, os = this.os, [u0, u1, u2, u3] = this.up, [d0, d1, d2, d3] = this.down;
      const g2 = v.g2[0] * Math.pow(v.g2[1] / v.g2[0], this.p.fuzz);
      const st1 = this.st1, st2 = this.st2;
      for (let s = 0; s < n; s++) {
        const dryL = iL[s], dryR = iR[s];
        const x = 0.5 * (dryL + dryR);
        const a = Math.abs(x);
        this.inEnv += (a - this.inEnv) * (a > this.inEnv ? this.inA : this.inR);
        const cleanup = clamp(Math.sqrt(this.inEnv / FZ_PLAYING), 0.3, 1);
        const xin = x * FZ_VOLT * cleanup;
        let y = 0;
        for (let k = 0; k < os; k++) {
          let u = u3.process(u2.process(u1.process(u0.process(k === 0 ? xin * os : 0))));
          u = this.preLP.lp(this.inHP.hp(u));
          u = st1.process(u * v.g1);
          let w = st2.process(u * g2 + v.bias - v.bloom * this.env);
          const aw = Math.abs(w);
          this.env += (aw - this.env) * (aw > this.env ? this.envA : this.envR);
          w = this.postLP.lp(w);
          y = d3.process(d2.process(d1.process(d0.process(w + DENORM))));
        }
        const wet = this.outHP.hp(y) * v.out * this.vol.next();
        const f = this.fade.next();
        if (this.pending && f < 0.001) { this.voiceName = this.pending; this.pending = null; this.configure(); this.fade.set(1); }
        const m = this.mix.next() * f;
        oL[s] = dryL + (wet - dryL) * m;
        oR[s] = dryR + (wet - dryR) * m;
      }
    }
  }

  // ---------------------------------------------------------------- Uni-Vibe style vibe
  //
  // Four phase-shift stages whose resistors are light-dependent (LDRs), all lit by one
  // incandescent lamp that the LFO drives. The stages use very different capacitors, so
  // their notches move unevenly; that's the throb, rather than a smooth phaser sweep. The
  // lamp heats faster than it cools and the LDRs respond logarithmically to light, so the
  // sweep is lopsided too. CHORUS = dry + shifted (moving notches), VIBRATO = shifted only
  // (pitch wobble). The lamp brightness is posted ~30x/s so the page can light the lamp.

  const VIBE_CAPS = [15e-9, 220e-9, 470e-12, 4.7e-9]; // the Uni-Vibe's stage capacitors
  const LDR_BRIGHT = 30e3, LDR_DARK = 800e3;          // LDR range (Ω): main notch sweeps ~240 Hz..3.3 kHz

  class Vibe extends PedalProcessor {
    constructor(options) {
      super(options);
      this.p = { speed: 0.35, intensity: 0.7, mode: 'CHO' };
      this.s = new Float64Array(4);
      this.phase = 0;
      this.lamp = 0.5;
      this.lampUp = 1 - Math.exp(-1 / (SR * 0.008));
      this.lampDown = 1 - Math.exp(-1 / (SR * 0.035));
      this.speedHz = new Smoother(1, 60);
      this.depth = new Smoother(0.7, 60);
      this.dryAmt = new Smoother(0.5, 20);
      this.blocks = 0;
      this.lastSent = -1;
      this.applyInitial();
      this.speedHz.snap();
      this.depth.snap();
      this.dryAmt.snap();
    }
    setParam(k, v) {
      if (k === 'mode') {
        this.p.mode = v === 'VIB' ? 'VIB' : 'CHO';
        this.dryAmt.set(this.p.mode === 'VIB' ? 0 : 0.5);
        return;
      }
      if (!(k in this.p)) return;
      this.p[k] = clamp(num(v, this.p[k]), 0, 1);
      if (k === 'speed') this.speedHz.set(0.3 * Math.pow(30, this.p.speed)); // 0.3 .. 9 Hz
      else if (k === 'intensity') this.depth.set(this.p.intensity);
    }
    render(iL, iR, oL, oR, n) {
      const st = this.s, ln = Math.log(LDR_DARK / LDR_BRIGHT), piSR = Math.PI / SR, fMax = SR * 0.45;
      for (let s = 0; s < n; s++) {
        const dryL = iL[s], dryR = iR[s];
        const x = 0.5 * (dryL + dryR);
        this.phase += this.speedHz.next() / SR;
        if (this.phase >= 1) this.phase -= 1;
        const target = 0.5 + 0.5 * Math.sin(TAU * this.phase);
        this.lamp += (target - this.lamp) * (target > this.lamp ? this.lampUp : this.lampDown);
        const light = 0.15 + 0.8 * this.depth.next() * this.lamp;
        const r = LDR_BRIGHT * Math.exp(ln * (1 - light));
        let y = x;
        for (let i = 0; i < 4; i++) { // first-order TPT allpass: 2·lowpass − input
          const g = Math.tan(piSR * Math.min(1 / (TAU * r * VIBE_CAPS[i]), fMax));
          const vv = (y - st[i]) * g / (1 + g);
          const lp = vv + st[i];
          st[i] = lp + vv + DENORM;
          y = 2 * lp - y;
        }
        const d = this.dryAmt.next();
        const wet = (d * x + (1 - d) * y) * (1 + 0.1 * (this.lamp - 0.5) * this.p.intensity); // a little lamp throb
        const m = this.mix.next();
        oL[s] = dryL + (wet - dryL) * m;
        oR[s] = dryR + (wet - dryR) * m;
      }
      if (++this.blocks >= 12) {
        this.blocks = 0;
        const v = this.engaged ? this.lamp : 0;
        if (Math.abs(v - this.lastSent) > 0.01) { this.lastSent = v; this.port.postMessage({ type: 'pos', value: v }); }
      }
    }
  }

  // ---------------------------------------------------------------- input conditioner
  //
  // Sits between the interface and the pedals, so everything after it sees a quieter
  // input: a 25 Hz high-pass for DC and handling rumble, notches on the mains hum (50 or
  // 60 Hz and its harmonics), then a noise gate. Hum has to come out here, before any
  // drive: once it goes through a clipper it turns into buzz spread across the spectrum.
  // The gate sits before the pedals too, so reverb and echo tails are never cut off.
  // Params: hum = 0 | 50 | 60, gate = threshold in dBFS (-90 or below = off).
  // {type:'learn'} listens to ~2 s of the idle guitar, picks the hum setting that leaves
  // the least residue, sets the gate so it stays shut on the noise and posts {type:'learned'}.
  // Gate open/close changes are posted as {type:'gate', open}.

  const HUM_HARMONICS = 8;
  const HUM_BW = 2.5; // notch width (Hz): deep on the mains line, under 1 dB on notes beside it (B2, G#4)
  const GATE_OFF_DB = -90;

  class HumNotch {
    constructor(f0) {
      this.bq = [];
      for (let h = 1; h <= HUM_HARMONICS && f0 * h < SR * 0.45; h++) this.bq.push(new Biquad().notch(f0 * h, f0 * h / HUM_BW));
    }
    process(x) { for (let i = 0; i < this.bq.length; i++) x = this.bq[i].process(x); return x; }
  }

  class InputConditioner extends PedalProcessor {
    constructor(options) {
      super(options);
      this.hp = new Biquad().set(...(() => { // 2nd-order Butterworth high-pass at 25 Hz
        const w = TAU * 25 / SR, c = Math.cos(w), al = Math.sin(w) / Math.SQRT2;
        return [(1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al];
      })());
      this.notch = null;
      this.p = { hum: 0, gate: GATE_OFF_DB };
      this.thr = 0;
      this.env = 0;
      this.envA = 1 - Math.exp(-1 / (SR * 0.0005));
      this.envR = 1 - Math.exp(-1 / (SR * 0.02));
      this.gA = 1 - Math.exp(-1 / (SR * 0.0008)); // opens in ~1 ms, so pick attack survives
      this.gR = 1 - Math.exp(-1 / (SR * 0.08));   // closes smoothly, like a note dying away
      this.holdLen = Math.round(SR * 0.06);
      this.hold = 0;
      this.open = true;
      this.g = 1;
      this.learn = null;
      this.applyInitial();
    }
    onMessage(m) {
      if (m && m.type === 'learn') {
        this.learn = { n: 0, settle: Math.round(SR * 0.4), len: Math.round(SR * 1.5),
          cand: [0, 50, 60].map((hz) => ({ hz, f: hz ? new HumNotch(hz) : null, ss: 0, env: 0, max: 0 })) };
      } else super.onMessage(m);
    }
    setParam(k, v) {
      if (k === 'hum') {
        const hz = +v === 50 || +v === 60 ? +v : 0;
        if (hz !== this.p.hum) { this.p.hum = hz; this.notch = hz ? new HumNotch(hz) : null; }
      } else if (k === 'gate') {
        this.p.gate = clamp(num(v, GATE_OFF_DB), GATE_OFF_DB, 0);
        this.thr = this.p.gate <= GATE_OFF_DB ? 0 : Math.pow(10, this.p.gate / 20);
      }
    }
    learnStep(x) {
      const L = this.learn;
      for (const c of L.cand) {
        const y = c.f ? c.f.process(x) : x;
        if (L.n < L.settle) continue; // let the notches ring in first
        c.ss += y * y;
        const a = Math.abs(y);
        c.env += (a - c.env) * (a > c.env ? this.envA : this.envR);
        if (c.env > c.max) c.max = c.env;
      }
      if (++L.n < L.settle + L.len) return;
      this.learn = null;
      const rmsOf = (c) => Math.sqrt(c.ss / L.len);
      const [none, ...hums] = L.cand;
      let best = hums[0].ss < hums[1].ss ? hums[0] : hums[1];
      if (rmsOf(best) > rmsOf(none) * 0.84) best = none; // under 1.5 dB of hum: leave the notches off
      const db = (v) => 20 * Math.log10(v + 1e-12);
      const peakDb = db(best.max);
      const result = { type: 'learned', floorDb: db(rmsOf(best)), peakDb, hum: best.hz, humCutDb: db(rmsOf(none)) - db(rmsOf(best)) };
      if (peakDb > -35) { result.tooLoud = true; this.port.postMessage(result); return; }
      if (peakDb < -110) { result.noSignal = true; this.port.postMessage(result); return; } // nothing connected
      // The gate closes 6 dB below its threshold, so put that close level ~3 dB over the
      // noise peaks; otherwise one stray peak opens it and the noise itself holds it open.
      result.gateDb = Math.round(clamp(peakDb + 9, -80, -35));
      this.setParam('hum', best.hz);
      this.setParam('gate', result.gateDb);
      this.port.postMessage(result);
    }
    render(iL, iR, oL, oR, n) {
      const thr = this.thr, wasOpen = this.open;
      for (let s = 0; s < n; s++) {
        let x = this.hp.process(0.5 * (iL[s] + iR[s]) + DENORM);
        if (this.learn) this.learnStep(x);
        if (this.notch) x = this.notch.process(x);
        if (thr > 0) {
          const a = Math.abs(x);
          this.env += (a - this.env) * (a > this.env ? this.envA : this.envR);
          if (this.env > thr) { this.open = true; this.hold = this.holdLen; }
          else if (this.open && this.env < thr * 0.5 && --this.hold <= 0) this.open = false; // 6 dB hysteresis, then hold
        } else this.open = true;
        const t = this.open ? 1 : 0;
        this.g += (t - this.g) * (t > this.g ? this.gA : this.gR);
        oL[s] = oR[s] = x * this.g;
      }
      if (this.open !== wasOpen) this.port.postMessage({ type: 'gate', open: this.open });
    }
  }

  // ---------------------------------------------------------------- loop recorder
  //
  // Captures segments of the board's output at absolute frames on the audio clock, so a take
  // lines up with the metronome to the sample however late the page's timers run. The page
  // arms one segment per chord; each is posted back the moment it is full, so playback of the
  // first chords can begin before the last one has finished recording.
  class Recorder extends AudioWorkletProcessor {
    constructor() {
      super();
      this.segs = [];
      this.session = 0;
      this.port.onmessage = (e) => {
        const m = e.data;
        if (!m) return;
        if (m.type === 'arm') {
          this.session = m.session;
          // The page sends the buffers along, so nothing is allocated on the audio thread.
          this.segs = m.segs.map((s) => ({ key: s.key, start: s.start, len: s.len, ch: s.ch || [new Float32Array(s.len), new Float32Array(s.len)] }));
        } else if (m.type === 'cancel') this.segs = [];
      };
    }
    process(inputs) {
      if (!this.segs.length) return true;
      const inp = inputs[0] || [];
      const f0 = currentFrame, n = inp[0] ? inp[0].length : 128;
      for (let i = 0; i < this.segs.length; i++) {
        const s = this.segs[i];
        const a = Math.max(f0, s.start), b = Math.min(f0 + n, s.start + s.len);
        if (b > a && inp[0]) {
          for (let c = 0; c < 2; c++) s.ch[c].set((inp[c] || inp[0]).subarray(a - f0, b - f0), a - s.start);
        }
        if (f0 + n >= s.start + s.len) {
          this.port.postMessage({ type: 'take', session: this.session, key: s.key, ch: s.ch }, s.ch.map((c) => c.buffer));
          this.segs.splice(i--, 1);
        }
      }
      return true;
    }
  }

  registerProcessor('neon-input', InputConditioner);
  registerProcessor('neon-rec', Recorder);
  registerProcessor('neon-fuzz', Fuzz);
  registerProcessor('neon-vibe', Vibe);
  registerProcessor('neon-amp', Amp);
  registerProcessor('neon-wah', Wah);
  registerProcessor('neon-ts', TubeScreamer);
  registerProcessor('neon-chorus', Chorus);
  registerProcessor('neon-trem', Tremolo);
  registerProcessor('neon-echo', TapeEcho);
  registerProcessor('neon-phaser', Phaser);
  registerProcessor('neon-flanger', Flanger);
  registerProcessor('neon-reverb', Reverb);
  return { InputConditioner, Recorder, Tremolo, TapeEcho, Phaser, Flanger, Fuzz, Vibe, FUZZ_VOICES, Amp, Wah, TubeScreamer, Chorus, Reverb, RV_MODES, fmvCoeffs, fmvMag, STACKS, AMP_VOICES };
}
