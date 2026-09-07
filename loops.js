// loops.js — synthesized built-in loops, identical code in the browser menu
// and the node CLI. Dual-loaded; deterministic (seeded xorshift — core modules
// never touch unseeded Math.random).
//
// Each loop renders stereo Float32Arrays. Nothing here is mixed through
// Synth — the loops are stand-alone generators so render.js and the page get
// bit-identical material.
(function (root) {
  'use strict';

  // ---- deterministic noise ----
  function PRNG(seed) {
    var s = seed >>> 0 || 0x9e3779b9;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 0x100000000; // [0,1)
    };
  }

  function mk(len) { return new Float32Array(len); }

  // --- drums: 2 bars @ 120 BPM. kick / snare / hat over a four-floor pattern ---
  function drums(fs) {
    var bpm = 120, beat = 60 / bpm, bars = 2, len = Math.floor(bars * 4 * beat * fs);
    var L = mk(len), R = mk(len), rnd = PRNG(1234567);
    // one-pole high-pass noise state for hats
    var hp1 = 0, hp2 = 0;
    function kick(t0, gain) {
      var dur = 0.35, n = Math.floor(dur * fs);
      var ph = 0;
      for (var i = 0; i < n; i++) {
        var t = i / fs;
        var f = 40 + 90 * Math.exp(-t * 22);            // pitch drop 130 -> 40 Hz
        ph += 2 * Math.PI * f / fs;
        var env = Math.exp(-t * 9);
        var v = Math.sin(ph) * env * gain;
        L[t0 + i] += v; R[t0 + i] += v;
      }
    }
    function snare(t0, gain) {
      var dur = 0.22, n = Math.floor(dur * fs);
      var ph = 0, z = 0;
      for (var i = 0; i < n; i++) {
        var t = i / fs;
        ph += 2 * Math.PI * 185 / fs;
        var w = (rnd() * 2 - 1) * Math.exp(-t * 30);    // noise body
        z = 0.6 * z + 0.4 * w;                          // slight smoothing
        var env = Math.exp(-t * 18);
        var v = (0.5 * z + 0.5 * Math.sin(ph)) * env * gain;
        L[t0 + i] += v * 0.9; R[t0 + i] += v;
      }
    }
    function hat(t0, gain) {
      var dur = 0.06, n = Math.floor(dur * fs);
      for (var i = 0; i < n; i++) {
        var t = i / fs;
        var w = rnd() * 2 - 1;
        var y = w - hp1;                 // first-order high pass
        hp1 = w;
        var y2 = y - 0.9 * hp2; hp2 = y; // second-order for brightness
        L[t0 + i] += y2 * Math.exp(-t * 55) * gain * 0.7;
        R[t0 + i] += y2 * Math.exp(-t * 55) * gain;
      }
    }
    for (var b = 0; b < bars; b++) {
      var bt = b * 4 * beat;
      kick(Math.floor((bt + 0) * fs), 0.9);
      kick(Math.floor((bt + 1.5) * fs), 0.7);
      kick(Math.floor((bt + 2) * fs), 0.9);
      kick(Math.floor((bt + 3.5) * fs), 0.7);
      snare(Math.floor((bt + 1) * fs), 0.6);
      snare(Math.floor((bt + 3) * fs), 0.6);
      for (var e = 0; e < 8; e++) {
        hat(Math.floor((bt + e * 0.5) * fs), e % 2 ? 0.35 : 0.55);
      }
    }
    return { left: L, right: R };
  }

  // --- pad: slow harmonic-mode chords, Am -> F -> C -> G, 4 s ---
  function pad(fs) {
    var secs = 4, len = Math.floor(secs * fs);
    var L = mk(len), R = mk(len);
    // chord = MIDI notes; each lasts one second
    var chords = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 52, 55, 60], [55, 59, 62, 67]];
    for (var c = 0; c < chords.length; c++) {
      var t0 = Math.floor(c * fs), n = Math.floor(fs);   // 1 s per chord
      var notes = chords[c];
      for (var vi = 0; vi < notes.length; vi++) {
        var f = 440 * Math.pow(2, (notes[vi] - 69) / 12);
        // 6 partials, a_p = p^-0.8, slight inharmonicity — the pad voice
        var att = Math.floor(0.12 * fs);                 // soft pad attack
        for (var p = 1; p <= 6; p++) {
          var fp = f * p * (1 + 4e-4 * p * p), w = 2 * Math.PI * fp / fs;
          var a = Math.pow(p, -0.8) / notes.length;
          var det = 1 + (vi % 2 ? 0.0015 : -0.0015);     // gentle stereo width
          for (var i = 0; i < n; i++) {
            var env = i < att ? i / att : 1;
            L[t0 + i] += Math.sin(w * (i + t0) * det) * a * env * 0.5;
            R[t0 + i] += Math.sin(w * (i + t0) / det) * a * env * 0.5;
          }
        }
      }
    }
    // 0.4 s fade-out so loops click cleanly
    var fo = Math.floor(0.4 * fs);
    for (var j = 0; j < fo; j++) {
      var g = 1 - j / fo;
      L[len - fo + j] *= g; R[len - fo + j] *= g;
    }
    return { left: L, right: R };
  }

  // --- arp: 16th-note arpeggio, Em pentatonic, 3 s, plucky saw-ish tone ---
  function arp(fs) {
    var bpm = 128, step = 60 / bpm / 4, steps = 16, len = Math.floor(steps * step * fs);
    var L = mk(len), R = mk(len);
    var scale = [40, 43, 47, 50, 52, 55, 59, 62];        // E3 pentatonic
    var seq = [0, 2, 4, 6, 7, 6, 4, 2, 1, 3, 5, 7, 6, 5, 3, 1];
    for (var s = 0; s < steps; s++) {
      var t0 = Math.floor(s * step * fs), n = Math.floor(step * fs);
      var note = scale[seq[s]];
      var f = 440 * Math.pow(2, (note - 69) / 12);
      var att = Math.floor(0.003 * fs), dec = Math.exp;  // pluck: fast attack, exp decay
      var k = 1 / att;
      for (var i = 0; i < n; i++) {
        var env = i < att ? i * k : Math.exp(-(i - att) / (0.12 * fs));
        var w = 2 * Math.PI * f / fs;
        // saw-ish: 5 harmonics 1/p
        var v = 0;
        for (var p = 1; p <= 5; p++) v += Math.sin(w * p * (i + t0)) / p;
        v *= 0.55;
        var pan = 0.5 + 0.3 * Math.sin(s * 1.3);         // slow alternation
        L[t0 + i] += v * env * (1 - pan * 0.4);
        R[t0 + i] += v * env * (0.6 + pan * 0.4);
      }
    }
    return { left: L, right: R };
  }

  // --- sweep: exponential chirp 100 Hz -> 10 kHz, 2 s, mono ---
  function sweep(fs) {
    var secs = 2, len = Math.floor(secs * fs);
    var L = mk(len), R = mk(len);
    var f0 = 100, f1 = 10000;
    var r = Math.log(f1 / f0) / secs;
    var ph = 0;
    for (var i = 0; i < len; i++) {
      var t = i / fs;
      ph += 2 * Math.PI * f0 * Math.exp(r * t) / fs;
      var env = i < 0.05 * fs ? i / (0.05 * fs) : (i > len - 0.05 * fs ? (len - i) / (0.05 * fs) : 1);
      var v = Math.sin(ph) * env * 0.5;
      L[i] = v; R[i] = v;
    }
    return { left: L, right: R };
  }

  var LOOPS = [
    { id: 'drums', name: 'Drums', seconds: 4, gen: drums },
    { id: 'pad', name: 'Pad chords', seconds: 4, gen: pad },
    { id: 'arp', name: 'Arp', seconds: 16 * 60 / 128 / 4, gen: arp },
    { id: 'sweep', name: 'Chirp sweep', seconds: 2, gen: sweep }
  ];

  // render(id, fs) -> {left: Float32Array, right: Float32Array, name}
  function render(id, fs) {
    for (var i = 0; i < LOOPS.length; i++) {
      if (LOOPS[i].id === id) {
        var out = LOOPS[i].gen(fs);
        // overlapping drum hits sum past full scale; head-room guard only —
        // loops already under 0.9 peak pass through untouched
        var pk = 0;
        for (var j = 0; j < out.left.length; j++) {
          pk = Math.max(pk, Math.abs(out.left[j]), Math.abs(out.right[j]));
        }
        if (pk > 0.9) {
          var g = 0.9 / pk;
          for (j = 0; j < out.left.length; j++) { out.left[j] *= g; out.right[j] *= g; }
        }
        out.name = LOOPS[i].name;
        return out;
      }
    }
    throw new Error('unknown loop "' + id + '"');
  }

  var mod = { LOOPS: LOOPS, render: render, PRNG: PRNG };
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.RDLoops = mod;
})(typeof self !== 'undefined' ? self : globalThis);