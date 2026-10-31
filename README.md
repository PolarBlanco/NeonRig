# NEON RIG

A virtual pedalboard for guitar that runs in your web browser. Plug your guitar into your computer and play
through ten pedals and an amp, with a metronome and a looper built in. There's nothing to install, no account,
and it works offline: everything happens on your own computer, and nothing you play is sent anywhere.

## Get it running

**What you need**
- A guitar, and one way to get it into the computer:
  - an **audio interface** (a small box with a guitar input and a headphone jack), or
  - a **USB guitar cable** (a guitar cable with a USB plug on the other end).
- Headphones or speakers. With an interface, plug them into the interface; with a USB cable, into the computer.
  Wired is best: Bluetooth adds a noticeable delay.
- A Windows or Mac computer with **Google Chrome** or **Microsoft Edge**.

**Steps**
1. **Download it.** At the top of this GitHub page, click the green **Code** button, then **Download ZIP**.
2. **Unzip it.** Open your Downloads folder.
   - Windows: right-click the ZIP file, choose **Extract All**, then **Extract**.
   - Mac: double-click the ZIP file.

   You'll get a folder you can move anywhere you like (Documents, for example).
3. **Plug in** the guitar and your headphones or speakers. Start with the volume low.
4. **Open the app.** In the folder, double-click **`index.html`**. It opens in your web browser.
   If it opens in Safari or Firefox instead, right-click `index.html` and choose **Open With → Google Chrome**
   (or Microsoft Edge).
5. Press **START** in the top-left corner. Your browser asks to use your **microphone**: click **Allow**.
   Browsers call every audio input a microphone; here it means your guitar input.
6. **Play.** Choose a sound from the **PRESETS** menu in the top right. Press **?** for setup help at any time,
   and rest the mouse on any knob or button to see what it does.

