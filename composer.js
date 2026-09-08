// composer.js — the melody voice. A strictly mono step sequencer that runs
// in the MAIN thread (not the worklet blob): it consumes the effect's taps
// and emits synth note events, so the main thread is the bus in both
// directions. Everything musical about it is borrowed from the codec:
//
//  - register: the Memory map's centroid picks the octave band (starved
//    content piles up where the fold put it; the voice follows)
//  - key: the held chord (M6a detection) is the only note source; with no
//    chord the voice rests
//  - wildness: Hunt flattens the wander kernel — low Hunt walks stepwise
//    around the chord, high Hunt jumps
//  - survival: when Budget starves most bands, non-onset notes are skipped;
//    the melody thins out exactly when the codec is squeezing
//  - onset: the composer computes its own spectral flux from consecutive
//    taps' band energies — hits re-trigger, pads sustain
//
// Timing rides tap.start (the engine's own sample clock) so the step grid
// follows the codec's frames, not the main thread's event loop; a late tap
// catches up at most 3 steps, then resyncs. Note timing therefore jitters
// by up to one frame + event-loop delay (named limitation — no lookahead).
'use strict';
(function (root) {
  // same generator as pipeline.js's mulberry32 — duplicated because the
  // main thread never loads pipeline.js
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // chord shapes as semitone offsets from the root — mirrors pipeline.js's
  // CHORD_TEMPLATES (duplicated: this file must load without the worklet)
  var SHAPES = { major: [0, 4, 7], minor: [0, 3, 7], dom7: [0, 4, 7, 10] };
  // wander kernel over offsets -3..+3: a random walk that mostly stays put
  var KERNEL = [1, 3, 5, 7, 5, 3, 1];
  var KTOT = KERNEL.reduce(function (a, b) { return a + b; }, 0);

  var clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };

  function create(opts) {
    opts = opts || {};
    var rng = mulberry32(opts.seed || 0x50a7);

    var melody = false, density = 0.5, hunt = 0.25;
    var lastStart = null;      // engine sample clock of the last step
    var prevE = null;          // previous tap's band energies (flux reference)
    var onsetLatch = false;    // a flux spike fired since the last step
    var center = null;         // smoothed register centre, MIDI
    var wi = 0;                // wander offset from the centre, semitones
    var salPeak = 0;           // slow follower on peak band energy
    var active = [];           // composer-held notes, for mono discipline

    function releaseAll() {
      var events = [];
      for (var i = 0; i < active.length; i++)
        events.push({ note: active[i].note, on: false, vel: 0 });
      active.length = 0;
      return events;
    }

    function fluxOf(tap) {
      var e = tap.bandsE, B = e.length;
      if (!prevE || prevE.length !== B) return 0;
      var up = 0, ref = 0;
      for (var j = 0; j < B; j++) {
        var d = e[j] - prevE[j];
        if (d > 0) up += d;
        ref += prevE[j];
      }
      return up / (ref + 1e-9);
    }

    function stepOnce(tap) {
      var events = releaseAll();
      var e = tap.bandsE, B = e.length;

      // register from the Memory map centroid, eased slowly
      if (!tap.short && typeof tap.centroid === 'number' && isFinite(tap.centroid)) {
        var target = 48 + clamp(tap.centroid / B, 0, 1) * (84 - 48);
        center = center === null ? target : center + 0.25 * (target - center);
      }

      // no chord -> rest: the melody only sings what the codec can name.
      // Also rest until a long-grid tap has set the register (short-only
      // streams otherwise produce sub-audio notes near MIDI 0).
      if (center === null || !tap.chord || !tap.chord.quality) return events;

      var maxE = 0;
      for (var j = 0; j < B; j++) if (e[j] > maxE) maxE = e[j];
      salPeak = Math.max(salPeak * 0.995, maxE);

      var onset = onsetLatch;
      onsetLatch = false;

      // survival: starved bands squeeze non-onset notes out entirely
      if (!onset && tap.starvedN / B > 0.6) return events;

      // wander: Hunt flattens the walk kernel into jumps
      if (rng() < clamp(hunt, 0, 1)) {
        wi += Math.floor(rng() * 13) - 6;
      } else {
        var pick = rng() * KTOT, acc = 0;
        for (var k = 0; k < KERNEL.length; k++) {
          acc += KERNEL[k];
          if (pick < acc) { wi += k - 3; break; }
        }
      }
      if (wi > 12) wi = 12; else if (wi < -12) wi = -12;
      if (wi > 9) wi -= 1; else if (wi < -9) wi += 1;   // ease back home

      // nearest chord tone to centre + wander
      var pcs = SHAPES[tap.chord.quality];
      var n0 = Math.round(center + wi);
      var best = 99, note = n0;
      for (var q = 0; q < pcs.length; q++) {
        var pc = (tap.chord.root + pcs[q]) % 12;
        // distance from n0 to the nearest note of this pitch class
        var o = ((pc - (n0 % 12)) % 12 + 12) % 12;
        if (o > 6) o -= 12;
        if (Math.abs(o) < best) { best = Math.abs(o); note = n0 + o; }
      }

      var v = (0.3 + 0.5 * Math.min(1, Math.sqrt(maxE) / (Math.sqrt(salPeak) + 1e-9))) *
        (onset ? 1 : 0.8) * (1 + clamp(hunt, 0, 1) * (rng() - 0.5));
      v = clamp(v, 0.08, 1);
      active.push({ note: note });
      events.push({ note: note, on: true, vel: v });
      // an onset at high density sometimes doubles down an octave
      if (onset && density > 0.6 && rng() < 0.25) {
        active.push({ note: note - 12 });
        events.push({ note: note - 12, on: true, vel: v * 0.6 });
      }
      return events;
    }

    return {
      setParams: function (p) {
        p = p || {};
        if (p.melody !== undefined) melody = !!p.melody;
        if (p.density !== undefined) density = clamp(+p.density || 0, 0, 1);
        if (p.hunt !== undefined) hunt = clamp(+p.hunt || 0, 0, 1);
      },
      // step(tap, fs) -> [{note, on, vel}] for the synth. Called once per
      // taps message; the clock rides tap.start so the grid is the engine's.
      // Short-frame taps still advance the clock (Frame=short must not
      // freeze the line — measured freeze before this guard existed); only
      // the register and flux reads are long-grid, so those are gated.
      step: function (tap, fs) {
        if (!melody) {
          return active.length ? releaseAll() : [];
        }
        if (!tap.short) {
          var flux = fluxOf(tap);
          prevE = Float32Array.from(tap.bandsE);
          if (flux > 0.18) onsetLatch = true;
        }

        var stepLen = fs * (0.42 - 0.34 * density);
        if (lastStart === null) { lastStart = tap.start; return []; }
        var due = Math.floor((tap.start - lastStart) / stepLen);
        if (due <= 0) return [];
        if (due > 3) { lastStart = tap.start; due = 1; }   // resync, skip ahead
        var events = [];
        for (var s = 0; s < due; s++) {
          lastStart += stepLen;
          var evs = stepOnce(tap);
          for (var i = 0; i < evs.length; i++) events.push(evs[i]);
        }
        return events;
      },
      reset: function () {
        var events = releaseAll();
        lastStart = null; prevE = null; onsetLatch = false;
        center = null; wi = 0; salPeak = 0;
        return events;
      }
    };
  }

  var mod = { create: create, SHAPES: SHAPES };
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.RDComposer = mod;
})(typeof self !== 'undefined' ? self : globalThis);