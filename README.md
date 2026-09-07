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

## Verification

- `node tools/test-all.js` — 10 gates, ~4800 checks, zero dependencies:
  transform/TDAC bypass identity, energy conservation through the fold,
  gravity/memory/hunt time constants, block-switch windows, tilt shift,
  synth voice bank, worklet == offline render sample-identical.
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
wav.js  png.js  WAV + PNG, zero-dependency
worklet-effect.js  worklet-synth.js  AudioWorkletProcessors
tools/        test-all.js + test-*.js, bench-core.js, render.js, bump-cache.sh
```

## Licence

AGPL-3.0.