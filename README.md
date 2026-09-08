# Redistribution — a perceptual-coder pedal, in your browser

Open a loop or play the synth. The tool processes audio the way a perceptual
codec does — MDCT frames, per-band bit allocation, masking — and leaves the
codec's decisions exposed as controls instead of hiding them. Everything runs on
your device. There is no upload and no backend.

[VISION.md](VISION.md) explains the design and records the corrections made to
the original sketch before any code existed.

## How it works

```
source (loop / synth)
  -> effect (AudioWorklet, one shared instance — every source sums into it)
       sine-windowed complex TDAC frames (long 2048 / short 512, block switching)
       -> ~28 Bark-based bands -> masking model -> per-band bit allocation
       -> per-band scalefactor quantisation
       -> gravity fold of starved bands downward (memory-shaped map)
       -> per-band phase lock -> inverse transform, overlap-add
  -> masterGain -> output
```

The live waterfall paints the engine's own post-warp spectrum with the same
renderer as the offline PNGs (72 dB floor, log frequency), plus blue ticks
marking each folded band's original top edge. Save PNG exports it.

## Chord, Follow, Melody

The codec's decisions drive three things beyond the fold itself.

**Chord** — every long frame, the engine builds a pitch-class histogram from
its own spectrum, weighted by each band's energy and bit allocation, and
template-matches major / minor / dom7. The held chord updates by a sliding
vote, so it fades between chords instead of snapping. The readout next to the
waterfall shows what it currently holds. It is deliberately imprecise: a
strong out-of-chord tone usually joins the held chord (F#5 over an Am pad
reads as D7), and dyads flip quality while the root holds.

**Follow** — pulls the frame's loudest partial to the nearest tone of the held
chord (the original stays; the copy is additive) and blooms two harmonics
above it. Placement quantises to the frame's frequency grid (±11.7 Hz at
Frame=long), and a copy landing on a bin that already carries a tone can
cancel it — a wobble inherited from the Lock family. Long frames only.

**Melody** — a mono synth voice that sings the held chord. Its register
follows the Memory map's centroid, Hunt flattens its wander from stepwise
walk to jumps, and Budget starvation thins the line (starved non-onset notes
are skipped). Its own spectral-flux onset gate re-triggers on hits; step
timing rides the engine's frame clock and jitters by up to one frame plus
event-loop delay. With no held chord the voice rests.

## Verification

- `node tools/test-all.js` — 13 gates, ~5300 checks, zero dependencies:
  transform/TDAC bypass identity, energy conservation through the fold,
  gravity/memory/hunt time constants, block-switch windows, tilt shift,
  chord detection on synthetic + loop material, the Follow transform,
  the composer state machine, synth voice bank, worklet == offline render
  sample-identical.
- `selftest.html` — in-browser ladder: live graph == worker.js render,
  residual 0.00e+0 over 20 segments on this machine.
- Deployed site verified in-browser: console clean, spectrogram draws,
  knobs and keys drive the engine.

## Not tested

- Real-time at device rates above 48 kHz: this workstation's output device
  runs at 192 kHz, where the per-quantum deadline (3.5 ms) overruns and
  Chrome backs up the worklet input FIFO. The page pins the AudioContext to
  48 kHz and lets Chrome resample, which sidesteps it; a 44.1 kHz device is
  untested.
- Audible quality is unmeasured by ear beyond "loops and synth sound and
  degrade as designed": no listening study, no reference comparison.
- iOS Safari (blob-URL addModule quirks), Firefox decode coverage,
  24-bit/96 kHz drops, memory state across suspend/resume, mobile CPU at
  Frame=short, bypass under rapid adaptive switching.
- The masking model over-masks tonal material by design simplification
  (no tonality detection, no temporal masking, no SPL calibration).

## Running it

```sh
python3 -m http.server 8413        # then open http://localhost:8413/
node tools/test-all.js             # unit tests, zero dependencies
node tools/render.js --synth drums # offline WAV + spectrogram PNG
```

## Repository layout

```
index.html  app.js  worker.js  selftest.html  VISION.md  README.md
pipeline.js   the algorithm — dual-loaded (script tag / worklet blob / node)
params.js     param schema, single source of truth for UI, worklet, tests
loops.js      synthesized loops (page menu and node tests share the code)
synth.js      16-voice band-limited wavetable bank
composer.js   melody voice — main thread, eats the effect's taps
wav.js  png.js  WAV + PNG, zero-dependency
worklet-effect.js  worklet-synth.js  AudioWorkletProcessors
tools/        test-all.js + test-*.js, bench-core.js, render.js, bump-cache.sh
```

## Licence

AGPL-3.0.