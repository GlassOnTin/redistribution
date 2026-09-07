# VISION — Redistribution

**A perceptual-coder effect pedal and synth, entirely in the browser.** ATRAC-family
codec machinery — MDCT frames, per-band scalefactors, masking-threshold bit
allocation, block switching — becomes musical controls. The codec's *decisions* are
the instrument, not a quality metric to be hidden.

This is the fifth project on the BracketFuse chassis, and the first audio one. The
image-family plumbing (worker respawn, megapixel budgets, Mat lifecycles) does not
transfer; what transfers is the conventions — see
[Inherited from the chassis](#inherited-from-the-chassis).

---

## Why this

Every audio codec does something musically interesting and then spends the rest of
its engineering making sure you never hear it: starved bands dropped, energy
redistributed under masking shadows, allocation hunting between frames, block-size
transitions. The MiniDisc archive warble is the sound of early ATRAC failing to hide
those decisions on cymbals. This project turns the hiding inside out: the allocator,
the gravity of starved energy, the adaptation memory, the phase loop — each one a
knob, dragging in real time, on loops and on a polyphonic synth whose dense chords
degrade unevenly under a shared bit budget.

**Client-side or it doesn't ship.** Static site on GitHub Pages, no backend, no
analytics, no telemetry.

---

## The controls

| Control | Mechanism |
|---|---|
| `Budget` | bits per frame → per-band quantization driven by a simplified masking model |
| `Gravity` | starved bands remap downward in frequency instead of quantizing down |
| `Memory` | time constant of the redistribution map — persists through silence |
| `Hunt` | allocator smoothing; low = audible allocation churn |
| `Lock` | per-band phase-loop bandwidth: tight ↔ free-running smear |
| `Curve` | frequency-axis warp of the fold: Bark / power-law / linearised |
| `Frame` | long / short / adaptive block switching — the switch itself audible |
| `Intensity` | top-band joint-stereo collapse with energy pan |
| `Mask` | drop sub-threshold bands, or hide them under a louder neighbour's shadow |

Synth mode: polyphony scales the shared budget down, so chords degrade unevenly
through the masking model rather than uniformly.

---

## Two corrections to the original sketch

Recorded because they change what the controls mean.

1. **Complex spectrum, not a real MDCT.** A real MDCT carries no per-bin phase, which
   makes `Lock`, `Mask=hide`, and gravity's many-to-one fold undefined. We keep the
   complex pair (MDCT+MDST = real/imag of the windowed block's DFT, sine window,
   TDAC exact). Bypass identity is the first test written; if the cross-terms do not
   behave, the fallback re-scopes `Lock` to a sign-coherence blend.
2. **One full-rate transform, not ATRAC's 3-band QMF split.** Bins group into ~28
   Bark-based bands for allocation, 3 groups for stereo/tilt processing. The QMF
   split is a deferred possibility, not a v1 claim.

---

## Success criteria

Measurable, with the measurement stated. Written before the code.

1. **Bypass identity.** All parameters neutral → output equals input aligned by
   W−1 samples, SNR > 120 dB. The first test written; it is also the decision gate
   for correction 1.
2. **Gravity moves mass downward.** Energy injected in band 20 at `Gravity=1`
   returns with centroid in band ≤ 12 and total energy within 2%.
3. **Conservation.** Energy ratio monotone non-decreasing in `Budget`;
   within [0.98, 1.02] with gravity + `ExactEnergy`.
4. **Memory behaves like memory.** A 3 s high-band tone followed by 5 s of
   silence: at `Memory=30 s` the map retains > 70%; at 0.1 s it holds < 5%.
5. **Live == offline.** The deployed page's spectrogram, for the same input and
   parameters, matches the node harness's offline spectrogram.
6. **Gravity sounds right.** The offline param-sweep spectrogram grid + the
   operator's ears decide; the node harness is the cheapest place to change the map.

---

## Non-goals for v1

- Bitstream compatibility with any ATRAC codec. No scalefactors are serialised.
- An encoder-grade psychoacoustic model (tonality, absolute SPL, temporal masking).
- True SSB tilt (v1 tilt is DSB; the image is part of the character).
- A spectral/additive synth (v1 synth is a subtractive voice bank; polyphony couples
  to the budget, the masking model does the uneven degradation).
- Mobile browser verification (chassis convention: named when measured).

---

## Inherited from the chassis

| Piece | What it does |
|---|---|
| dual-loaded core module | browser (classic script / importScripts) and node (`require`) run identical code |
| inline pre-module error trap | reports failures on the page, no DevTools needed |
| `selftest.html` | on-device worklet/CPU ladder |
| `tools/bump-cache.sh` | `?v=` cache buster; Pages serves `max-age=600` |
| zero-dependency node tests | analytic ground truth, no golden numbers, `test-all.js` gate |
| `tools/png.js` | copied from astrogate; PNG spectrograms for offline inspection |
| blob-URL worklet composition | no build step; `pipeline.js` + processor text concatenated |

New here: everything audio — AudioWorklet processors, TDAC windows, the allocation
stage, wavetable voices. No OpenCV.js and no wasm; all DSP is plain JS `Float32Array`s.

---

## Open decisions

Recorded rather than resolved.

- **Gravity fold: complex-sum (rich, partially cancelling) or quadrature
  (exactly conserving)?** Both ship; the spectrogram sweep decides the default.
- **Does `Lock` earn its keep, or is band-level phase steering too coarse?**
  Test asserts phase variance ordering on a sine; the ear decides on chords.
- **QMF split** — deferred; revisit only if the linear-bin HF resolution audibly
  limits the fold at the top end.

---

## Licence

AGPL-3.0, matching the chassis. The network clause matters here too: a hosted
derivative has to publish its source.