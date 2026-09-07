# Redistribution — a perceptual-coder pedal, in your browser

*(Work in progress — this README is written up-front and updated as things are
measured. Claims marked unverified are unverified.)*

Open a loop or play the synth. The tool processes audio the way a perceptual
codec does — MDCT frames, per-band bit allocation, masking — and leaves the
codec's decisions exposed as controls instead of hiding them. Everything runs on
your device. There is no upload and no backend.

[VISION.md](VISION.md) explains the design and records the corrections made to
the original sketch before any code existed.

## How it works

```
source (loop / synth / file drop / mic)
  -> preGain -> effect (AudioWorklet)
       sine-windowed complex TDAC frames (long 2048 / short 512, block switching)
       -> ~28 Bark-based bands -> masking model -> per-band bit allocation
       -> per-band scalefactor quantisation
       -> gravity fold of starved bands downward (memory-shaped map)
       -> per-band phase lock -> inverse transform, overlap-add
  -> tilt (3-way crossover + per-group frequency shift) -> masterGain
```

## Not tested

*(Nothing verified yet — this section grows with the build.)*

## Running it

```sh
python3 -m http.server 8413        # then open http://localhost:8413/
node tools/test-all.js             # unit tests, zero dependencies
```

## Repository layout

*(Filled in as files land.)*

## Licence

AGPL-3.0.