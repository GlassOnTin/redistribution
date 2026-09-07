// synth.js — 16-voice band-limited wavetable voice bank. Dual-loaded (node
// require / importScripts / browser script tag); no DOM, no Web Audio, no
// unseeded Math.random.
//
// Named simplification (VISION): this is a subtractive voice bank, not a
// spectral/additive synth. Per voice: one mipmap wavetable oscillator
// (2048-entry, one table per octave, linear interpolation, band-limited saw)
// -> 2-pole lowpass at min(12 kHz, 8*f) -> AD envelope (3 ms attack, 60 ms
// release). VoiceWaveform=harmonic switches to 6 sine partials with
// a_p = p^-0.8 and slight inharmonicity f_p = f·p·(1 + 4e-4·p²), capped at
// 8 voices.
//
// The engine's budget coupling lives in params.js (budgetScale); the voice
// count is relayed by the host (app.js in the browser, render.js offline).
(function (root) {
  'use strict';

  var MAX_VOICES = 16;
  var TABLE = 2048;
  var HARMONIC_CAP = 8;

  // ---- band-limited saw wavetables, one per octave (f * 2^k for k = 0..10) ----
  // Table k holds a saw whose harmonics stop just under fs/(2 * 2^k) when the
  // oscillator plays the table's centre frequency.
  function sawTables() {
    var tables = [];
    for (var k = 0; k <= 10; k++) {
      var f0 = 27.5 * Math.pow(2, k);           // table centre: A0 * 2^k
      var nharm = Math.max(1, Math.floor(12000 / f0 / 2)); // cap by ~12 kHz
      var tab = new Float32Array(TABLE);
      for (var p = 1; p <= nharm; p++) {
        var a = 1 / p;
        var w = 2 * Math.PI * p / TABLE;
        for (var i = 0; i < TABLE; i++) tab[i] += a * Math.sin(w * i + (p & 1 ? 0 : Math.PI));
      }
      // normalise so peak amplitude ~1
      var mx = 0;
      for (i = 0; i < TABLE; i++) if (Math.abs(tab[i]) > mx) mx = Math.abs(tab[i]);
      if (mx > 0) for (i = 0; i < TABLE; i++) tab[i] /= mx;
      tables.push(tab);
    }
    return tables;
  }
  var TABLES = sawTables();

  function sawSample(phase, freq, fs) {
    // pick the table whose harmonics stay under Nyquist at this freq
    var k = Math.round(Math.log2(freq / 27.5));
    if (k < 0) k = 0; if (k > 10) k = 10;
    var tab = TABLES[k];
    var p = phase - Math.floor(phase);
    var i0 = p * TABLE, i1 = Math.floor(i0) % TABLE, frac = i0 - Math.floor(i0);
    var i2 = (i1 + 1) % TABLE;
    return tab[i1] + (tab[i2] - tab[i1]) * frac;
  }

  // ---- voices ----
  function mkVoice() {
    return { active: false, note: -1, freq: 440, phase: 0, t: 0, gate: false,
      env: 0, lp: [0, 0, 0, 0, 0], lpB: null, vel: 0.8 };
  }

  function Synth(fs, opts) {
    opts = opts || {};
    var fsr = fs || 48000;
    var waveform = opts.waveform || 'saw';
    var voices = [];
    for (var i = 0; i < MAX_VOICES; i++) voices.push(mkVoice());
    var order = [];           // note-on order for oldest-first stealing
    var b2 = Math.PI * 2;

    // 2-pole lowpass coefficients (state-variable style biquad, RBJ LP)
    function lpCoef(freq) {
      var f = Math.min(12000, 8 * freq);
      if (f >= fsr * 0.45) f = fsr * 0.45;   // keep the filter realisable
      var w0 = b2 * f / fsr, cw = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2);
      var a0 = 1 + al;
      return [(1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0, -2 * cw / a0, (1 - al) / a0];
    }

    function noteOn(note, vel) {
      // steal the oldest active voice if all are busy
      var v = null, oldest = null, ot = Infinity;
      for (var i = 0; i < voices.length; i++) {
        if (!voices[i].active) { v = voices[i]; break; }
        if (voices[i].t < ot) { ot = voices[i].t; oldest = voices[i]; }
      }
      if (!v && oldest) v = oldest;
      v.active = true; v.note = note; v.freq = 440 * Math.pow(2, (note - 69) / 12);
      v.gate = true; v.env = 0; v.t = 0; v.vel = vel === undefined ? 0.8 : vel;
      v.lpB = lpCoef(v.freq);
      return v;
    }

    function noteOff(note) {
      for (var i = 0; i < voices.length; i++) {
        if (voices[i].active && voices[i].note === note && voices[i].gate) voices[i].gate = false;
      }
    }

    function allOff() {
      for (var i = 0; i < voices.length; i++) voices[i].gate = false;
    }

    function activeCount() {
      var c = 0;
      for (var i = 0; i < voices.length; i++) if (voices[i].active) c++;
      return c;
    }

    // advance n samples; out gets the summed mono synth output
    function render(out, n) {
      for (var i = 0; i < n; i++) out[i] = 0;
      if (waveform === 'harmonic') renderHarmonic(out, n);
      else renderSaw(out, n);
      // idle voices retire after their release tail
      for (i = 0; i < voices.length; i++) {
        if (voices[i].active && !voices[i].gate && voices[i].env < 1e-4) voices[i].active = false;
      }
    }

    function renderSaw(out, n) {
      for (var vi = 0; vi < voices.length; vi++) {
        var v = voices[vi];
        if (!v.active) continue;
        var inc = v.freq / fsr;
        var c = v.lpB, s = v.lp;
        var attack = 0.003 * fsr, release = 0.060 * fsr;
        for (var i = 0; i < n; i++) {
          var y = sawSample(v.phase, v.freq, fsr);
          v.phase += inc;
          if (v.env < 1) {
            if (v.gate) v.env = Math.min(1, v.env + 1 / attack);
            else v.env -= 1 / release;
          } else if (!v.gate) v.env -= 1 / release;
          if (v.env < 0) { v.env = 0; }
          // 2-pole LP (direct form I biquad over v.lp[0..3], s[4] spare)
          var f = c[0] * y + c[1] * s[0] + c[2] * s[1] - c[3] * s[2] - c[4] * s[3];
          s[1] = s[0]; s[0] = y; s[3] = s[2]; s[2] = f;
          out[i] += f * v.env * v.vel;
        }
        v.t += n;
      }
    }

    // harmonic mode: 6 sine partials, a_p = p^-0.8, f_p = f·p·(1+4e-4·p²)
    function renderHarmonic(out, n) {
      for (var vi = 0; vi < voices.length; vi++) {
        var v = voices[vi];
        if (!v.active) continue;
        var ph = [], inc = [];
        for (var p = 1; p <= 6; p++) { ph.push(v.phase * p); inc.push(v.freq * p * (1 + 4e-4 * p * p) / fsr); }
        var c = v.lpB, s = v.lp;
        var attack = 0.003 * fsr, release = 0.060 * fsr;
        for (var i = 0; i < n; i++) {
          var y = 0;
          for (p = 1; p <= 6; p++) {
            y += Math.pow(p, -0.8) * Math.sin(b2 * ph[p - 1]);
            ph[p - 1] += inc[p - 1];
            if (ph[p - 1] > 1) ph[p - 1] -= Math.floor(ph[p - 1]);
          }
          if (v.env < 1) {
            if (v.gate) v.env = Math.min(1, v.env + 1 / attack);
            else v.env -= 1 / release;
          } else if (!v.gate) v.env -= 1 / release;
          if (v.env < 0) v.env = 0;
          var f = c[0] * y + c[1] * s[0] + c[2] * s[1] - c[3] * s[2] - c[4] * s[3];
          s[1] = s[0]; s[0] = y; s[3] = s[2]; s[2] = f;
          out[i] += f * v.env * v.vel;
        }
        v.t += n;
      }
    }

    return {
      render: render, noteOn: noteOn, noteOff: noteOff, allOff: allOff,
      activeCount: activeCount, voices: voices, waveform: waveform
    };
  }

  var mod = { Synth: Synth, MAX_VOICES: MAX_VOICES, TABLE: TABLE };
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.RDSynth = mod;
})(typeof self !== 'undefined' ? self : globalThis);