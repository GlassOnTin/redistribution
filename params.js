// params.js — single source of truth for parameter names, ranges, defaults.
// Dual-loaded: app.js (browser) and tools/render.js (node) both require it.
// pipeline.js reads live values from an engine.params object; the keys here
// are the contract between UI, worklet and node CLI.
(function (root) {
  'use strict';

  // Order matters: it is the UI order. The six named controls first, switches
  // next, the advanced group last (rendered inside <details>).
  var PARAMS = [
    { key: 'budget',    label: 'Budget',   min: 0, max: 1, step: 0.01, def: 0.85, hint: 'Bits per frame. As it falls the allocator stops coding everything and starts moving things.' },
    { key: 'gravity',   label: 'Gravity',  min: 0, max: 1, step: 0.01, def: 0, hint: 'Starved bands remap downward in frequency instead of quantizing down.' },
    { key: 'memory',    label: 'Memory',   min: 0.1, max: 30, step: 0.01, def: 2, log: true, unit: 's', hint: 'Time constant of the redistribution map. Long: the ghost of the last seconds survives silence.' },
    { key: 'hunt',      label: 'Hunt',     min: 0, max: 1, step: 0.01, def: 0.25, hint: 'Allocator smoothing. Low: audible allocation churn. High: frozen, stodgy allocation.' },
    { key: 'lock',      label: 'Lock',     min: 0, max: 1, step: 0.01, def: 0.5, hint: 'Per-band phase loop bandwidth. Tight: bands snap. Open: bands drift and smear.' },
    { key: 'curve',     label: 'Curve',    def: 'bark', options: ['bark', 'power', 'linear'], hint: 'Frequency-axis warp of the fold.' },
    { key: 'frame',     label: 'Frame',    def: 'long', options: ['long', 'short', 'adaptive'], hint: 'Block size. The switch itself is audible by design.' },
    { key: 'mask',      label: 'Mask',     def: 'drop', options: ['drop', 'hide'], hint: 'Sub-threshold bands: dropped, or hidden under a louder neighbour.' },
    // advanced group
    { key: 'power',     label: 'Power',    min: 0.4, max: 1, step: 0.01, def: 0.7, advanced: true, hint: 'Exponent when Curve = power.' },
    { key: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.01, def: 0, advanced: true, hint: 'Above ~12 kHz, collapse to intensity stereo with energy pan.' },
    { key: 'level',     label: 'Level',    min: -40, max: 0, step: 1, def: -20, unit: 'dB', advanced: true, hint: 'Assumed playback level for the masking model. No SPL calibration — relative only.' },
    { key: 'tiltLow',   label: 'Tilt low',  min: -200, max: 200, step: 1, def: 0, unit: 'Hz', advanced: true, hint: 'Frequency shift, < 200 Hz group.' },
    { key: 'tiltMid',   label: 'Tilt mid',  min: -200, max: 200, step: 1, def: 0, unit: 'Hz', advanced: true, hint: 'Frequency shift, 200 Hz – 2 kHz group.' },
    { key: 'tiltHigh',  label: 'Tilt high', min: -200, max: 200, step: 1, def: 0, unit: 'Hz', advanced: true, hint: 'Frequency shift, > 2 kHz group.' },
    { key: 'dry',       label: 'Dry',      min: 0, max: 1, step: 0.01, def: 1, advanced: true, hint: 'Parallel dry path.' },
    { key: 'wet',       label: 'Wet',      min: 0, max: 1, step: 0.01, def: 1, advanced: true, hint: 'Processed path level.' },
    { key: 'inGain',    label: 'In',       min: -24, max: 24, step: 0.5, def: 0, unit: 'dB', advanced: true, hint: 'Input trim.' },
    { key: 'outGain',   label: 'Out',      min: -24, max: 24, step: 0.5, def: 0, unit: 'dB', advanced: true, hint: 'Output trim.' },
    { key: 'exactEnergy', label: 'Exact energy', def: false, advanced: true, kind: 'bool', hint: 'Gravity fold conserves energy exactly (quadrature) instead of complex-sum.' },
    { key: 'voiceWaveform', label: 'Voice', def: 'saw', options: ['saw', 'harmonic'], advanced: true, hint: 'Synth voice waveform.' }
  ];

  var DEFAULTS = {};
  PARAMS.forEach(function (p) { DEFAULTS[p.key] = p.def; });

  // Polyphony scales the effective bit budget. 1 voice -> 1.00, 8 -> 0.37, 16 -> 0.22.
  function budgetScale(voices) {
    if (!(voices > 1)) return 1;
    return 1 / (1 + 0.24 * (voices - 1));
  }

  // Fast path: with every mechanism neutral the transform chain is an exact
  // identity (TDAC reconstruction), so the engine skips modification entirely.
  // Block switching stays active — the TDAC identity holds across any legal
  // window sequence, so switching still costs latency but not fidelity.
  function isBypass(p) {
    return p.budget >= 0.999 &&
      p.gravity <= 1e-6 &&
      p.mask !== 'hide' &&
      p.intensity <= 1e-6 &&
      p.lock <= 1e-6 &&
      Math.abs(p.tiltLow) < 1e-6 &&
      Math.abs(p.tiltMid) < 1e-6 &&
      Math.abs(p.tiltHigh) < 1e-6;
  }

  var mod = { PARAMS: PARAMS, DEFAULTS: DEFAULTS, budgetScale: budgetScale, isBypass: isBypass };
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.RDParams = mod;
})(typeof self !== 'undefined' ? self : globalThis);