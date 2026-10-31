/* NEON RIG: pedalboard UI, layout and audio routing. The DSP lives in dsp.js. */
(() => {
  'use strict';

  const BOARD_KEY = 'neonrig.board.v1';
  const PRESET_KEY = 'neonrig.presets.v1';
  const GRID = 10;
  const JACK_Y = 66; // cable height on a pedal, px from its top edge
  const GAP = 72;

  const $ = (sel, root = document) => root.querySelector(sel);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const snap = (v) => Math.round(v / GRID) * GRID;
  const uid = () => Math.random().toString(36).slice(2, 10);
  const dbToGain = (db) => Math.pow(10, db / 20);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage unavailable */ } },
  };

  // ------------------------------------------------------------------ pedal catalogue

  const REVERB_MODES = ['ROOM', 'HALL', 'PLATE', 'SPRING', 'MODULATE', '+DELAY', 'SHIMMER', 'DYNAMIC'];
  const PEDALS = {
    wah: {
      title: 'VOLT WAH', sub: 'CRY BABY STYLE WAH', proc: 'neon-wah',
      accent: '#ffb02e', w: 176, h: 300, footswitch: 'round', sweep: true,
      knobs: [
        { k: 'pos', label: 'POSITION', def: 0.15, tip: 'Where the pedal sits, heel (dark) to toe (bright). AUTO starts its sweep here; FIXED stays here.' },
        { k: 'sens', label: 'SENS', def: 0.5, tip: 'AUTO: how easily your picking opens the wah.' },
        { k: 'rate', label: 'RATE', def: 0.35, tip: 'LFO: how fast the wah sweeps by itself.' }],
      modes: { k: 'mode', kind: 'switch', def: 'AUTO', options: [
        ['AUTO', 'AUTO', 'Your picking opens the wah: dig in for more quack.'],
        ['LFO', 'LFO', 'The wah sweeps by itself at RATE.'],
        ['FIX', 'FIXED', 'A parked wah at POSITION: the vocal "woman tone" honk.']] },
    },
    fuzz: {
      title: 'PLASMA FUZZ', sub: 'FUZZ FACE STYLE FUZZ', proc: 'neon-fuzz',
      accent: '#ff3db4', w: 176, h: 300, footswitch: 'round',
      knobs: [
        { k: 'fuzz', label: 'FUZZ', def: 0.7, tip: 'How much fuzz. Rolling back your guitar\'s volume cleans it up too.' },
        { k: 'volume', label: 'VOLUME', def: 0.5, tip: 'Output level. Around noon matches bypass.' }],
      modes: { k: 'voice', kind: 'switch', def: 'GE', options: [
        ['GE', 'GERMANIUM', 'Warm and smooth: the 1967 Hendrix sound.'],
        ['SI', 'SILICON', 'Brighter, more gain and bite: Hendrix 1969-70.']] },
    },
    ts: {
      title: 'NEON SCREAMER', sub: 'TS-808 STYLE OVERDRIVE', proc: 'neon-ts',
      accent: '#3dff8f', w: 176, h: 300, footswitch: 'round',
      knobs: [
        { k: 'drive', label: 'DRIVE', def: 0.5, tip: 'How much overdrive.' },
        { k: 'tone', label: 'TONE', def: 0.5, tip: 'Darker to brighter.' },
        { k: 'level', label: 'LEVEL', def: 0.5, tip: 'Output level. Turn it up to push an amp harder.' }],
    },
    vibe: {
      title: 'ORBIT VIBE', sub: 'UNI-VIBE STYLE', proc: 'neon-vibe',
      accent: '#6f8bff', w: 176, h: 300, footswitch: 'treadle', lamp: true,
      knobs: [
        { k: 'speed', label: 'SPEED', def: 0.35, tip: 'How fast it throbs.' },
        { k: 'intensity', label: 'INTENSITY', def: 0.7, tip: 'How deep the sweep goes.' }],
      modes: { k: 'mode', kind: 'switch', def: 'CHO', options: [
        ['CHO', 'CHORUS', 'Dry plus swirled signal: the classic throb.'],
        ['VIB', 'VIBRATO', 'Only the swirled signal, so the pitch wobbles.']] },
    },
    phaser: {
      title: 'QUASAR PHASE', sub: 'PHASE 90 STYLE PHASER', proc: 'neon-phaser',
      accent: '#ff8c1a', w: 176, h: 300, footswitch: 'round',
      knobs: [
        { k: 'speed', label: 'SPEED', def: 0.35, tip: 'How fast it sweeps. Low: slow, watery swirl. High: fast, bubbly warble.' }],
      modes: { k: 'mode', kind: 'switch', def: 'SCRIPT', options: [
        ['SCRIPT', 'SCRIPT', 'The early, smooth version: subtle and warm. Great in front of a crunchy amp.'],
        ['BLOCK', 'BLOCK', 'The later version, with feedback: a sharper, more vocal sweep.']] },
    },
    flanger: {
      title: 'WARP FLANGER', sub: 'BF-2 STYLE FLANGER', proc: 'neon-flanger',
      accent: '#a0b4ff', w: 200, h: 300, footswitch: 'treadle',
      knobs: [
        { k: 'manual', label: 'MANUAL', def: 0.5, tip: 'Where the sweep sits, darker to brighter. With DEPTH down you can sweep it by hand.' },
        { k: 'depth', label: 'DEPTH', def: 0.6, tip: 'How wide the sweep goes.' },
        { k: 'rate', label: 'RATE', def: 0.3, tip: 'How fast it sweeps. Slow is the classic jet plane.' },
        { k: 'res', label: 'RES', def: 0.5, tip: 'Resonance: more makes the sweep sharper and more metallic.' }],
    },
    chorus: {
      title: 'CHROMA CHORUS', sub: 'CE-2W STYLE CHORUS', proc: 'neon-chorus',
      accent: '#2ee6ff', w: 176, h: 300, footswitch: 'treadle',
      knobs: [
        { k: 'rate', label: 'RATE', def: 0.35, tip: 'How fast the chorus moves.' },
        { k: 'depth', label: 'DEPTH', def: 0.5, tip: 'How wide the shimmer is.' }],
      modes: { k: 'mode', kind: 'switch', def: 'S', options: [
        ['S', 'STD', 'Standard CE-2 chorus.'],
        ['C', 'CE-1 CHO', 'CE-1 chorus: wider, in stereo.'],
        ['V', 'CE-1 VIB', 'CE-1 vibrato: pitch wobble, no dry signal.']] },
    },
    trem: {
      title: 'STROBE TREM', sub: 'TR-2 STYLE TREMOLO', proc: 'neon-trem',
      accent: '#e4ff3d', w: 176, h: 300, footswitch: 'round',
      knobs: [
        { k: 'rate', label: 'RATE', def: 0.45, tip: 'How fast the volume pulses.' },
        { k: 'depth', label: 'DEPTH', def: 0.6, tip: 'How far the volume dips. Full = all the way down on each pulse.' }],
      modes: { k: 'wave', kind: 'switch', def: 'SINE', options: [
        ['SINE', 'SINE', 'Smooth, even swell.'],
        ['OPTO', 'OPTO', 'Old Fender amp tremolo: a quick dip and a slower swell back. The western twang.'],
        ['SQR', 'CHOP', 'Hard on/off pulses, like a helicopter.']] },
    },
    echo: {
      title: 'GHOST ECHO', sub: 'ECHOPLEX STYLE TAPE ECHO', proc: 'neon-echo',
      accent: '#ff7a9e', w: 176, h: 300, footswitch: 'treadle',
      knobs: [
        { k: 'time', label: 'TIME', def: 0.5, tip: 'Delay between repeats, 60 ms (slapback) to 750 ms. Turning it while it repeats bends the pitch, like moving the tape head.' },
        { k: 'repeats', label: 'REPEATS', def: 0.35, tip: 'How many times it repeats. Each repeat comes back darker, like tape. Full up runs away into a wash.' },
        { k: 'mix', label: 'MIX', def: 0.35, tip: 'How loud the repeats are. The dry guitar stays at full level.' }],
    },
    amp: {
      title: 'NEON STACK', sub: 'PLEXI · HIWATT · FENDER STYLE AMP', proc: 'neon-amp',
      accent: '#ff6a3d', w: 290, h: 300, footswitch: 'toggle', grille: true,
      knobs: [
        { k: 'gain', label: 'GAIN', def: 0.5, tip: 'Below noon: clean. Above: crunch up to full drive.' },
        { k: 'bass', label: 'BASS', def: 0.5, tip: 'Tone stack. Like the real amp, BASS, MIDDLE and TREBLE affect each other.' },
        { k: 'mid', label: 'MIDDLE', def: 0.5, tip: 'Tone stack: more MIDDLE helps a solo cut through.' },
        { k: 'treble', label: 'TREBLE', def: 0.5, tip: 'Tone stack: roll it right down for Clapton\'s woman tone.' },
        { k: 'volume', label: 'VOLUME', def: 0.5, tip: 'Amp output level. Around noon matches bypass.' }],
      modes: { k: 'voice', kind: 'switch', def: 'PLEXI', options: [
        ['PLEXI', 'PLEXI', 'Marshall Plexi: Hendrix, Zeppelin, Cream.'],
        ['HIWATT', 'HIWATT', 'Hiwatt: huge, loud and clear. The Who.'],
        ['FENDER', 'FENDER', 'Fender Blackface: sparkly cleans. Put the SCREAMER in front for SRV.']] },
    },
    reverb: {
      title: 'VOID VERB', sub: 'RV-6 STYLE REVERB', proc: 'neon-reverb',
      accent: '#c45cff', w: 200, h: 300, footswitch: 'treadle',
      knobs: [
        { k: 'level', label: 'E.LEVEL', def: 0.35, tip: 'How much reverb is mixed in.' },
        { k: 'tone', label: 'TONE', def: 0.5, tip: 'Darker to brighter reverb.' },
        { k: 'time', label: 'TIME', def: 0.45, tip: 'How long the reverb rings (echo time in +DELAY).' }],
      modes: { k: 'mode', kind: 'rotary', def: 1, options: REVERB_MODES },
    },
  };

  // Saved boards and presets come back from storage, which anything on the same origin can write
  // (every file:// page shares one in Chrome), so only known pedal types and in-range values get in.
  const isPedal = (type) => typeof type === 'string' && Object.prototype.hasOwnProperty.call(PEDALS, type);
  const safeId = (id) => (typeof id === 'string' && /^[a-z0-9]{1,16}$/i.test(id) ? id : uid());
  function makePedal(type, over = {}) {
    const d = PEDALS[type];
    const params = {};
    const given = over.params || {};
    for (const k of d.knobs) params[k.k] = Number.isFinite(given[k.k]) ? clamp(given[k.k], 0, 1) : k.def;
    if (d.modes) {
      const v = given[d.modes.k], m = d.modes;
      const ok = m.kind === 'rotary' ? Number.isInteger(v) && v >= 0 && v < m.options.length : m.options.some(([o]) => o === v);
      params[m.k] = ok ? v : m.def;
    }
    return {
      id: safeId(over.id), type,
      x: Number.isFinite(over.x) ? over.x : 0,
      y: Number.isFinite(over.y) ? over.y : 0,
      on: over.on !== false,
      params,
    };
  }

  // A preset with cab: false is meant for a real amp and switches CAB SIM off when loaded.
  const FACTORY = [
    { name: 'Neon Default', pedals: [
      ['wah', false, { mode: 'AUTO', pos: 0.15, sens: 0.5, rate: 0.35 }],
      ['ts', true, { drive: 0.45, tone: 0.5, level: 0.5 }],
      ['chorus', true, { rate: 0.3, depth: 0.5, mode: 'S' }],
      ['reverb', true, { level: 0.35, tone: 0.5, time: 0.45, mode: 1 }]] },
    { name: 'Glass Shimmer (clean)', pedals: [
      ['ts', false, { drive: 0.3, tone: 0.5, level: 0.5 }],
      ['chorus', true, { rate: 0.25, depth: 0.7, mode: 'C' }],
      ['reverb', true, { level: 0.5, tone: 0.6, time: 0.6, mode: 6 }]] },
    { name: 'Blues Crunch + Spring', pedals: [
      ['ts', true, { drive: 0.65, tone: 0.55, level: 0.6 }],
      ['chorus', false, { rate: 0.3, depth: 0.4, mode: 'S' }],
      ['reverb', true, { level: 0.3, tone: 0.45, time: 0.4, mode: 3 }]] },
    { name: 'Vibrato Haze', pedals: [
      ['ts', false, { drive: 0.4, tone: 0.5, level: 0.5 }],
      ['chorus', true, { rate: 0.45, depth: 0.55, mode: 'V' }],
      ['reverb', true, { level: 0.4, tone: 0.5, time: 0.55, mode: 2 }]] },
    { name: 'Funk Auto-Wah', pedals: [
      ['wah', true, { mode: 'AUTO', pos: 0.08, sens: 0.6, rate: 0.35 }],
      ['ts', false, { drive: 0.3, tone: 0.55, level: 0.5 }],
      ['chorus', false, { rate: 0.3, depth: 0.4, mode: 'S' }],
      ['reverb', true, { level: 0.25, tone: 0.55, time: 0.3, mode: 0 }]] },
    { name: 'Wah Lead (LFO sweep)', pedals: [
      ['wah', true, { mode: 'LFO', pos: 0.1, sens: 0.5, rate: 0.45 }],
      ['ts', true, { drive: 0.7, tone: 0.5, level: 0.55 }],
      ['reverb', true, { level: 0.3, tone: 0.5, time: 0.5, mode: 1 }]] },
    { name: 'Plexi Crunch (Zeppelin)', pedals: [
      ['ts', false, { drive: 0.3, tone: 0.5, level: 0.6 }],
      ['amp', true, { voice: 'PLEXI', gain: 0.7, bass: 0.55, mid: 0.7, treble: 0.6, volume: 0.5 }],
      ['reverb', true, { level: 0.25, tone: 0.5, time: 0.4, mode: 2 }]] },
    { name: 'Hiwatt Roar (The Who)', pedals: [
      ['amp', true, { voice: 'HIWATT', gain: 0.75, bass: 0.6, mid: 0.65, treble: 0.55, volume: 0.5 }],
      ['reverb', true, { level: 0.2, tone: 0.5, time: 0.3, mode: 0 }]] },
    { name: 'Texas Blues (SRV)', pedals: [
      ['wah', false, { mode: 'AUTO', pos: 0.15, sens: 0.5, rate: 0.35 }],
      ['ts', true, { drive: 0.2, tone: 0.55, level: 0.85 }],
      ['amp', true, { voice: 'FENDER', gain: 0.55, bass: 0.45, mid: 0.45, treble: 0.6, volume: 0.5 }],
      ['reverb', true, { level: 0.3, tone: 0.5, time: 0.35, mode: 3 }]] },
    { name: 'Clean Fender + Spring', pedals: [
      ['chorus', false, { rate: 0.25, depth: 0.4, mode: 'C' }],
      ['amp', true, { voice: 'FENDER', gain: 0.15, bass: 0.5, mid: 0.45, treble: 0.6, volume: 0.6 }],
      ['reverb', true, { level: 0.3, tone: 0.5, time: 0.35, mode: 3 }]] },
    // Hendrix's board order: wah > germanium Fuzz Face > Uni-Vibe > cranked Marshall.
    // The wah sits ready to kick on. Roll the guitar's volume back to clean the fuzz up.
    { name: 'Psychedelic Hendrix', pedals: [
      ['wah', false, { mode: 'AUTO', pos: 0.1, sens: 0.65, rate: 0.35 }],
      ['fuzz', true, { voice: 'GE', fuzz: 0.6, volume: 0.6 }],
      ['vibe', true, { mode: 'CHO', speed: 0.3, intensity: 0.75 }],
      ['amp', true, { voice: 'PLEXI', gain: 0.65, bass: 0.5, mid: 0.6, treble: 0.6, volume: 0.5 }],
      ['reverb', true, { level: 0.2, tone: 0.5, time: 0.45, mode: 2 }]] },
    // Band of Gypsys, 1970: silicon Fuzz Face into a pushed Marshall, a medium Uni-Vibe throb, a
    // short plate. Fuzz moderate so the pickup selector and picking still change the sound.
    { name: 'Machine Gun (Band of Gypsys)', pedals: [
      ['wah', false, { mode: 'AUTO', pos: 0.1, sens: 0.65, rate: 0.35 }],
      ['fuzz', true, { voice: 'SI', fuzz: 0.55, volume: 0.55 }],
      ['vibe', true, { mode: 'CHO', speed: 0.28, intensity: 0.65 }],
      ['amp', true, { voice: 'PLEXI', gain: 0.7, bass: 0.55, mid: 0.65, treble: 0.45, volume: 0.5 }],
      ['reverb', true, { level: 0.15, tone: 0.45, time: 0.4, mode: 2 }]] },
    // Cream-era Clapton: Marshall cranked, treble rolled right off, and a parked wah for
    // the vocal "woman tone" honk. Use the neck pickup with its tone knob down.
    { name: 'Cream Woman Tone (Clapton)', pedals: [
      ['wah', true, { mode: 'FIX', pos: 0.3, sens: 0.5, rate: 0.35 }],
      ['ts', true, { drive: 0.35, tone: 0.4, level: 0.7 }],
      ['amp', true, { voice: 'PLEXI', gain: 0.8, bass: 0.6, mid: 0.75, treble: 0.3, volume: 0.5 }],
      ['reverb', true, { level: 0.18, tone: 0.45, time: 0.35, mode: 0 }]] },
    { name: 'Lead + Echo Hall', pedals: [
      ['ts', true, { drive: 0.8, tone: 0.6, level: 0.55 }],
      ['chorus', true, { rate: 0.2, depth: 0.35, mode: 'C' }],
      ['reverb', true, { level: 0.35, tone: 0.55, time: 0.5, mode: 5 }]] },
    // Glassy Texas blues: a clean, bright Fender with the SCREAMER as a clean boost (level up,
    // drive down) for edge and sparkle, and a little spring. Best on the middle or neck+middle pickups.
    { name: 'Texas Glass Blues', pedals: [
      ['ts', true, { drive: 0.12, tone: 0.68, level: 0.62 }],
      ['amp', true, { voice: 'FENDER', gain: 0.35, bass: 0.4, mid: 0.4, treble: 0.72, volume: 0.5 }],
      ['reverb', true, { level: 0.28, tone: 0.6, time: 0.4, mode: 3 }]] },
    // Spaghetti western: twangy clean Fender, Fender-style opto tremolo, a short tape echo and a
    // deep, drippy spring. Bridge pickup, play low on the neck.
    { name: 'Spaghetti Western', pedals: [
      ['amp', true, { voice: 'FENDER', gain: 0.25, bass: 0.45, mid: 0.4, treble: 0.68, volume: 0.72 }],
      ['trem', true, { wave: 'OPTO', rate: 0.42, depth: 0.65 }],
      ['echo', true, { time: 0.55, repeats: 0.3, mix: 0.3 }],
      ['reverb', true, { level: 0.45, tone: 0.55, time: 0.55, mode: 3 }]] },
    // Tape-echo lead, a starting point for GHOST ECHO: a pushed Plexi with ~290 ms repeats that
    // sit behind the notes, and only a touch of reverb so the echoes stay clear.
    { name: 'Echoplex Lead (tape echo)', pedals: [
      ['ts', true, { drive: 0.55, tone: 0.55, level: 0.6 }],
      ['amp', true, { voice: 'PLEXI', gain: 0.6, bass: 0.55, mid: 0.65, treble: 0.55, volume: 0.5 }],
      ['echo', true, { time: 0.62, repeats: 0.35, mix: 0.32 }],
      ['reverb', true, { level: 0.15, tone: 0.5, time: 0.35, mode: 2 }]] },
    // Phaser template: a slow SCRIPT phaser into a cranked Plexi, the late-70s hard-rock swirl.
    { name: 'Phase Crunch (QUASAR PHASE)', pedals: [
      ['phaser', true, { speed: 0.3, mode: 'SCRIPT' }],
      ['amp', true, { voice: 'PLEXI', gain: 0.72, bass: 0.55, mid: 0.65, treble: 0.6, volume: 0.5 }],
      ['reverb', true, { level: 0.2, tone: 0.5, time: 0.4, mode: 2 }]] },
    // Flanger template: a slow, resonant jet sweep on a clean-ish Fender, with a little plate.
    { name: 'Jet Flanger (WARP FLANGER)', pedals: [
      ['flanger', true, { manual: 0.45, depth: 0.7, rate: 0.22, res: 0.65 }],
      ['amp', true, { voice: 'FENDER', gain: 0.4, bass: 0.5, mid: 0.5, treble: 0.6, volume: 0.55 }],
      ['reverb', true, { level: 0.22, tone: 0.5, time: 0.4, mode: 2 }]] },
    // Your board > interface > NEON RIG > interface line out (left) > the amp. Chorus and reverb only.
    { name: 'Real Amp: Chorus + Reverb', cab: false, pedals: [
      ['chorus', true, { rate: 0.3, depth: 0.45, mode: 'S' }],
      ['reverb', true, { level: 0.25, tone: 0.5, time: 0.45, mode: 2 }]] },
  ];
  const fromSpec = (spec) => spec.map(([type, on, params]) => makePedal(type, { on, params }));

  // ------------------------------------------------------------------ state

  // Mains frequency, guessed from the time zone: 60 Hz in most of the Americas and a few
  // Asian countries, 50 Hz nearly everywhere else. LEARN NOISE measures it properly.
  function guessMains() {
    let tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* no Intl */ }
    if (/^America\/(Argentina|Santiago|Punta_Arenas|Montevideo|Asuncion|La_Paz)/.test(tz)) return 50;
    return /^(America\/|US\/|Canada\/|Pacific\/Honolulu|Asia\/(Seoul|Taipei|Manila|Riyadh))/.test(tz) ? 60 : 50;
  }
  const DEFAULT_IO = {
    inGain: 0, master: -6, cab: true, channel: 'auto', inputId: '', outputId: '',
    hum: guessMains(), gate: -70, latency: 'interactive', devices: 2, // inputId/outputId '' = AUTO
  };
  // Metronome + looper settings. A chord is a label plus a length in beats; the audio recorded
  // over it lives in memory only (see `take`), keyed by the chord's id.
  const ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  // Chord types, in the editor's three rows: triads, sixths and sevenths, extended.
  const QUAL_ROWS = [
    ['TRIAD', ['', 'm', '5', 'sus2', 'sus4', 'aug', 'dim']],
    ['6 / 7', ['6', 'm6', '7', 'm7', 'maj7', '7sus4', 'dim7', 'm7b5']],
    ['EXT', ['9', 'm9', 'maj9', 'add9', '11', '13', '7#9']],
  ];
  const QUALS = QUAL_ROWS.flatMap(([, qs]) => qs);
  const LENS = [1, 2, 3, 4, 6, 8];
  const MAX_CHORDS = 32;
  const chord = (root, q = '', len = 4) => ({ id: uid(), root, q, len });
  const REPEATS = [0, 1, 2, 3, 4, 6, 8, 12, 16]; // 0 = until STOP
  const DEFAULT_LOOP = { bpm: 90, meter: 4, clickVol: -12, loopVol: 0, sync: 0, repeat: 0 };
  function loadLoop(saved) {
    const lp = { ...DEFAULT_LOOP, ...(saved && typeof saved === 'object' ? saved : {}) };
    const num = (v, lo, hi, def) => (Number.isFinite(v) ? clamp(v, lo, hi) : def);
    if (!REPEATS.includes(lp.repeat)) lp.repeat = 0;
    lp.bpm = Math.round(num(lp.bpm, 40, 240, DEFAULT_LOOP.bpm));
    lp.meter = [2, 3, 4, 5, 6, 7].includes(lp.meter) ? lp.meter : 4;
    lp.clickVol = num(lp.clickVol, -40, 0, DEFAULT_LOOP.clickVol);
    lp.loopVol = num(lp.loopVol, -40, 6, DEFAULT_LOOP.loopVol);
    lp.sync = Math.round(num(lp.sync, -100, 200, 0));
    const ok = (c) => c && ROOTS.includes(c.root) && QUALS.includes(c.q) && LENS.includes(c.len);
    const seen = new Set();
    lp.chords = (Array.isArray(lp.chords) ? lp.chords : []).filter(ok).slice(0, MAX_CHORDS).map((c) => {
      let id = safeId(c.id);
      while (seen.has(id)) id = uid();
      seen.add(id);
      return { id, root: c.root, q: c.q, len: c.len };
    });
    if (!saved) lp.chords = [chord('G'), chord('D'), chord('E', 'm'), chord('C')];
    return lp;
  }

  let needsArrange = false;
  const board = loadBoard();

  function loadBoard() {
    const saved = store.get(BOARD_KEY);
    if (saved && Array.isArray(saved.pedals)) {
      const io = { ...DEFAULT_IO, ...(saved.io && typeof saved.io === 'object' ? saved.io : {}) };
      // Older saves pinned whatever device was in use; move them to AUTO so plug-and-go works.
      if (!saved.io || saved.io.devices !== 2) Object.assign(io, { inputId: '', outputId: '', devices: 2 });
      for (const k of ['inGain', 'master', 'gate']) if (!Number.isFinite(io[k])) io[k] = DEFAULT_IO[k];
      io.inGain = clamp(io.inGain, -12, 24);
      io.master = clamp(io.master, -40, 6);
      io.gate = clamp(io.gate, -90, -30);
      if (![0, 50, 60].includes(io.hum)) io.hum = DEFAULT_IO.hum;
      if (!['interactive', '0.02', '0.04'].includes(io.latency)) io.latency = 'interactive';
      if (!['auto', '1', '2', 'mix'].includes(io.channel)) io.channel = 'auto';
      for (const k of ['inputId', 'outputId']) if (typeof io[k] !== 'string') io[k] = '';
      io.cab = io.cab !== false;
      const seen = new Set();
      const pedals = saved.pedals.filter((p) => p && isPedal(p.type)).map((p) => makePedal(p.type, p));
      for (const p of pedals) { while (seen.has(p.id)) p.id = uid(); seen.add(p.id); }
      return { pedals, io, loop: loadLoop(saved.loop) };
    }
    needsArrange = true;
    return { pedals: fromSpec(FACTORY[0].pedals), io: { ...DEFAULT_IO }, loop: loadLoop() };
  }

  let saveTimer = 0;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set(BOARD_KEY, board), 250);
  }

  // ------------------------------------------------------------------ audio engine

  const A = {
    ctx: null, running: false, nodes: new Map(), stream: null, src: null,
    inChannels: 2, inputLabel: '', inputId: '', outputId: '', knownIns: new Set(), autoCh: '1', rewireTimer: 0,

    async start() {
      if (!this.ctx) await this.init();
      await this.ctx.resume();
      await this.openInput();
      await this.routeOutput();
      this.running = true;
      await refreshDevices();
    },

    stop() {
      stopTransport();
      this.closeInput();
      if (this.ctx) this.ctx.suspend();
      this.running = false;
    },
    closeInput() {
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.src) this.src.disconnect();
      this.stream = null; this.src = null; this.inputId = ''; this.inputLabel = '';
    },

    async init() {
      if (!window.AudioWorkletNode || !navigator.mediaDevices) {
        throw new Error('This browser cannot run NEON RIG. Use a current Chrome, Edge or Safari.');
      }
      // Chromium treats 'balanced' like 'interactive'; a number in seconds really grows the buffer.
      const ctx = new AudioContext({ latencyHint: Number(board.io.latency) || 'interactive' });
      // Blob URL works on http(s); Chromium refuses blob: worklets on file:// pages but accepts data:.
      // Going straight to data: on file:// keeps the refused blob attempt out of the console.
      const code = `(${NEON_RIG_DSP.toString()})();`;
      const dataUrl = () => `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
      if (location.protocol === 'file:') {
        await ctx.audioWorklet.addModule(dataUrl());
      } else {
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        try {
          await ctx.audioWorklet.addModule(url);
        } catch {
          await ctx.audioWorklet.addModule(dataUrl());
        } finally {
          URL.revokeObjectURL(url);
        }
      }

      const an = () => new AnalyserNode(ctx, { fftSize: 1024 });
      this.split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
      this.chGain = [new GainNode(ctx), new GainNode(ctx)];
      this.chMeter = [an(), an()];
      this.inSum = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit' });
      // Hum filter + noise gate, ahead of GAIN so a learned gate threshold stays valid.
      this.cond = new AudioWorkletNode(ctx, 'neon-input', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
        processorOptions: { params: { hum: board.io.hum, gate: board.io.gate } },
      });
      this.cond.port.onmessage = (e) => onConditioner(e.data);
      this.inGain = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit' });
      this.inMeter = an();
      this.chainIn = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit' });
      this.chainOut = new GainNode(ctx);
      for (let c = 0; c < 2; c++) {
        this.split.connect(this.chGain[c], c);
        this.split.connect(this.chMeter[c], c);
        this.chGain[c].connect(this.inSum);
      }
      this.inSum.connect(this.cond);
      this.cond.connect(this.inGain);
      this.inGain.connect(this.inMeter);
      this.inGain.connect(this.chainIn);

      // Speaker-cab voicing: tames the fizz of overdrive straight into headphones.
      const cabSpec = [
        ['highpass', 80, 0.8, 0], ['peaking', 120, 1.0, 2.5], ['peaking', 400, 1.0, -2],
        ['peaking', 2400, 1.4, 3], ['lowpass', 5200, 0.9, 0], ['lowpass', 7500, 0.6, 0],
      ];
      this.cabDry = new GainNode(ctx);
      this.cabWet = new GainNode(ctx);
      let prev = this.chainOut;
      for (const [type, frequency, Q, gain] of cabSpec) {
        const f = new BiquadFilterNode(ctx, { type, frequency, Q, gain });
        prev.connect(f);
        prev = f;
      }
      prev.connect(this.cabWet);
      this.chainOut.connect(this.cabDry);

      this.master = new GainNode(ctx);
      // The looper records the board here, ahead of MASTER, the click and its own playback.
      this.post = new GainNode(ctx);
      this.cabDry.connect(this.post);
      this.cabWet.connect(this.post);
      this.post.connect(this.master);
      this.rec = new AudioWorkletNode(ctx, 'neon-rec', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit',
      });
      this.rec.port.onmessage = (e) => onTake(e.data);
      const recSink = new GainNode(ctx, { gain: 0 }); // keeps the recorder pulled by the graph
      this.post.connect(this.rec);
      this.rec.connect(recSink);
      recSink.connect(ctx.destination);
      this.loopOut = new GainNode(ctx);
      this.clickOut = new GainNode(ctx);
      this.loopOut.connect(this.master);
      this.clickOut.connect(this.master);
      // Gentle ceiling just below full scale so overs fold softly rather than crack.
      const curve = new Float32Array(2049);
      for (let i = 0; i < curve.length; i++) {
        const x = i / 1024 - 1, a = Math.abs(x);
        curve[i] = a < 0.85 ? x : Math.sign(x) * (0.85 + 0.15 * Math.tanh((a - 0.85) / 0.15));
      }
      this.limiter = new WaveShaperNode(ctx, { curve, oversample: '4x' }); // 4x: peaks fold without aliasing
      this.outMeter = an();
      this.master.connect(this.limiter);
      this.limiter.connect(ctx.destination);
      this.limiter.connect(this.outMeter);

      this.ctx = ctx;
      this.applyIO();
      this.rewire(true);
    },

    // Rebuild the audio graph, e.g. for a new buffer size (only settable at creation).
    async rebuild() {
      const wasRunning = this.running;
      this.stop();
      clearTimeout(this.rewireTimer);
      if (this.ctx) await this.ctx.close();
      this.ctx = null; this.outputId = '';
      this.nodes.clear();
      if (wasRunning) await this.start();
    },

    // Opens the chosen input, or with INPUT on AUTO `prefer` (a device just plugged in) or the
    // most guitar-like device there is.
    async openInput(prefer) {
      this.closeInput();
      let list = await navigator.mediaDevices.enumerateDevices();
      if (!list.some((d) => d.kind === 'audioinput' && d.label)) {
        // Device names are only readable once access has been granted, so ask first.
        (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
        list = await navigator.mediaDevices.enumerateDevices();
      }
      const has = (x) => !!x && list.some((d) => d.kind === 'audioinput' && d.deviceId === x);
      this.knownIns = new Set(list.filter((d) => d.kind === 'audioinput').map((d) => d.deviceId));
      let id = board.io.inputId;
      if (!has(id)) id = has(prefer) ? prefer : bestInput(list);
      const audio = {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: 2 }, latency: { ideal: 0 },
      };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: id ? { ...audio, deviceId: { exact: id } } : audio });
      const track = stream.getAudioTracks()[0];
      const st = track.getSettings();
      this.stream = stream;
      this.src = this.ctx.createMediaStreamSource(stream);
      this.src.connect(this.split);
      this.inChannels = st.channelCount || 2;
      this.inputLabel = track.label || '';
      this.inputId = st.deviceId || id;
      // Scarlett Solo: input 1 is the mic XLR, input 2 the instrument jack.
      this.autoCh = this.inChannels > 1 && /solo/i.test(this.inputLabel) ? '2' : '1';
      this.applyChannel();
    },
    // OUTPUT on AUTO plays out of the box the guitar comes in on (the Scarlett's headphone jack);
    // a guitar cable with no output of its own (Rocksmith) plays through the computer's default.
    async routeOutput(loud) {
      if (!this.ctx || !sinkSupported) return;
      const list = await navigator.mediaDevices.enumerateDevices();
      let id = board.io.outputId;
      if (!id || !list.some((d) => d.kind === 'audiooutput' && d.deviceId === id)) id = outputFor(list, this.inputId);
      if (id !== this.outputId) {
        await this.setSink(id, !loud);
        this.outputId = id;
      }
      const out = list.find((d) => d.kind === 'audiooutput' && d.deviceId === (id || 'default'));
      if (out && BLUETOOTH_RE.test(out.label) && !this.btWarned) {
        this.btWarned = true;
        toast('Bluetooth headphones add 150-300 ms of delay, too much to play along. Use wired headphones or your interface\'s headphone jack.', null, null, true);
      }
    },
    // Plug and go: follow guitar devices being plugged in or pulled out while running.
    async followDevices() {
      if (!this.running) return;
      const list = await navigator.mediaDevices.enumerateDevices();
      const has = (id) => list.some((d) => d.kind === 'audioinput' && d.deviceId === id);
      const track = this.stream && this.stream.getAudioTracks()[0];
      const live = !!track && track.readyState === 'live' && has(this.inputId);
      // The guitar device you just plugged in wins; otherwise stay put while the input lives.
      const fresh = list.find((d) => d.kind === 'audioinput' && !isPseudo(d) && !this.knownIns.has(d.deviceId) && inputScore(d) > 0);
      this.knownIns = new Set(list.filter((d) => d.kind === 'audioinput').map((d) => d.deviceId));
      const want = board.io.inputId && has(board.io.inputId) ? board.io.inputId
        : fresh ? fresh.deviceId : live ? this.inputId : bestInput(list);
      try {
        if (want && want !== this.inputId) {
          await this.openInput(want);
          toast(`Input: ${shortName(this.inputLabel)}`);
        } else if (!live && this.stream) {
          // Don't fall back to the laptop mic mid-song: through a fuzz that howls.
          this.closeInput();
          toast('Guitar input unplugged. Plug it back in and NEON RIG picks it up.', null, null, true);
        }
        await this.routeOutput();
      } catch (err) { toast(audioErrorHelp(err), null, null, true); }
    },

    channel() {
      if (this.inChannels < 2) return '1';
      return board.io.channel === 'auto' ? this.autoCh : board.io.channel;
    },
    applyChannel() {
      if (!this.ctx) return;
      const ch = this.channel();
      const [a, b] = ch === '1' ? [1, 0] : ch === '2' ? [0, 1] : [0.7, 0.7];
      this.chGain[0].gain.setTargetAtTime(a, this.ctx.currentTime, 0.01);
      this.chGain[1].gain.setTargetAtTime(b, this.ctx.currentTime, 0.01);
      showChannel();
    },
    applyIO() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime, io = board.io;
      this.inGain.gain.setTargetAtTime(dbToGain(io.inGain), t, 0.01);
      this.master.gain.setTargetAtTime(io.master <= -40 ? 0 : dbToGain(io.master), t, 0.01);
      this.cabWet.gain.setTargetAtTime(io.cab ? 1 : 0, t, 0.01);
      this.cabDry.gain.setTargetAtTime(io.cab ? 0 : 1, t, 0.01);
      const lp = board.loop;
      this.loopOut.gain.setTargetAtTime(lp.loopVol <= -40 ? 0 : dbToGain(lp.loopVol), t, 0.01);
      this.clickOut.gain.setTargetAtTime(lp.clickVol <= -40 ? 0 : dbToGain(lp.clickVol), t, 0.01);
      this.cond.port.postMessage({ type: 'param', name: 'hum', value: io.hum });
      this.cond.port.postMessage({ type: 'param', name: 'gate', value: io.gate });
      this.applyChannel();
    },
    async setSink(id, quiet) {
      if (!this.ctx || typeof this.ctx.setSinkId !== 'function') return;
      try { await this.ctx.setSinkId(id || ''); } catch (err) {
        if (!quiet) toast(`Could not switch output: ${err.message}`, null, null, true);
      }
    },

    syncNodes() {
      const ids = new Set(board.pedals.map((p) => p.id));
      for (const [id, n] of this.nodes) {
        if (ids.has(id)) continue;
        n.disconnect();
        n.port.postMessage({ type: 'dispose' });
        this.nodes.delete(id);
      }
      for (const p of board.pedals) {
        if (this.nodes.has(p.id)) continue;
        const node = new AudioWorkletNode(this.ctx, PEDALS[p.type].proc, {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
          processorOptions: { params: { ...p.params }, engaged: p.on },
        });
        node.port.onmessage = (e) => { if (e.data && e.data.type === 'pos') showSweep(p.id, e.data.value); };
        this.nodes.set(p.id, node);
      }
    },
    // Re-patch the chain in board order. Fades the chain output briefly to avoid clicks.
    rewire(immediate) {
      if (!this.ctx) return;
      this.syncNodes();
      const patch = () => {
        this.chainIn.disconnect();
        this.nodes.forEach((n) => n.disconnect());
        let prev = this.chainIn;
        for (const p of board.pedals) { const n = this.nodes.get(p.id); prev.connect(n); prev = n; }
        prev.connect(this.chainOut);
      };
      clearTimeout(this.rewireTimer);
      if (immediate) { patch(); return; }
      const g = this.chainOut.gain;
      g.setTargetAtTime(0, this.ctx.currentTime, 0.004);
      this.rewireTimer = setTimeout(() => { patch(); g.setTargetAtTime(1, this.ctx.currentTime, 0.008); }, 30);
    },
    param(p, name, value) {
      const n = this.nodes.get(p.id);
      if (n) n.port.postMessage({ type: 'param', name, value });
    },
    engaged(p) {
      const n = this.nodes.get(p.id);
      if (n) n.port.postMessage({ type: 'engaged', value: p.on });
    },
    latencyMs() {
      const c = this.ctx;
      const st = this.stream ? this.stream.getAudioTracks()[0].getSettings() : {};
      const input = typeof st.latency === 'number' ? st.latency : 0.01;
      return (input + (c.baseLatency || 0) + (c.outputLatency || 0)) * 1000;
    },
  };

  // ------------------------------------------------------------------ device pickers

  const inSel = $('#inputDevice'), outSel = $('#outputDevice'), chSel = $('#inputChannel');
  const sinkSupported = typeof AudioContext !== 'undefined' && typeof AudioContext.prototype.setSinkId === 'function';

  // AUTO input ranking: a guitar cable or known interface beats a generic USB device, which beats
  // the laptop's own mic, a webcam or a headset. Below zero is never auto-picked.
  const GUITAR_RE = /rocksmith|real ?tone|guitar|instrument|focusrite|scarlett|irig|line ?6|helix|pod go|katana|positive grid|spark|behringer|umc\d|presonus|audiobox|audient|motu|\bssl\b|steinberg|universal audio|apollo|arturia|minifuse|m-audio|komplete audio|tascam|roland|boss|nux|mooer|valeton|fender/i;
  const AVOID_RE = /webcam|camera|headset|hands-?free|bluetooth|airpods|array|built-?in|internal|realtek|iphone|continuity|virtual|stereo mix|voicemeeter|cable output|broadcast|teams/i;
  const BLUETOOTH_RE = /bluetooth|airpods|hands-?free|buds|bose|wh-1000|beats/i;
  const isPseudo = (d) => !d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications';
  // "Microphone (Scarlett Solo USB)" -> "Scarlett Solo USB" (Windows wraps names; Mac doesn't).
  const shortName = (l) => ((/\(([^)]+)\)\s*$/.exec(l || '') || [])[1] || l || '').trim();
  function inputScore(d) {
    const l = d.label || '';
    return (GUITAR_RE.test(l) ? 4 : 0) + (/usb|line/i.test(l) ? 1 : 0) - (AVOID_RE.test(l) ? 3 : 0);
  }
  function bestInput(list) {
    let best = '', top = 0;
    for (const d of list) {
      if (d.kind !== 'audioinput' || isPseudo(d)) continue;
      const sc = inputScore(d);
      if (sc > top) { top = sc; best = d.deviceId; }
    }
    return best;
  }
  function outputFor(list, inId) {
    const inDev = list.find((d) => d.kind === 'audioinput' && d.deviceId === inId);
    if (!inDev || inputScore(inDev) <= 0) return '';
    const outs = list.filter((d) => d.kind === 'audiooutput' && !isPseudo(d));
    const hit = outs.find((d) => inDev.groupId && d.groupId === inDev.groupId) ||
      outs.find((d) => shortName(d.label) === shortName(inDev.label));
    return hit ? hit.deviceId : '';
  }

  // Turn getUserMedia failures into steps the player can act on.
  function audioErrorHelp(err) {
    const name = (err && err.name) || '', msg = (err && err.message) || String(err);
    const mac = /Mac/i.test(navigator.platform || navigator.userAgent);
    const osFix = mac
      ? 'Mac: System Settings > Privacy & Security > Microphone, and switch on your browser.'
      : 'Windows: Settings > Privacy & security > Microphone, and switch on "Let desktop apps access your microphone".';
    if (name === 'NotAllowedError' && /system/i.test(msg)) return `Your computer is blocking audio input. ${osFix} Then restart the browser and press START.`;
    if (name === 'NotAllowedError') return `Audio input was blocked. Click the icon at the left of the address bar and allow the microphone. If it's already allowed, check the system setting. ${osFix}`;
    if (name === 'NotReadableError' || name === 'AbortError') return 'The guitar input is busy or unavailable. Close other audio apps (recording software, or a game that came with your guitar cable), replug the interface or cable, and in Windows Sound settings untick "Allow applications to take exclusive control" for it.';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No audio input was found. Check the interface or guitar cable is plugged in and shows up in your system sound settings.';
    return `Audio could not start: ${msg}`;
  }

  function fillSelect(sel, devices, current, autoText) {
    sel.innerHTML = `<option value="">${esc(autoText)}</option>` + devices.map((d) =>
      `<option value="${esc(d.deviceId)}">${esc(shortName(d.label))}</option>`).join('');
    sel.value = devices.some((d) => d.deviceId === current) ? current : '';
  }
  async function refreshDevices() {
    const list = await navigator.mediaDevices.enumerateDevices();
    const named = (kind) => list.filter((d) => d.kind === kind && d.label && !isPseudo(d));
    const auto = (name) => (A.running ? `AUTO: ${name}` : 'AUTO');
    fillSelect(inSel, named('audioinput'), board.io.inputId, auto(A.stream ? shortName(A.inputLabel) : 'unplugged'));
    if (!sinkSupported) return;
    const outs = named('audiooutput');
    const cur = outs.find((d) => d.deviceId === A.outputId);
    fillSelect(outSel, outs, board.io.outputId, auto(cur ? shortName(cur.label) : 'computer default'));
  }
  function showChannel() {
    const ch = A.channel();
    chSel.options[0].textContent = A.ctx ? `AUTO (IN ${ch === 'mix' ? '1+2' : ch})` : 'AUTO';
    $('#mCh1').classList.toggle('selected', ch === '1' || ch === 'mix');
    $('#mCh2').classList.toggle('selected', ch === '2' || ch === 'mix');
  }

  // ------------------------------------------------------------------ knobs & switches

  const KC = 2 * Math.PI * 22, ARC = 0.75;
  const KNOB_SVG = `<svg viewBox="0 0 60 60" aria-hidden="true">
      <circle class="k-track" cx="30" cy="30" r="22" stroke-dasharray="${KC * ARC} ${KC}" transform="rotate(135 30 30)"/>
      <circle class="k-val" cx="30" cy="30" r="22" transform="rotate(135 30 30)"/>
      <circle class="k-cap" cx="30" cy="30" r="15"/>
      <line class="k-ptr" x1="30" y1="30" x2="30" y2="18"/>
    </svg>`;

  function paintKnob(el, v) {
    el.querySelector('.k-val').setAttribute('stroke-dasharray', `${KC * ARC * v} ${KC}`);
    el.querySelector('.k-ptr').setAttribute('transform', `rotate(${-135 + 270 * v} 30 30)`);
  }

  // Vertical drag, wheel, arrow keys and double-click reset for anything dial-like (0..1).
  function bindDial(el, get, set, { steps = 0, def } = {}) {
    el.tabIndex = 0;
    const stepSize = (fine) => (steps ? 1 / (steps - 1) : fine ? 0.005 : 0.025);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      el.focus({ preventScroll: true });
      el.setPointerCapture(e.pointerId);
      el.classList.add('active');
      const y0 = e.clientY, v0 = get();
      const move = (ev) => set(clamp(v0 + (y0 - ev.clientY) / (ev.shiftKey ? 800 : 180), 0, 1));
      const up = () => {
        el.classList.remove('active');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      set(clamp(get() + (e.deltaY < 0 ? 1 : -1) * stepSize(e.shiftKey), 0, 1));
    }, { passive: false });
    el.addEventListener('keydown', (e) => {
      const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      set(clamp(get() + dir * stepSize(e.shiftKey), 0, 1));
    });
    if (def !== undefined) el.addEventListener('dblclick', () => set(def));
  }

  function makeKnob(p, spec) {
    const el = document.createElement('div');
    el.className = 'knob';
    el.title = `${spec.label}${spec.tip ? `: ${spec.tip}` : ''}\nDrag up/down or scroll. Shift = fine, double-click = reset.`;
    el.innerHTML = `${KNOB_SVG}<span class="k-label">${spec.label}</span><span class="k-read"></span>`;
    const read = el.querySelector('.k-read');
    const show = (v) => { paintKnob(el, v); read.textContent = (v * 10).toFixed(1); };
    show(p.params[spec.k]);
    bindDial(el, () => p.params[spec.k], (v) => {
      if (v === p.params[spec.k]) return;
      show(v);
      setParam(p, spec.k, v);
    }, { def: spec.def });
    return el;
  }

  function makeModeKnob(p, spec, lcd) {
    const n = spec.options.length;
    const el = document.createElement('div');
    el.className = 'knob mode';
    el.title = 'MODE: Room, Hall, Plate, Spring, Modulate, +Delay, Shimmer or Dynamic.\nDrag, scroll or click the display.';
    el.innerHTML = `${KNOB_SVG}<span class="k-label">MODE</span><span class="k-read"></span>`;
    const read = el.querySelector('.k-read');
    const show = (i) => {
      paintKnob(el, i / (n - 1));
      lcd.textContent = spec.options[i];
      read.textContent = spec.options[i];
    };
    const choose = (i) => {
      i = (i + n) % n;
      if (i !== p.params.mode) setParam(p, spec.k, i);
      show(i);
    };
    show(p.params.mode);
    bindDial(el, () => p.params.mode / (n - 1), (v) => choose(Math.round(v * (n - 1))), { steps: n, def: spec.def / (n - 1) });
    lcd.addEventListener('pointerdown', (e) => e.stopPropagation());
    lcd.addEventListener('click', (e) => choose(p.params.mode + (e.shiftKey ? -1 : 1)));
    lcd.addEventListener('contextmenu', (e) => { e.preventDefault(); choose(p.params.mode - 1); });
    lcd.title = 'Click for next mode, right-click for previous';
    return el;
  }

  function makeSwitch(p, spec) {
    const el = document.createElement('div');
    el.className = 'modesw';
    for (const [value, label, tip] of spec.options) {
      const b = document.createElement('button');
      b.textContent = label;
      if (tip) b.title = `${label}: ${tip}`;
      b.dataset.v = value;
      b.classList.toggle('active', p.params[spec.k] === value);
      b.addEventListener('click', () => {
        setParam(p, spec.k, value);
        el.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      });
      el.appendChild(b);
    }
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    return el;
  }

  // ------------------------------------------------------------------ board rendering

  const wrapEl = $('#boardWrap'), boardEl = $('#board'), cablesEl = $('#cables');
  const jackIn = $('#jackIn'), jackOut = $('#jackOut');
  let zTop = 10;

  function buildPedal(p, index) {
    const d = PEDALS[p.type];
    const el = document.createElement('div');
    el.className = `pedal pedal-${p.type}${p.on ? ' on' : ''}`;
    el.dataset.id = p.id;
    el.style.cssText = `left:${p.x}px;top:${p.y}px;width:${d.w}px;height:${d.h}px;--accent:${d.accent}`;
    el.innerHTML = `
      <span class="jack jack-in" title="Input"></span><span class="jack jack-out" title="Output"></span>
      <button class="pedal-x" title="Remove pedal">×</button>
      <div class="pedal-top"><span class="pedal-index">${String(index + 1).padStart(2, '0')}</span><span class="led"></span><span style="width:20px"></span></div>
      <div class="knob-row"></div>
      <div class="pedal-name">${d.title}</div>
      <div class="pedal-sub">${d.sub}</div>
      <div class="mode-slot"></div>
      ${d.grille ? '<div class="grille"></div>' : ''}
      <button class="footswitch ${d.footswitch}" title="${d.footswitch === 'toggle' ? 'Amp power. Off passes your guitar straight through.' : 'Footswitch: click to turn the pedal on or off. The LED shows it.'}"><span></span></button>`;
    const row = el.querySelector('.knob-row'), slot = el.querySelector('.mode-slot');
    for (const k of d.knobs) row.appendChild(makeKnob(p, k));
    if (d.modes && d.modes.kind === 'rotary') {
      const lcd = document.createElement('div');
      lcd.className = 'lcd';
      row.appendChild(makeModeKnob(p, d.modes, lcd));
      slot.appendChild(lcd);
    } else if (d.modes) {
      slot.appendChild(makeSwitch(p, d.modes));
    }
    if (d.sweep) {
      slot.insertAdjacentHTML('afterend',
        '<div class="sweep" title="Live wah position"><i></i></div><div class="sweep-labels"><span>HEEL</span><span>TOE</span></div>');
      el.style.setProperty('--sweep', p.params.pos);
    }
    if (d.lamp) {
      slot.insertAdjacentHTML('afterend', '<div class="lamp" title="The lamp: its brightness drives the sweep"><i></i></div>');
      el.style.setProperty('--sweep', 0.5);
    }

    const fs = el.querySelector('.footswitch');
    fs.addEventListener('pointerdown', (e) => e.stopPropagation());
    fs.addEventListener('click', () => toggle(p));
    const x = el.querySelector('.pedal-x');
    x.addEventListener('pointerdown', (e) => e.stopPropagation());
    x.addEventListener('click', () => removePedal(p));
    el.addEventListener('pointerdown', (e) => startPedalDrag(e, p, el));
    return el;
  }

  function showSweep(id, v) {
    const el = boardEl.querySelector(`.pedal[data-id="${id}"]`);
    if (el) el.style.setProperty('--sweep', v.toFixed(3));
  }

  function renderBoard() {
    boardEl.querySelectorAll('.pedal').forEach((e) => e.remove());
    board.pedals.forEach((p, i) => boardEl.appendChild(buildPedal(p, i)));
    renderChain();
    fitBoard();
    drawCables();
  }

  function fitBoard() {
    let w = wrapEl.clientWidth, h = wrapEl.clientHeight;
    for (const p of board.pedals) {
      const d = PEDALS[p.type];
      w = Math.max(w, p.x + d.w + 140);
      h = Math.max(h, p.y + d.h + 40);
    }
    boardEl.style.width = `${w}px`;
    boardEl.style.height = `${h}px`;
    cablesEl.setAttribute('width', w);
    cablesEl.setAttribute('height', h);
    const top = `${Math.round(h / 2 - 40)}px`;
    jackIn.style.top = top;
    jackOut.style.top = top;
  }

  function cablePath(a, b) {
    const span = Math.abs(b.x - a.x), fwd = b.x - a.x;
    // Forward runs get a gentle droop; backward runs loop out and around.
    const dx = fwd > 0 ? clamp(fwd * 0.5, 20, 200) : 90 + Math.min(120, -fwd * 0.25);
    const sag = 18 + Math.min(70, span * 0.06 + Math.abs(b.y - a.y) * 0.1);
    return `M${a.x},${a.y} C${a.x + dx},${a.y + sag} ${b.x - dx},${b.y + sag} ${b.x},${b.y}`;
  }
  // Reads live element positions so cables follow drags and the ARRANGE animation.
  function drawCables() {
    let prev = { x: jackIn.offsetLeft + jackIn.offsetWidth, y: jackIn.offsetTop + jackIn.offsetHeight / 2, color: '#ff2e88', dim: false };
    let svg = '';
    const seg = (a, b) => {
      const d = cablePath(a, b);
      svg += `<path class="c-glow" d="${d}" stroke="${a.color}"/><path class="c-core" d="${d}"/>` +
        `<path class="c-flow${a.dim ? ' dim' : ''}" d="${d}" stroke="${a.color}"/>`;
    };
    for (const p of board.pedals) {
      const el = boardEl.querySelector(`.pedal[data-id="${p.id}"]`);
      if (!el) continue;
      const x = el.offsetLeft, y = el.offsetTop + JACK_Y;
      seg(prev, { x: x - 9, y });
      prev = { x: x + el.offsetWidth + 9, y, color: PEDALS[p.type].accent, dim: !p.on };
    }
    seg(prev, { x: jackOut.offsetLeft, y: jackOut.offsetTop + jackOut.offsetHeight / 2 });
    cablesEl.innerHTML = svg;
  }

  function startPedalDrag(e, p, el) {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.style.zIndex = ++zTop;
    el.classList.add('dragging');
    const sx = e.clientX, sy = e.clientY, ox = p.x, oy = p.y;
    const move = (ev) => {
      p.x = Math.max(0, snap(ox + ev.clientX - sx));
      p.y = Math.max(0, snap(oy + ev.clientY - sy));
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      fitBoard();
      drawCables();
    };
    const up = () => {
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      save();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // Lay pedals out left to right in chain order, wrapping rows if the window is narrow.
  function arrange(animate) {
    const width = Math.max(wrapEl.clientWidth, 600);
    const left = 140, right = width - 140;
    const rows = [[]];
    let x = left;
    for (const p of board.pedals) {
      const w = PEDALS[p.type].w;
      if (x + w > right && x > left) { rows.push([]); x = left; }
      rows[rows.length - 1].push(p);
      x += w + GAP;
    }
    const rowH = 300 + 70;
    const top = Math.max(30, (wrapEl.clientHeight - rows.length * rowH + 70) / 2);
    rows.forEach((row, r) => {
      const rowW = row.reduce((s, p) => s + PEDALS[p.type].w, 0) + GAP * (row.length - 1);
      let cx = left + Math.max(0, (right - left - rowW) / 2);
      for (const p of row) {
        p.x = snap(cx);
        p.y = snap(top + r * rowH);
        cx += PEDALS[p.type].w + GAP;
      }
    });

    if (animate) boardEl.classList.add('arranging');
    for (const p of board.pedals) {
      const el = boardEl.querySelector(`.pedal[data-id="${p.id}"]`);
      if (el) { el.style.left = `${p.x}px`; el.style.top = `${p.y}px`; }
    }
    fitBoard();
    if (animate) {
      const t0 = performance.now();
      const follow = () => {
        drawCables();
        if (performance.now() - t0 < 420) requestAnimationFrame(follow);
        else { boardEl.classList.remove('arranging'); drawCables(); }
      };
      requestAnimationFrame(follow);
    } else {
      drawCables();
    }
    save();
  }

  function focusPedal(id) {
    const el = boardEl.querySelector(`.pedal[data-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  // ------------------------------------------------------------------ chain bar

  const chainEl = $('#chain');
  function renderChain() {
    chainEl.innerHTML = '<span class="chain-end">GUITAR</span>';
    board.pedals.forEach((p, i) => {
      const d = PEDALS[p.type];
      chainEl.insertAdjacentHTML('beforeend', '<span class="chain-arrow">▸</span>');
      const chip = document.createElement('div');
      chip.className = `chip${p.on ? ' on' : ''}`;
      chip.dataset.id = p.id;
      chip.style.setProperty('--accent', d.accent);
      chip.title = 'Drag to reorder, click to find on the board';
      chip.innerHTML = `<span class="chip-n">${i + 1}</span>${d.title}`;
      bindChipDrag(chip, board.pedals, p, () => focusPedal(p.id), chainChanged);
      chainEl.appendChild(chip);
    });
    chainEl.insertAdjacentHTML('beforeend', '<span class="chain-arrow">▸</span><span class="chain-end">AMP</span>');
  }

  // Drag a chip sideways to move `item` within `list` (the pedal chain, or the loop's chords).
  function bindChipDrag(chip, list, item, onClick, onMoved) {
    chip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || chip.closest('.locked')) return;
      e.preventDefault();
      chip.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      const r0 = chip.getBoundingClientRect();
      const centre0 = r0.left + r0.width / 2;
      const others = [...chip.parentElement.querySelectorAll(':scope > [data-id]')].filter((c) => c !== chip)
        .map((c) => { const r = c.getBoundingClientRect(); return r.left + r.width / 2; });
      let moved = false;
      const move = (ev) => {
        const dx = ev.clientX - x0;
        if (Math.abs(dx) > 4) moved = true;
        if (moved) { chip.classList.add('dragging'); chip.style.transform = `translateX(${dx}px)`; }
      };
      const up = (ev) => {
        chip.removeEventListener('pointermove', move);
        chip.removeEventListener('pointerup', up);
        chip.removeEventListener('pointercancel', up);
        chip.classList.remove('dragging');
        chip.style.transform = '';
        if (!moved) { onClick(); return; }
        const to = others.filter((c) => c < centre0 + ev.clientX - x0).length;
        const from = list.indexOf(item);
        if (to === from) return;
        list.splice(from, 1);
        list.splice(to, 0, item);
        onMoved();
      };
      chip.addEventListener('pointermove', move);
      chip.addEventListener('pointerup', up);
      chip.addEventListener('pointercancel', up);
    });
  }

  // ------------------------------------------------------------------ edits

  function chainChanged() {
    renderBoard();
    A.rewire();
    save();
  }
  function setParam(p, k, v) {
    p.params[k] = v;
    A.param(p, k, v);
    save();
  }
  function toggle(p) {
    p.on = !p.on;
    A.engaged(p);
    const el = boardEl.querySelector(`.pedal[data-id="${p.id}"]`);
    if (el) el.classList.toggle('on', p.on);
    const chip = chainEl.querySelector(`.chip[data-id="${p.id}"]`);
    if (chip) chip.classList.toggle('on', p.on);
    drawCables();
    save();
  }
  // Where a new pedal goes in the chain (-1 = the end). Drag its chip to move it after.
  // Wah first; fuzz straight after the wah (as on Hendrix's board); the vibe, phaser and flanger
  // in front of the amp (as on Van Halen's board); the amp after the drives and before modulation
  // and reverb, like an effects loop. After the amp: chorus, then tremolo, then echo, reverb last.
  function insertAt(type) {
    const first = (pred) => { const i = board.pedals.findIndex(pred); return i < 0 ? board.pedals.length : i; };
    const before = (...types) => first((q) => types.includes(q.type));
    if (type === 'wah') return 0;
    if (type === 'fuzz') return first((q) => q.type !== 'wah');
    if (type === 'vibe' || type === 'phaser' || type === 'flanger') return before('amp', 'chorus', 'trem', 'echo', 'reverb');
    if (type === 'amp') return before('chorus', 'trem', 'echo', 'reverb');
    if (type === 'chorus') return before('trem', 'echo', 'reverb');
    if (type === 'trem') return before('echo', 'reverb');
    if (type === 'echo') return before('reverb');
    return -1;
  }
  function addPedal(type) {
    const p = makePedal(type);
    const at = insertAt(type);
    if (at >= 0) {
      if (type === 'amp' && !board.io.cab) toast('Turn CAB SIM on for headphones. Leave it off if you play into a real amp.');
      board.pedals.splice(at, 0, p);
      renderBoard();
      A.rewire();
      arrange(true);
      focusPedal(p.id);
      return;
    }
    const last = board.pedals[board.pedals.length - 1];
    p.x = snap(last ? last.x + PEDALS[last.type].w + GAP : 130);
    p.y = last ? last.y : snap(Math.max(30, wrapEl.clientHeight / 2 - 150));
    board.pedals.push(p);
    chainChanged();
    focusPedal(p.id);
  }
  function removePedal(p) {
    const idx = board.pedals.indexOf(p);
    if (idx < 0) return;
    board.pedals.splice(idx, 1);
    chainChanged();
    toast(`${PEDALS[p.type].title} removed`, 'UNDO', () => {
      board.pedals.splice(Math.min(idx, board.pedals.length), 0, p);
      chainChanged();
    });
  }

  // ------------------------------------------------------------------ presets

  const presetSel = $('#presetSelect');
  const userPresets = () => {
    const v = store.get(PRESET_KEY);
    return Array.isArray(v) ? v.filter((u) => u && typeof u.name === 'string' && Array.isArray(u.pedals)) : [];
  };
  function renderPresets(value = '') {
    const mine = userPresets();
    presetSel.innerHTML = '<option value="">PRESETS…</option>' +
      `<optgroup label="FACTORY">${FACTORY.map((f, i) => `<option value="f${i}">${esc(f.name)}</option>`).join('')}</optgroup>` +
      (mine.length ? `<optgroup label="MY PRESETS">${mine.map((u, i) => `<option value="u${i}">${esc(u.name)}</option>`).join('')}</optgroup>` : '');
    presetSel.value = value;
  }
  presetSel.addEventListener('change', () => {
    const v = presetSel.value;
    if (!v) return;
    const i = Number(v.slice(1));
    if (v[0] === 'f') {
      board.pedals = fromSpec(FACTORY[i].pedals);
      arrange(false);
      if (FACTORY[i].cab === false && board.io.cab) {
        board.io.cab = false;
        cabBtn.classList.remove('on');
        A.applyIO();
        save();
        toast('CAB SIM is off: this preset is for playing into a real amp. Turn it back on for headphones.');
      }
    } else {
      const u = userPresets()[i];
      if (!u) return;
      board.pedals = u.pedals.filter((p) => p && isPedal(p.type)).map((p) => makePedal(p.type, { ...p, id: uid() }));
    }
    chainChanged();
  });
  $('#presetSave').addEventListener('click', () => {
    const current = presetSel.value[0] === 'u' ? userPresets()[Number(presetSel.value.slice(1))] : null;
    const name = (prompt('Preset name:', current ? current.name : '') || '').trim().slice(0, 60);
    if (!name) return;
    const mine = userPresets();
    const entry = { name, pedals: board.pedals.map(({ type, x, y, on, params }) => ({ type, x, y, on, params })) };
    let i = mine.findIndex((u) => u.name.toLowerCase() === name.toLowerCase());
    if (i >= 0) mine[i] = entry; else i = mine.push(entry) - 1;
    store.set(PRESET_KEY, mine);
    renderPresets(`u${i}`);
    toast(`Saved preset "${name}"`);
  });
  $('#presetDelete').addEventListener('click', () => {
    const v = presetSel.value;
    if (v[0] !== 'u') { toast('Select one of your presets to delete. Factory presets stay.'); return; }
    const mine = userPresets();
    const i = Number(v.slice(1));
    if (!mine[i] || !confirm(`Delete preset "${mine[i].name}"?`)) return;
    mine.splice(i, 1);
    store.set(PRESET_KEY, mine);
    renderPresets();
  });

  // ------------------------------------------------------------------ top-bar controls

  const powerBtn = $('#power');
  function setLive(on) {
    powerBtn.classList.toggle('on', on);
    $('#powerLabel').textContent = on ? 'ONLINE' : 'START';
    document.body.classList.toggle('live', on);
  }
  powerBtn.addEventListener('click', async () => {
    if (A.running) { A.stop(); setLive(false); return; }
    powerBtn.classList.add('busy');
    try {
      await A.start();
      setLive(true);
      if (!store.get('neonrig.seenHelp')) { store.set('neonrig.seenHelp', 1); $('#help').hidden = false; }
      else if (!store.get('neonrig.learned')) toast('Tip: with the strings quiet, press LEARN NOISE to set the hum filter and noise gate.', 'LEARN', () => learnBtn.click());
    } catch (err) {
      A.stop();
      setLive(false);
      toast(audioErrorHelp(err), null, null, true);
    } finally {
      powerBtn.classList.remove('busy');
    }
  });

  inSel.addEventListener('change', async () => {
    board.io.inputId = inSel.value;
    save();
    if (!A.running) return;
    try {
      await A.openInput();
      await A.routeOutput(true);
    } catch (err) { toast(audioErrorHelp(err), null, null, true); }
    refreshDevices();
  });
  outSel.addEventListener('change', async () => {
    board.io.outputId = outSel.value;
    save();
    await A.routeOutput(true);
    refreshDevices();
  });
  if (!sinkSupported) {
    outSel.disabled = true;
    outSel.innerHTML = '<option>SYSTEM DEFAULT</option>';
    $('#outputWrap').title = 'This browser can\'t choose an output. Use Chrome or Edge, or pick the output in your computer\'s sound settings.';
  }
  chSel.addEventListener('change', () => {
    board.io.channel = chSel.value;
    save();
    A.applyChannel();
    if (A.ctx && A.inChannels < 2 && chSel.value !== '1' && chSel.value !== 'auto') toast('This input only has one channel, so IN 1 is used.');
  });

  function bindSlider(id, key, fmt, obj = board.io, defaults = DEFAULT_IO) {
    const input = $(`#${id}`), out = $(`#${id}Val`);
    const show = () => { out.textContent = fmt(obj[key]); };
    input.value = obj[key];
    show();
    input.addEventListener('input', () => {
      obj[key] = Number(input.value);
      show();
      A.applyIO();
      save();
    });
    input.addEventListener('dblclick', () => {
      obj[key] = defaults[key];
      input.value = obj[key];
      show();
      A.applyIO();
      save();
    });
  }
  bindSlider('inGain', 'inGain', (v) => `${v > 0 ? '+' : ''}${v} dB`);
  bindSlider('master', 'master', (v) => (v <= -40 ? 'MUTE' : `${v > 0 ? '+' : ''}${v} dB`));
  const cabBtn = $('#cab');
  cabBtn.classList.toggle('on', board.io.cab);
  cabBtn.addEventListener('click', () => {
    board.io.cab = !board.io.cab;
    cabBtn.classList.toggle('on', board.io.cab);
    A.applyIO();
    save();
  });
  chSel.value = board.io.channel;

  // Noise: hum filter, gate, LEARN, buffer size
  const humSel = $('#hum'), gateLed = $('#gateLed'), learnBtn = $('#learn'), bufSel = $('#latencyMode');
  const gateFmt = (v) => (v <= -90 ? 'OFF' : `${v} dB`);
  humSel.value = String(board.io.hum);
  humSel.addEventListener('change', () => { board.io.hum = Number(humSel.value); A.applyIO(); save(); });
  bindSlider('gate', 'gate', gateFmt);
  const showGateOff = () => gateLed.classList.toggle('off', board.io.gate <= -90);
  $('#gate').addEventListener('input', showGateOff);
  showGateOff();
  learnBtn.addEventListener('click', () => {
    if (!A.running) { toast('Press START first, with your guitar plugged in.'); return; }
    learnBtn.classList.add('busy');
    learnBtn.textContent = 'LISTENING…';
    toast('Listening for 2 seconds: keep the strings quiet (hand lightly on them), guitar volume up.');
    A.cond.port.postMessage({ type: 'learn' });
  });
  function onConditioner(m) {
    if (!m) return;
    if (m.type === 'gate') { gateLed.classList.toggle('open', m.open); return; }
    if (m.type !== 'learned') return;
    learnBtn.classList.remove('busy');
    learnBtn.textContent = 'LEARN NOISE';
    if (m.tooLoud) { toast('That was too loud to be noise. Mute the strings and press LEARN NOISE again.', null, null, true); return; }
    if (m.noSignal) { toast('No signal at all on this input. Check the guitar cable, the INPUT device and the CH setting, then try again.', null, null, true); return; }
    board.io.hum = m.hum;
    board.io.gate = m.gateDb;
    humSel.value = String(m.hum);
    $('#gate').value = m.gateDb;
    $('#gateVal').textContent = gateFmt(m.gateDb);
    showGateOff();
    store.set('neonrig.learned', 1);
    save();
    const hum = m.hum ? `${m.hum} Hz hum filter on (${m.humCutDb.toFixed(0)} dB of hum removed)` : 'no mains hum found, hum filter off';
    toast(`Noise floor ${m.floorDb.toFixed(0)} dBFS: ${hum}. Gate set to ${m.gateDb} dB.`);
  }
  bufSel.value = board.io.latency;
  bufSel.addEventListener('change', async () => {
    board.io.latency = bufSel.value;
    save();
    if (!A.ctx) return;
    try { await A.rebuild(); } catch (err) { setLive(false); toast(audioErrorHelp(err), null, null, true); }
  });

  // Add-pedal menu
  const addMenu = $('#addMenu');
  addMenu.innerHTML = Object.entries(PEDALS).map(([type, d]) =>
    `<button data-type="${type}" style="--accent:${d.accent}"><b>${d.title}</b><small>${d.sub}</small></button>`).join('');
  $('#addBtn').addEventListener('click', (e) => { e.stopPropagation(); addMenu.hidden = !addMenu.hidden; });
  addMenu.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    addMenu.hidden = true;
    addPedal(b.dataset.type);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.addwrap')) addMenu.hidden = true; });
  $('#arrangeBtn').addEventListener('click', () => arrange(true));

  // Help overlay
  const help = $('#help');
  $('#helpBtn').addEventListener('click', () => { help.hidden = false; });
  $('#helpClose').addEventListener('click', () => { help.hidden = true; });
  help.addEventListener('click', (e) => { if (e.target === help) help.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { help.hidden = true; addMenu.hidden = true; } });

  // Toasts
  const toastEl = $('#toast');
  let toastTimer = 0;
  function toast(msg, actionLabel, action, isError) {
    toastEl.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = msg;
    toastEl.appendChild(span);
    if (actionLabel) {
      const b = document.createElement('button');
      b.textContent = actionLabel;
      b.addEventListener('click', () => { toastEl.hidden = true; action(); });
      toastEl.appendChild(b);
    }
    toastEl.classList.toggle('error', !!isError);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, isError ? 15000 : actionLabel ? 7000 : 3500);
  }

  // Hover tips: anything with a title gets a styled tip after a steady hover. It sits beside the
  // control rather than under the pointer, and ignores the mouse, so it never gets in the way.
  const TIP_DELAY = 1500;
  const tipEl = document.createElement('div');
  tipEl.className = 'tip';
  tipEl.hidden = true;
  document.body.appendChild(tipEl);
  let tipTarget = null, tipTimer = 0;
  function hideTip() { clearTimeout(tipTimer); tipEl.hidden = true; tipTarget = null; }
  function showTip(t) {
    if (!t.isConnected) return;
    tipEl.textContent = t.dataset.tip;
    tipEl.hidden = false;
    const r = t.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    const top = r.top - h - 8 >= 4 ? r.top - h - 8 : r.bottom + 8;
    tipEl.style.left = `${clamp(r.left + r.width / 2 - w / 2, 6, innerWidth - w - 6)}px`;
    tipEl.style.top = `${top}px`;
  }
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch' || e.buttons) return; // not on touch, not mid-drag
    const t = e.target.closest('[title], [data-tip]');
    if (t === tipTarget) return;
    hideTip();
    if (!t) return;
    if (t.title) { t.dataset.tip = t.title; t.removeAttribute('title'); } // no native tooltip on top
    tipTarget = t;
    tipTimer = setTimeout(() => showTip(t), TIP_DELAY);
  });
  document.documentElement.addEventListener('pointerleave', hideTip);
  for (const ev of ['pointerdown', 'wheel', 'keydown', 'scroll']) document.addEventListener(ev, hideTip, { capture: true, passive: true });

  // ------------------------------------------------------------------ metronome + looper
  //
  // One transport drives both. Every click and loop slice sits on a beat grid on the audio
  // clock and is scheduled a little ahead, so nothing drifts with the page's timers. Beat 0 is
  // the first beat of the progression; the count-in is the bar before it. A take is recorded as
  // one slice per chord, so chords can be reordered or duplicated afterwards and their audio
  // moves with them. Slices start LEAD early, so a strum that anticipates the change stays with
  // its chord, and overlap by XF with a linear crossfade: seamless when played in recorded order.

  const LOOK = 0.15, LEAD = 0.03, XF = 0.008;
  const lp = board.loop;
  let take = new Map(), prevTake = null; // chord id -> AudioBuffer (memory only)
  let S = null, session = 0, shownEv = null, finishing = null;
  const MAX_REC_S = 180; // ~70 MB of audio at 48 kHz stereo
  const progEl = $('#prog'), beatsEl = $('#beats'), countEl = $('#countIn'), chordMenu = $('#chordMenu');
  const bpmIn = $('#bpm'), meterSel = $('#meter'), metroBtn = $('#metroBtn');
  const recBtn = $('#recBtn'), playBtn = $('#playBtn'), clearBtn = $('#clearBtn'), syncIn = $('#sync');
  const repeatSel = $('#repeat'), passInfo = $('#passInfo'), tapBtn = $('#tapBtn'), wavBtn = $('#wavBtn');
  const chordName = (c) => c.root + c.q;
  const hasTake = () => lp.chords.some((c) => take.has(c.id));
  const progAt = (start) => {
    let b = start;
    const slots = lp.chords.map((c) => { const s = { id: c.id, beat: b, len: c.len }; b += c.len; return s; });
    return { end: b, slots };
  };

  async function ensureAudio() {
    if (!A.ctx) await A.init();
    await A.ctx.resume();
  }

  function startTransport(mode) { // 'metro' | 'play' | 'rec'
    stopTransport();
    const ctx = A.ctx, spb = 60 / lp.bpm, looping = mode !== 'metro';
    const bus = (dest, gain = 1) => { const g = new GainNode(ctx, { gain }); g.connect(dest); return g; };
    const s = S = {
      mode, spb, meter: lp.meter, id: ++session, events: [], pending: [], got: 0, endAt: 0,
      pass: mode === 'play' ? 1 : 0, // pass 0 is the recording
      t0: ctx.currentTime + 0.1 + (looping ? lp.meter * spb : 0), next: looping ? -lp.meter : 0,
      cyc: looping ? progAt(0) : null,
      click: bus(A.clickOut), count: bus(A.master, dbToGain(-12)), loop: bus(A.loopOut),
    };
    if (mode === 'rec') {
      // Capture what the player hears the click against: shifted by the round trip out and back in.
      // The buffers are made here and handed over, so the audio thread never allocates them.
      const sr = ctx.sampleRate, lat = A.latencyMs() / 1000 + lp.sync / 1000;
      s.recIds = new Set(s.cyc.slots.map((sl) => sl.id));
      prevTake = take;
      take = new Map();
      const segs = s.cyc.slots.map((sl) => {
        const len = Math.round((sl.len * spb + XF) * sr);
        return { key: sl.id, start: Math.round((s.t0 + sl.beat * spb - LEAD + lat) * sr), len, ch: [new Float32Array(len), new Float32Array(len)] };
      });
      A.rec.port.postMessage({ type: 'arm', session: s.id, segs }, segs.flatMap((g) => g.ch.map((c) => c.buffer)));
    }
    s.timer = setInterval(schedule, 25);
    schedule();
    renderProg();
  }

  function stopTransport() {
    const s = S;
    if (!s) return;
    S = null;
    clearInterval(s.timer);
    if (s.recIds && s.got < s.recIds.size) {
      if (s.mode === 'play') {
        finishing = s; // stopped just after the pass: the last slices are still on their way, keep them
      } else {
        A.rec.port.postMessage({ type: 'cancel' });
        take = prevTake;
        toast('Recording stopped before the end of the progression. The previous loop is kept.');
      }
    }
    const t = A.ctx.currentTime;
    for (const g of [s.click, s.count, s.loop]) { g.gain.setTargetAtTime(0, t, 0.01); setTimeout(() => g.disconnect(), 150); }
    shownEv = null;
    showBeat(null);
    renderProg();
  }

  function schedule() {
    const s = S;
    if (!s) return;
    if (s.endAt) { if (A.ctx.currentTime >= s.endAt) stopTransport(); return; } // REPEAT reached: let the last pass finish
    const horizon = A.ctx.currentTime + (document.hidden ? 1.5 : LOOK); // hidden tabs run timers late
    while (s.t0 + s.next * s.spb < horizon) {
      const b = s.next++, t = s.t0 + b * s.spb;
      const ev = { t, inBar: ((b % s.meter) + s.meter) % s.meter, count: b < 0 ? -b : 0, id: null, beat: 0, len: 0 };
      if (s.cyc && b >= s.cyc.end) { // round again, picking up any edits made meanwhile
        if (s.mode === 'rec') { s.mode = 'play'; renderTransport(); }
        if (lp.repeat && s.pass >= lp.repeat) { s.endAt = t + XF + 0.05; return; }
        s.pass++;
        s.cyc = progAt(b);
        if (!s.cyc.slots.length) { stopTransport(); return; }
      }
      if (s.cyc && b >= 0) {
        const sl = s.cyc.slots.find((x) => b < x.beat + x.len);
        Object.assign(ev, { id: sl.id, beat: b - sl.beat, len: sl.len });
        if (b === sl.beat && s.mode === 'play') playSlot(s, sl, t - LEAD);
      }
      ev.rec = s.mode === 'rec';
      ev.pass = s.pass;
      click(s, t, ev.inBar === 0, b < 0);
      s.events.push(ev);
    }
  }

  function click(s, t, accent, counting) {
    const ctx = A.ctx;
    const o = new OscillatorNode(ctx, { type: 'triangle', frequency: accent ? 1760 : 1320 });
    const g = new GainNode(ctx, { gain: 0 });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(accent ? 0.8 : 0.5, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    o.connect(g);
    g.connect(counting && lp.clickVol <= -40 ? s.count : s.click); // the count-in always sounds
    o.start(t);
    o.stop(t + 0.07);
  }

  function playSlot(s, sl, when) {
    const buf = take.get(sl.id);
    if (!buf) {
      if (s.recIds && s.recIds.has(sl.id)) s.pending.push({ sl, when }); // still on its way from the recorder
      return;
    }
    // A chord lengthened after recording plays what it has, then fades rather than cutting off.
    const ctx = A.ctx, dur = Math.min(sl.len * s.spb, buf.duration - XF);
    const start = Math.max(when, ctx.currentTime + 0.005), off = start - when;
    if (off > dur - XF) return;
    const src = new AudioBufferSourceNode(ctx, { buffer: buf });
    const g = new GainNode(ctx, { gain: 0 });
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(1, start + XF);
    g.gain.setValueAtTime(1, when + dur);
    g.gain.linearRampToValueAtTime(0, when + dur + XF);
    src.connect(g);
    g.connect(s.loop);
    src.start(start, off);
    src.stop(when + dur + XF);
  }

  function onTake(m) {
    if (!m || m.type !== 'take') return;
    const s = S && m.session === S.id ? S : finishing && m.session === finishing.id ? finishing : null;
    if (!s) return;
    const buf = new AudioBuffer({ numberOfChannels: 2, length: m.ch[0].length, sampleRate: A.ctx.sampleRate });
    buf.copyToChannel(m.ch[0], 0);
    buf.copyToChannel(m.ch[1], 1);
    take.set(m.key, buf);
    s.got++;
    if (s === S) s.pending = s.pending.filter((p) => (p.sl.id === m.key ? (playSlot(s, p.sl, p.when), false) : true));
    const el = progEl.querySelector(`[data-id="${m.key}"]`);
    if (el) el.classList.add('has');
    if (s.got === s.recIds.size) {
      if (s === finishing) finishing = null;
      renderTransport();
    }
  }

  // What is coming out of the speakers now, on the audio clock, so the lights match the sound.
  function heardTime() {
    const ctx = A.ctx;
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts && ts.contextTime > 0) return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    return ctx.currentTime - (ctx.baseLatency || 0) - (ctx.outputLatency || 0);
  }
  function paintTransport() {
    const s = S;
    if (!s) return;
    const now = heardTime();
    while (s.events.length && s.events[0].t <= now) { shownEv = s.events.shift(); showBeat(shownEv); }
    const ev = shownEv;
    const el = ev && ev.id && progEl.querySelector(`[data-id="${ev.id}"]`);
    if (el) el.style.setProperty('--p', ((ev.beat + clamp((now - ev.t) / s.spb, 0, 1)) / ev.len).toFixed(4));
  }
  function showBeat(ev) {
    [...beatsEl.children].forEach((d, i) => d.classList.toggle('on', !!ev && i === ev.inBar));
    passInfo.hidden = !(ev && S && S.cyc);
    if (!passInfo.hidden) passInfo.textContent = ev.rec ? 'REC' : `${ev.pass}/${lp.repeat || '∞'}`;
    countEl.hidden = !(ev && ev.count);
    if (ev && ev.count) {
      countEl.textContent = ev.count;
      countEl.classList.toggle('rec', ev.rec);
      countEl.classList.remove('beat');
      void countEl.offsetWidth;
      countEl.classList.add('beat');
    }
    for (const el of progEl.querySelectorAll('.chord.now')) {
      if (ev && el.dataset.id === ev.id) continue;
      el.classList.remove('now', 'rec');
      el.style.removeProperty('--p');
      el.querySelectorAll('.ticks i').forEach((t) => t.classList.remove('on'));
    }
    const el = ev && ev.id && progEl.querySelector(`[data-id="${ev.id}"]`);
    if (!el) return;
    el.classList.add('now');
    el.classList.toggle('rec', ev.rec);
    el.querySelectorAll('.ticks i').forEach((t, i) => t.classList.toggle('on', i <= ev.beat));
  }

  function renderBeats() { beatsEl.innerHTML = '<i></i>'.repeat(lp.meter); }
  function renderTransport() {
    const mode = S ? S.mode : '', recording = mode === 'rec';
    metroBtn.classList.toggle('on', mode === 'metro');
    recBtn.classList.toggle('on', recording);
    playBtn.textContent = S && mode !== 'metro' ? '■ STOP' : '▶ PLAY';
    clearBtn.disabled = wavBtn.disabled = recording || !hasTake();
    bpmIn.disabled = tapBtn.disabled = recording || hasTake();
    meterSel.disabled = recording;
    progEl.classList.toggle('locked', recording);
    $('#loopbar').classList.toggle('recording', recording);
    if (recording) chordMenu.hidden = true;
  }
  function renderProg() {
    const recorded = hasTake();
    progEl.innerHTML = lp.chords.length ? '' : '<span class="prog-empty">+ CHORD to build a progression</span>';
    for (const c of lp.chords) {
      const el = document.createElement('div');
      el.className = `chord${take.has(c.id) ? ' has' : recorded ? ' empty' : ''}`;
      el.dataset.id = c.id;
      el.style.flexGrow = c.len;
      el.title = take.has(c.id) || !recorded
        ? 'Drag to reorder. Click to change, duplicate or delete.'
        : 'Nothing recorded on this chord: it plays silent. REC again to record it.';
      el.innerHTML = `<b>${esc(chordName(c))}</b><span class="ticks">${'<i></i>'.repeat(c.len)}</span>`;
      bindChipDrag(el, lp.chords, c, () => openChordMenu(c), progChanged);
      progEl.appendChild(el);
    }
    if (shownEv && S) showBeat(shownEv);
    renderTransport();
  }
  function progChanged() { renderProg(); save(); }

  // Chord editor: drops down under the chip.
  let menuFor = null;
  function openChordMenu(c) {
    const el = progEl.querySelector(`[data-id="${c.id}"]`);
    if (!el) return;
    menuFor = c;
    const row = (label, items) => `<div class="cm-row"><span>${label}</span><div>${items}</div></div>`;
    const opt = (attr, v, text, on) => `<button data-${attr}="${v}" class="${on ? 'on' : ''}">${text}</button>`;
    chordMenu.innerHTML =
      row('ROOT', ROOTS.map((r) => opt('root', r, r, r === c.root)).join('')) +
      QUAL_ROWS.map(([label, qs]) => row(label, qs.map((q) => opt('q', q, q || 'maj', q === c.q)).join(''))).join('') +
      row('BEATS', LENS.map((n) => opt('len', n, n, n === c.len)).join('')) +
      '<div class="cm-actions"><button data-act="dup">DUPLICATE</button><button data-act="del">DELETE</button></div>';
    chordMenu.hidden = false;
    const r = el.getBoundingClientRect();
    chordMenu.style.left = `${clamp(r.left, 6, innerWidth - chordMenu.offsetWidth - 6)}px`;
    // Below the chip, but kept inside a short window (it may then overlap the lane).
    chordMenu.style.top = `${Math.max(6, Math.min(r.bottom + 6, innerHeight - chordMenu.offsetHeight - 6))}px`;
  }
  chordMenu.addEventListener('click', (e) => {
    const b = e.target.closest('button'), c = menuFor, d = b ? b.dataset : null;
    if (!d || !c || !lp.chords.includes(c)) return;
    if (d.act === 'dup') {
      chordMenu.hidden = true;
      if (lp.chords.length >= MAX_CHORDS) { toast(`A loop holds up to ${MAX_CHORDS} chords.`); return; }
      const copy = { ...c, id: uid() };
      if (take.has(c.id)) take.set(copy.id, take.get(c.id));
      lp.chords.splice(lp.chords.indexOf(c) + 1, 0, copy);
      progChanged();
      return;
    }
    if (d.act === 'del') {
      chordMenu.hidden = true;
      const i = lp.chords.indexOf(c);
      lp.chords.splice(i, 1);
      progChanged();
      toast(`${chordName(c)} removed`, 'UNDO', () => { lp.chords.splice(Math.min(i, lp.chords.length), 0, c); progChanged(); });
      return;
    }
    if (d.root) c.root = d.root;
    else if (d.len) c.len = Number(d.len);
    else if ('q' in d) c.q = d.q;
    progChanged();
    openChordMenu(c);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.chord, .chord-menu, #addChord')) chordMenu.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') chordMenu.hidden = true; });
  $('#addChord').addEventListener('click', () => {
    if (S && S.mode === 'rec') return;
    if (lp.chords.length >= MAX_CHORDS) { toast(`A loop holds up to ${MAX_CHORDS} chords.`); return; }
    const last = lp.chords[lp.chords.length - 1];
    const c = last ? { ...last, id: uid() } : chord('C');
    lp.chords.push(c);
    progChanged();
    openChordMenu(c);
  });

  // Tempo and time signature: a running transport keeps its place on the grid.
  function setTempo(bpm) {
    lp.bpm = clamp(Math.round(bpm) || lp.bpm, 40, 240);
    bpmIn.value = lp.bpm;
    if (S) {
      const next = S.t0 + S.next * S.spb;
      S.spb = 60 / lp.bpm;
      S.t0 = next - S.next * S.spb;
    }
    save();
  }
  bpmIn.value = lp.bpm;
  bpmIn.addEventListener('change', () => setTempo(Number(bpmIn.value)));
  bpmIn.addEventListener('wheel', (e) => {
    if (bpmIn.disabled) return;
    e.preventDefault();
    setTempo(lp.bpm + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 5 : 1));
  }, { passive: false });
  // Tap tempo: the average of the last few taps; a 2 s pause starts over.
  let taps = [];
  tapBtn.addEventListener('click', () => {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    if (taps.length > 5) taps.shift();
    if (taps.length >= 2) setTempo(60000 * (taps.length - 1) / (taps[taps.length - 1] - taps[0]));
  });
  meterSel.value = String(lp.meter);
  meterSel.addEventListener('change', () => {
    lp.meter = Number(meterSel.value);
    if (S) S.meter = lp.meter;
    renderBeats();
    save();
  });
  const volFmt = (v) => (v <= -40 ? 'OFF' : `${v > 0 ? '+' : ''}${v} dB`);
  bindSlider('clickVol', 'clickVol', volFmt, lp, DEFAULT_LOOP);
  bindSlider('loopVol', 'loopVol', volFmt, lp, DEFAULT_LOOP);
  repeatSel.value = String(lp.repeat);
  repeatSel.addEventListener('change', () => {
    lp.repeat = Number(repeatSel.value);
    if (shownEv && S) showBeat(shownEv);
    save();
  });
  syncIn.value = lp.sync;
  syncIn.addEventListener('change', () => {
    lp.sync = clamp(Math.round(Number(syncIn.value)) || 0, -100, 200);
    syncIn.value = lp.sync;
    save();
  });

  // Transport buttons
  async function withAudio(fn) {
    try { await ensureAudio(); fn(); } catch (err) { toast(audioErrorHelp(err), null, null, true); }
  }
  metroBtn.addEventListener('click', () => {
    if (S && S.mode === 'metro') { stopTransport(); return; }
    if (S) { toast('The click already runs with the loop. CLICK sets its volume.'); return; }
    withAudio(() => startTransport('metro'));
  });
  recBtn.addEventListener('click', () => {
    if (S && S.mode === 'rec') { stopTransport(); return; }
    if (!A.running) { toast('Press START first, with your guitar plugged in.'); return; }
    if (!A.stream) { toast('No guitar input: plug the interface or cable back in first.', null, null, true); return; }
    if (!lp.chords.length) { toast('Add chords first: + CHORD.'); return; }
    const secs = progAt(0).end * 60 / lp.bpm;
    if (secs > MAX_REC_S) { toast(`That progression lasts ${Math.round(secs)} s; a recording can be up to ${MAX_REC_S / 60} minutes. Remove chords or raise the BPM.`); return; }
    startTransport('rec');
  });
  playBtn.addEventListener('click', () => {
    if (S && S.mode !== 'metro') { stopTransport(); return; }
    if (!lp.chords.length) { toast('Add chords first: + CHORD.'); return; }
    withAudio(() => startTransport('play'));
  });
  // WAV export: one pass in the current chord order, mixed exactly as it plays back (same LEAD and
  // crossfades) and wrapped round, so the file starts on beat 1 and loops seamlessly elsewhere.
  function loopPass() {
    const sr = lp.chords.map((c) => take.get(c.id)).find(Boolean).sampleRate;
    const spb = 60 / lp.bpm, xf = Math.round(XF * sr), lead = Math.round(LEAD * sr);
    const { end, slots } = progAt(0);
    const n = Math.round(end * spb * sr);
    const out = [new Float32Array(n), new Float32Array(n)];
    for (const sl of slots) {
      const buf = take.get(sl.id);
      if (!buf || buf.sampleRate !== sr) continue; // a chord added after recording is silent
      const dur = Math.min(Math.round(sl.len * spb * sr), buf.length - xf);
      const at = Math.round(sl.beat * spb * sr) - lead;
      for (let c = 0; c < 2; c++) {
        const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1)), dst = out[c];
        for (let i = 0; i < dur + xf; i++) {
          const g = i < xf ? i / xf : i < dur ? 1 : 1 - (i - dur) / xf;
          dst[(at + i + n) % n] += src[i] * g;
        }
      }
    }
    return { out, sr };
  }
  function wav24(chs, sr) { // 24-bit PCM, interleaved
    const n = chs[0].length, nc = chs.length, ba = nc * 3;
    const bytes = new Uint8Array(44 + n * ba), v = new DataView(bytes.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * ba, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * ba, true); v.setUint16(32, ba, true); v.setUint16(34, 24, true);
    str(36, 'data'); v.setUint32(40, n * ba, true);
    for (let i = 0, o = 44; i < n; i++) {
      for (let c = 0; c < nc; c++, o += 3) {
        const s = Math.round(clamp(chs[c][i], -1, 1) * 8388607);
        bytes[o] = s & 255; bytes[o + 1] = (s >> 8) & 255; bytes[o + 2] = (s >> 16) & 255;
      }
    }
    return new Blob([bytes], { type: 'audio/wav' });
  }
  wavBtn.addEventListener('click', () => {
    if (!hasTake()) return;
    const { out, sr } = loopPass();
    const chords = lp.chords.map(chordName).join('-').replace(/#/g, 's').replace(/[^A-Za-z0-9-]/g, '');
    const name = `neonrig-${lp.bpm}bpm-${chords}`.slice(0, 80);
    const url = URL.createObjectURL(wav24(out, sr));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.wav`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`Downloading ${name}.wav: one pass, ${(out[0].length / sr).toFixed(1)} s.`);
  });

  // Space bar = PLAY / STOP, so a hand never has to leave the guitar for long. Space is kept from
  // also pressing whichever button has focus.
  const typing = (e) => e.target.closest && e.target.closest('input, select, textarea');
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (!e.repeat && $('#help').hidden) playBtn.click();
  });
  document.addEventListener('keyup', (e) => { if (e.code === 'Space' && !typing(e)) e.preventDefault(); });
  clearBtn.addEventListener('click', () => {
    const old = take, cleared = take = new Map();
    renderProg();
    toast('Recording cleared. The chords stay.', 'UNDO', () => {
      if (take !== cleared || (S && S.mode === 'rec')) return; // a new take since: keep it
      take = old;
      renderProg();
    });
  });

  // ------------------------------------------------------------------ meters

  const scratch = new Float32Array(1024);
  const meters = { ch1: $('#mCh1'), ch2: $('#mCh2'), input: $('#mIn'), output: $('#mOut') };
  const shown = { ch1: 0, ch2: 0, input: 0, output: 0 };
  const clipUntil = { input: 0, output: 0 };
  const loud = [0, 0];
  let lastLatency = 0, clipWarnAt = 0;

  function peakOf(an) {
    an.getFloatTimeDomainData(scratch);
    let m = 0;
    for (let i = 0; i < scratch.length; i++) { const a = Math.abs(scratch[i]); if (a > m) m = a; }
    return m;
  }
  function paintMeter(key, pk, now) {
    shown[key] = Math.max(pk, shown[key] * 0.88);
    const db = 20 * Math.log10(shown[key] + 1e-9);
    meters[key].style.setProperty('--lvl', clamp((db + 60) / 60, 0, 1).toFixed(3));
    if (key in clipUntil) {
      if (pk >= 0.98) clipUntil[key] = now + 1200;
      meters[key].classList.toggle('clip', now < clipUntil[key]);
    }
  }
  function tick(now) {
    paintTransport();
    if (A.running) {
      const c1 = peakOf(A.chMeter[0]), c2 = peakOf(A.chMeter[1]);
      paintMeter('ch1', c1, now);
      paintMeter('ch2', c2, now);
      paintMeter('input', peakOf(A.inMeter), now);
      paintMeter('output', peakOf(A.outMeter), now);
      // Clipping at the interface can't be fixed in software: it already sounds like static.
      const ch = A.channel();
      const raw = ch === '1' ? c1 : ch === '2' ? c2 : Math.max(c1, c2);
      if (raw >= 0.98 && now > clipWarnAt) {
        clipWarnAt = now + 20000;
        toast('Input is clipping: turn down the gain on your interface (until its input light stays green), or the guitar\'s volume on a USB guitar cable. Hot pedals in front of it make this worse.', null, null, true);
      }
      // AUTO channel: follow whichever input is clearly carrying the guitar.
      loud[0] = c1 > 0.006 && c1 > c2 * 5 ? loud[0] + 1 : 0;
      loud[1] = c2 > 0.006 && c2 > c1 * 5 ? loud[1] + 1 : 0;
      if (board.io.channel === 'auto' && A.inChannels > 1) {
        const want = loud[0] > 15 ? '1' : loud[1] > 15 ? '2' : A.autoCh;
        if (want !== A.autoCh) { A.autoCh = want; A.applyChannel(); }
      }
      if (now - lastLatency > 1000) {
        lastLatency = now;
        $('#latency').textContent = `≈ ${Math.round(A.latencyMs())} ms`;
      }
    }
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ boot

  if (navigator.mediaDevices) {
    let devTimer = 0; // devicechange fires in bursts while a device is enumerated
    navigator.mediaDevices.addEventListener('devicechange', () => {
      clearTimeout(devTimer);
      devTimer = setTimeout(async () => { await A.followDevices(); refreshDevices(); }, 400);
    });
    refreshDevices(); // names show up front if access was granted on an earlier visit
  }
  renderPresets();
  renderBoard();
  renderBeats();
  renderProg();
  if (needsArrange) arrange(false);
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { fitBoard(); drawCables(); });
  });
  requestAnimationFrame(tick);

  // Debug handle for the console (and automated checks).
  window.NEON_RIG = { board, engine: A, PEDALS, looper: { get S() { return S; }, get take() { return take; } } };
})();