**Nothing coming through?**
- Check that **INPUT** at the top shows your interface or guitar cable, not the laptop's built-in mic.
- Play a few notes and watch the two small **1 / 2** meters next to it. One of them should move.
- If START says audio input is **blocked**, your computer's privacy settings are refusing it. See
  [If audio input is blocked](#if-audio-input-is-blocked) below.
- Hearing a plain, un-effected guitar underneath the sound? Turn off **Direct Monitor** on your interface.
- Crackles or dropouts? Set **BUF** (top bar) to **SAFE**.

**Next time**, just double-click `index.html` again. Your board, your saved presets and your looper chords are
remembered by the browser automatically. To get a newer version, download the ZIP again and replace the folder:
your saved settings stay, because they're kept by the browser, not in the folder.

### If audio input is blocked

The operating system is refusing the browser access to audio inputs:
- **Windows**: Settings → Privacy & security → Microphone → turn on **"Let desktop apps access your microphone"**,
  then restart the browser.
- **Mac**: System Settings → Privacy & Security → Microphone → switch on **Google Chrome** (or Microsoft Edge),
  then restart the browser.

If a browser still refuses audio from a file opened straight from your computer, there's a fallback for people
comfortable with a terminal: install [Node.js](https://nodejs.org), run `node serve.js` in this folder, and open
the address it prints.

## What's on the board

| Pedal | Modelled after | Controls |
| --- | --- | --- |
| **VOLT WAH** | Dunlop Cry Baby (GCB95) wah | Position, Sens, Rate. Modes: **AUTO** (your picking opens the wah), **LFO** (sweeps by itself), **FIXED** ("parked" wah at POSITION) |
| **PLASMA FUZZ** | Dallas Arbiter Fuzz Face | Fuzz, Volume. **GERMANIUM** (warm, 1967 Hendrix) / **SILICON** (brighter, 1969-70). Roll back your guitar's volume to clean it up |
| **NEON SCREAMER** | Tube Screamer (TS-808) overdrive | Drive, Tone, Level |
| **ORBIT VIBE** | Shin-ei Uni-Vibe | Speed, Intensity. **CHORUS** (throbbing phase swirl) / **VIBRATO** (pitch wobble). The lamp glows with the sweep |
| **QUASAR PHASE** | MXR Phase 90 phaser | Speed. **SCRIPT** (the early, smooth version) / **BLOCK** (with feedback: sharper, more vocal) |
| **WARP FLANGER** | Boss BF-2 flanger | Manual, Depth, Rate, Res. The "jet plane" sweep; with DEPTH down, turn MANUAL to sweep by hand |
| **CHROMA CHORUS** | Boss CE-2W chorus | Rate, Depth, mode **STD** (CE-2) / **CE-1 CHO** (stereo) / **CE-1 VIB** (vibrato) |
| **STROBE TREM** | Boss TR-2 tremolo / Fender amp tremolo | Rate, Depth. **SINE** (smooth swell) / **OPTO** (old Fender amp: quick dip, slow swell back) / **CHOP** (hard on/off) |
| **GHOST ECHO** | Maestro Echoplex tape echo | Time (60-750 ms), Repeats, Mix. Repeats get darker like tape; turning TIME while it repeats bends the pitch. Repeats ring out when switched off |
| **VOID VERB** | Boss RV-6 reverb | E.Level, Tone, Time, Mode: Room, Hall, Plate, Spring, Modulate, +Delay, Shimmer, Dynamic |
| **NEON STACK** (amp) | **PLEXI**: Marshall 1959 · **HIWATT**: DR103 · **FENDER**: Blackface | Gain, Bass, Middle, Treble, Volume, and a power switch |

**Which amp for which sound:** PLEXI for Led Zeppelin, Hendrix and Cream-era Clapton, HIWATT for The Who, and FENDER
with the NEON SCREAMER in front for Stevie Ray Vaughan. GAIN below noon is genuinely clean on FENDER and HIWATT;
the PLEXI always has a little hair, like the real one. The amp is for playing through headphones or speakers;
keep **CAB SIM** on with it. If you play into a real amp, leave NEON STACK out.

**20 factory presets** are starting points, for example **Psychedelic Hendrix** and **Machine Gun (Band of Gypsys)**
(fuzz and vibe in Hendrix's order), **Cream Woman Tone (Clapton)**, **Texas Blues (SRV)**, **Texas Glass Blues**
(clean, bright and glassy), **Spaghetti Western** (tremolo, tape echo and deep spring), **Echoplex Lead**,
**Phase Crunch** and **Jet Flanger**.

The models are approximations written for this app, not circuit-exact clones. Beyond the pedals there's a
metronome and a simple chord-locked looper (see below), but no multitrack recording.

## Using the board

- **Knobs**: drag up/down or scroll. Hold Shift for fine moves; double-click resets.
- **Not sure what something does?** Rest the mouse on it for a moment and a tip pops up beside it.
- **Footswitch** (bottom of each pedal): click to engage or bypass. Reverb and echo tails ring out when bypassed.
- **Move pedals**: drag them by the body. **Change the signal order**: drag the chips in the SIGNAL CHAIN bar.
- **ARRANGE** lines pedals up in chain order. **+ ADD PEDAL** adds more (two drives is fine), and each new pedal
  lands where it usually goes in a chain. The × on a pedal removes it, with UNDO.
- The board saves itself. **SAVE** stores your own named presets.

## Plug and go

**INPUT** and **OUTPUT** start on **AUTO**, so any guitar input works without setup:

- **INPUT AUTO** picks the most guitar-like device: a known audio interface or a USB guitar cable, ahead of a
  generic USB device. It never picks the laptop mic, a webcam or a headset while something better is plugged in.
- **OUTPUT AUTO** plays out of the same box the guitar comes in on (your interface's headphone jack). A cable with
  no output of its own plays through the computer's headphones or speakers.
- **Plug in or swap devices while it's running.** The guitar device you just plugged in takes over. If you pull it
  out, NEON RIG goes quiet and waits; it doesn't switch to the laptop mic, which would howl through a fuzz.
- Picking a device by name in either menu pins it. Pick **AUTO** again to go back.
- Use **wired** headphones or speakers. Bluetooth adds 150-300 ms of delay, and NEON RIG warns you when it's in use.
- The OUTPUT menu needs Chrome or Edge. In other browsers, sound goes to your computer's default output.

## USB guitar cable

Plug it into a USB port and press **START**. Most cables have no volume knob or headphone jack: use **GAIN** here
for level, and plug headphones into the computer. If it clips, turn the guitar's volume down a little. Quit any
game or app that came with the cable first, because it can hold the cable for itself. These cables hiss a bit
more than an interface, so press **LEARN NOISE** once.

## Audio interface setup

1. Plug the guitar into the **instrument (Hi-Z) input** and switch on its **INST / Hi-Z** setting if it has one.
2. **Turn Direct Monitor OFF.** Otherwise you hear the dry guitar on top of the pedals.
3. Set the interface's input gain so its level light stays green when you play hard, never red. Red means the
   input is clipping, which sounds like static and can't be fixed afterwards. Hot pedals in front of the
   interface push it into the red, so turn the gain down when they're on. The app warns you when it sees clipping.
4. **INPUT** and **OUTPUT** on AUTO pick the interface by themselves. **CH: AUTO** picks the input your guitar is
   on. The small 1/2 meters show which one that is.
5. **CAB SIM** voices the output like a guitar speaker, which is best for headphones. Turn it off if you feed a real amp.

## Playing through your real amp

Use NEON RIG as the effects your board doesn't have. Load the **Real Amp: Chorus + Reverb** preset, which also
switches **CAB SIM** off (a speaker voicing for headphones only). Leave NEON STACK out; your amp is the amp.

**Which hookup:**
- **Amp with an effects loop (best):** amp's **FX SEND** → interface input (INST off if the send is line
  level) → NEON RIG → interface **LINE OUT L** (or 1) → amp's **FX RETURN**. Chorus and reverb then come after
  the amp's distortion, as on a studio rig, so a dirty amp stays clear.
- **No effects loop:** guitar → your pedals → interface instrument input (INST on) → NEON RIG → interface
  **LINE OUT L** (or 1) → amp's input. This works well into a clean or edge-of-breakup amp. Into a heavily
  driven amp the reverb gets muddy, because it's distorted along with the guitar.

**Setup:**
1. Use the interface's **LINE OUT L** (or 1) jack with an ordinary mono guitar (TS) cable. Not the headphone
   jack. The left channel alone carries the whole chorus and reverb.
2. **Direct Monitor OFF** on the interface. Otherwise the dry guitar reaches the amp a few milliseconds ahead
   of the processed one, and the mix sounds phasey and thin.
3. Line out is much hotter than a guitar. Start with the interface's main **OUTPUT** knob low and **MASTER** at
   about -12 dB, then raise it until bypassing everything (footswitches off) is as loud as plugging the guitar
   straight in.
4. Keep **BUF** on **LOW**. Everything you hear now passes through the laptop, so the browser's few tens of
   milliseconds of delay apply to the whole sound.
5. A hum that appears only with the amp connected is a ground loop between the laptop and the amp. Run the
   laptop on battery, or put a ground-loop isolator / DI on the line out.

## Getting rid of noise

The **HUM / GATE / LEARN NOISE** controls in the top bar clean up the guitar before it reaches any pedal:

- **LEARN NOISE**: plug in, turn the guitar's volume up, keep the strings quiet, and press it. In 2 seconds it
  measures your rig, picks the right hum filter (50 or 60 Hz) and sets the gate just above your hiss.
- **HUM** removes mains hum and its harmonics (60 Hz in the Americas, 50 Hz in most other countries). It has to
  happen before the drives, because distortion turns hum into buzz that can't be filtered out afterwards.
- **GATE** mutes the hiss between notes (the LED lights while sound passes). Slide it left to OFF if it ever cuts
  quiet playing. Reverb and echo tails are never cut, because the gate sits before them.
- **Crackles or dropouts** come from the computer, not the guitar: set **BUF** to **SAFE** (or **MAX**).
- **Static even with nothing plugged in**, or buzz that changes when you touch the strings or the laptop, is
  usually a ground loop. Try the laptop on battery (charger unplugged). If it goes away, use a ground-loop
  isolator on the interface's output, or keep the laptop unplugged while you play.
- **Buzz that changes as you turn around** is single-coil pickups picking up monitors, dimmers and chargers.
  Face away from them.

## Metronome and looper

The bar under the top bar holds a metronome and a chord-locked looper. You never have to hit the loop point on
time: you set the tempo and the chords, the app counts you in, and the loop is exactly as long as the progression.

- **METRO** starts and stops the click. **BPM** sets the tempo (type it or scroll over it; Shift+scroll moves
  in fives), or click **TAP** in time 3-4 times. **TIME** sets the beats per bar. The dots light on each beat,
  with beat 1 in pink. **CLICK** sets its volume; far left turns it off.
- **LOOP** lane: one chip per chord, sized by its length. **+ CHORD** adds one. Click a chip to change its root,
  type and length in beats, or to **DUPLICATE** or **DELETE** it. Drag chips to reorder them. The types:
  - **Triads:** maj, m, 5 (power chord), sus2, sus4, aug, dim
  - **Sixths and sevenths:** 6, m6, 7, m7, maj7, 7sus4, dim7, m7b5 (half-diminished)
  - **Extended:** 9, m9, maj9, add9, 11, 13, 7#9 (the "Hendrix chord")
- **● REC** (after **START**) counts in one bar (4, 3, 2, 1 on screen), records you once through the
  progression while each chord lights up and fills as it plays, then stops recording and loops what you played.
  Play along on top. Press **REC** again to record a new take, or during the count-in to cancel.
- **▶ PLAY / ■ STOP** (or the **space bar**) plays the loop from the top after a count-in. With nothing
  recorded it just runs the chords and the click, which is handy for practising changes.
- **REPEAT** sets how many times the loop plays: **∞** (until you press STOP) or 1× to 16×, after which it
  stops cleanly at the end of a pass. The readout beside it shows the pass, e.g. **2/4**. After REC, the
  recording pass doesn't count. Changing REPEAT while playing applies straight away, so picking the number of
  the current pass ends the loop when that pass finishes.
- **After recording, the chords are still editable.** Each chord keeps its own slice of the recording, so
  reordering or duplicating chords moves their audio too. Edits take effect the next time round. A chord added
  after recording has no audio (it shows dashed) and plays silent. The tempo is locked while there is a
  recording; **CLEAR** it (UNDO is offered) to change tempo.
- **LOOP** sets the playback volume. The loop records what you hear from the pedals, before **MASTER**, and
  never records the click or the loop itself.
- **SYNC**: the recording is shifted by the browser's latency estimate, so it lines up with the click. If the
  loop still plays back late against the click, raise SYNC by 5-10 ms; if early, lower it.
- **WAV** downloads one pass of the loop, in the current chord order, as a 24-bit WAV file. It starts on beat 1
  and loops seamlessly in other music apps, so you can keep a take or play it on something else.
- Recordings live in memory only: reloading or closing the page loses them (use **WAV** to keep one). The chords
  and settings are saved with the board. A recording can be up to 3 minutes long.

## Latency

Browsers add some delay between string and ear. The top bar shows the browser's estimate. **BUF** picks the
audio buffer: LOW (≈10 ms) is the default; SAFE and MAX trade a little delay for no crackles. To keep it low:
use Chrome or Edge, close other audio apps, set your interface and system to 48 kHz, and use the
interface's own output, not Bluetooth. If you still find it too slow, the DSP in `dsp.js` is self-contained
and could later be moved into a native app that talks to the interface's ASIO driver directly.

## Privacy

NEON RIG makes no network connections at all: the fonts are bundled, and there are no accounts, analytics or
updates. Audio stays inside your browser. The only things it stores are your board, presets and looper settings,
in the browser's own local storage on your computer.

## Files

- `index.html`, `style.css`, `app.js`: UI, layout, presets, metronome/looper and audio routing (Web Audio API)
- `dsp.js`: the pedal models and the loop recorder (AudioWorklet processors)
- `serve.js`: optional local web server (`node serve.js`). It listens on 127.0.0.1 only, serves only this
  folder, answers only GET/HEAD requests addressed to `127.0.0.1` or `localhost`, and never runs anything it serves.
- `tests/dsp-test.js`: offline DSP checks (`node tests/dsp-test.js`, needs Node.js)
- `fonts/`: Orbitron and Share Tech Mono, bundled so the app never contacts a font server (SIL Open Font
  License 1.1; the licence texts are in the same folder)
