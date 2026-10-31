# NEON RIG

A simple virtual pedalboard for guitar. Plug into an audio interface or a USB guitar cable and play through six pedals and an amp:

| Pedal | Modelled after | Controls |
| --- | --- | --- |
| **VOLT WAH** | Dunlop Cry Baby (GCB95) wah | Position, Sens, Rate. Modes: **AUTO** (your picking opens the wah), **LFO** (sweeps by itself), **FIXED** ("parked" wah at POSITION) |
| **PLASMA FUZZ** | Dallas Arbiter Fuzz Face | Fuzz, Volume. **GERMANIUM** (warm, 1967 Hendrix) / **SILICON** (brighter, 1969-70). Roll back your guitar's volume to clean it up |
| **NEON SCREAMER** | Tube Screamer (TS-808) overdrive | Drive, Tone, Level |
| **ORBIT VIBE** | Shin-ei Uni-Vibe | Speed, Intensity. **CHORUS** (throbbing phase swirl) / **VIBRATO** (pitch wobble). The lamp glows with the sweep |
| **CHROMA CHORUS** | Boss CE-2W chorus | Rate, Depth, mode **STD** (CE-2) / **CE-1 CHO** (stereo) / **CE-1 VIB** (vibrato) |
| **VOID VERB** | Boss RV-6 reverb | E.Level, Tone, Time, Mode: Room, Hall, Plate, Spring, Modulate, +Delay, Shimmer, Dynamic |

| **NEON STACK** (amp) | **PLEXI**: Marshall 1959 · **HIWATT**: DR103 · **FENDER**: Blackface | Gain, Bass, Middle, Treble, Volume, and a power switch |

**Which amp for which sound:** PLEXI for Led Zeppelin, Hendrix and Cream-era Clapton, HIWATT for The Who, and FENDER
with the NEON SCREAMER in front for Stevie Ray Vaughan. Factory presets for each are a starting point
(**Psychedelic Hendrix** and **Machine Gun (Band of Gypsys)** use the fuzz and vibe in Hendrix's order; also
**Cream Woman Tone (Clapton)**, **Clean Fender + Spring** and more). GAIN below noon is
genuinely clean on FENDER and HIWATT; the PLEXI always has a little hair, like the real one. The amp is for playing through
headphones or speakers; keep **CAB SIM** on with it. If you play into a real amp, leave NEON STACK out.

The models are approximations written for this app. They are not circuit-exact clones. NEON RIG has no recording or tracks. It's just the pedals.

## Start it

Nothing to install. It runs in your web browser.

- **Windows**: double-click `Start NEON RIG (Windows).cmd` (opens in Edge), or open `index.html` in Chrome/Edge.
- **Mac**: open `index.html` in Chrome (right-click → Open With → Google Chrome), or double-click `Start NEON RIG (Mac).command`.
  If macOS won't run the .command file, run `chmod +x "Start NEON RIG (Mac).command"` once in Terminal.
- **If a browser refuses audio from a local file**, run `node serve.js` in this folder (needs Node.js) and use the address it prints.

Then press **START** and allow microphone access. The browser calls every audio input a "microphone".

**If START says audio input is blocked**, the operating system is refusing it:
- **Windows**: Settings → Privacy & security → Microphone → turn on **"Let desktop apps access your microphone"**, then restart the browser.
- **Mac**: System Settings → Privacy & Security → Microphone → switch on **Google Chrome**, then restart Chrome.

## Plug and go

**INPUT** and **OUTPUT** start on **AUTO**, so any guitar input works without setup:

- **INPUT AUTO** picks the most guitar-like device: a known interface (Focusrite, Behringer, PreSonus, Line 6,
  Boss, iRig and others) or a USB guitar cable, ahead of a generic USB device. It never picks the laptop mic,
  a webcam or a headset while something better is plugged in.
- **OUTPUT AUTO** plays out of the same box the guitar comes in on (the Scarlett's headphone jack). A cable with no
  output of its own, like the Rocksmith one, plays through the computer's headphones or speakers.
- **Plug in or swap devices while it's running.** The guitar device you just plugged in takes over. If you pull it
  out, NEON RIG goes quiet and waits; it doesn't switch to the laptop mic, which would howl through a fuzz.
- Picking a device by name in either menu pins it. Pick **AUTO** again to go back.
- Use **wired** headphones or speakers. Bluetooth adds 150-300 ms of delay, and NEON RIG warns you when it's in use.
- The OUTPUT menu needs Chrome or Edge. In other browsers, sound goes to your computer's default output.

## Rocksmith Real Tone Cable (or another USB guitar cable)

Plug it into a USB-A port (or a USB-C adapter) and press **START**. It shows up as "Rocksmith Guitar Adapter".
It has no volume knob or headphone jack: use **GAIN** here for level, and plug headphones into the computer.
If it clips, turn the guitar's volume down a little. Quit the Rocksmith game first, because it can hold the cable
for itself. These cables hiss a bit more than an interface, so press **LEARN NOISE** once.

## Focusrite Scarlett Solo setup

1. Plug the guitar into the **instrument jack** (input 2) and press **INST**.
2. **Turn Direct Monitor OFF.** Otherwise you hear the dry guitar on top of the pedals.
3. Set the Scarlett's gain so its ring shows green when you play hard, never red. Red means the input
   is clipping, which sounds like static and can't be fixed afterwards. Hot pedals in front of the Scarlett
   (an OD-3 with its level up, for example) push it into the red, so turn the gain down when they're on.
   The app warns you when it sees clipping.
4. **INPUT** and **OUTPUT** on AUTO pick the Scarlett by themselves. **CH: AUTO** picks the input your guitar is on. The small 1/2 meters show which one that is.
5. **CAB SIM** voices the output like a guitar speaker, which is best for headphones. Turn it off if you feed a real amp.

## Playing through your real amp

Use NEON RIG as the chorus and reverb your board doesn't have. Load the **Real Amp: Chorus + Reverb** preset,
which also switches **CAB SIM** off (a speaker voicing for headphones only). Leave NEON STACK out; your amp is the amp.

**Which hookup:**
- **Amp with an effects loop (best):** amp's **FX SEND** → Scarlett input 2 (INST off if the send is line
  level) → NEON RIG → Scarlett **LINE OUT L** → amp's **FX RETURN**. Chorus and reverb then come after the
  amp's distortion, as on a studio rig, so a dirty amp stays clear.
- **No effects loop:** guitar → your pedals → Scarlett input 2 (INST on) → NEON RIG → Scarlett **LINE OUT L** →
  amp's input. This works well into a clean or edge-of-breakup amp. Into a heavily driven amp the reverb gets
  muddy, because it's distorted along with the guitar.

**Setup:**
1. Use the Scarlett's rear **LINE OUT L** jack with an ordinary mono guitar (TS) cable. Not the headphone jack.
   The left channel alone carries the whole chorus and reverb.
2. **Direct Monitor OFF** on the Scarlett. Otherwise the dry guitar reaches the amp a few milliseconds ahead
   of the processed one, and the mix sounds phasey and thin.
3. Line out is much hotter than a guitar. Start with the Scarlett's big **OUTPUT** knob low and **MASTER** at
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
  isolator on the Scarlett's output, or keep the laptop unplugged while you play.
- **Buzz that changes as you turn around** is single-coil pickups picking up monitors, dimmers and chargers.
  Face away from them.

## Using the board

- **Knobs**: drag up/down or scroll. Hold Shift for fine moves; double-click resets.
- **Not sure what something does?** Rest the mouse on it for a moment and a tip pops up beside it.
- **Footswitch** (bottom of each pedal): click to engage or bypass. Reverb tails ring out when bypassed.
- **Move pedals**: drag them by the body. **Change the signal order**: drag the chips in the SIGNAL CHAIN bar.
- **ARRANGE** lines pedals up in chain order. **+ ADD PEDAL** adds more (two drives is fine). The × on a pedal removes it, with UNDO.
- The board saves itself. **SAVE** stores named presets, and five factory presets are included.

## Latency

Browsers add some delay between string and ear. The top bar shows the browser's estimate. **BUF** picks the
audio buffer: LOW (≈10 ms) is the default; SAFE and MAX trade a little delay for no crackles. To keep it low:
use Chrome or Edge, close other audio apps, set the Scarlett and your system to 48 kHz, and use the
Scarlett's own output, not Bluetooth. If you still find it too slow, the DSP in `dsp.js` is self-contained
and could later be moved into a native app that talks to the Scarlett's ASIO driver directly.

## Files

- `index.html`, `style.css`, `app.js`: UI, layout, presets, and audio routing (Web Audio API)
- `dsp.js`: the pedal models (AudioWorklet processors)
- `serve.js`: optional local web server (`node serve.js`)
- `tests/dsp-test.js`: offline DSP checks (`node tests/dsp-test.js`)
