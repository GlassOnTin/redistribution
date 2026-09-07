#!/usr/bin/env node
// bench-core.js — worst-case per-quantum cost of the engine, the synth bank,
// and the spectrogram STFT. The live deadline (from the plan): a 128-sample
// quantum at 48 kHz is 2.67 ms; the whole audio thread (engine + synth, both
// channels) should stay under ~4 ms on this class of machine so M2 has slack.
'use strict';
var RD = require('../params.js');
var P = require('../pipeline.js');
var S = require('../synth.js');

var FS = 48000, Q = 128, SECS = 3;
var N = SECS * FS;

function bench(name, fn) {
  // warm-up (JIT) then measure
  fn(0.2 * FS);
  var t0 = process.hrtime.bigint();
  fn(N);
  var t1 = process.hrtime.bigint();
  var per = Number(t1 - t0) / 1e6 / (N / Q);
  console.log(name + ': ' + per.toFixed(3) + ' ms per ' + Q + '-sample quantum' +
    ' (deadline 2.67 ms)');
  return per;
}

// engine, worst case: everything engaged, adaptive frame
function engineRun(n) {
  var eng = P.createEngine(FS, { defaults: RD.DEFAULTS });
  eng.params.budget = 0.5; eng.params.gravity = 0.9; eng.params.lock = 0.9;
  eng.params.intensity = 1; eng.params.frame = 'adaptive';
  eng.params.tiltHigh = 120; eng.params.tiltMid = -80;
  var a = new Float32Array(Q), oL = new Float32Array(Q), oR = new Float32Array(Q);
  // a busy signal: drums are transient-rich, the scheduler's worst case
  var loop = require('../loops.js').render('drums', FS);
  var pos = 0;
  for (var i = 0; i < n; i += Q) {
    for (var j = 0; j < Q; j++) a[j] = loop.left[(pos + j) % loop.left.length];
    pos += Q;
    eng.process(a, a, oL, oR, Q);
  }
}

// synth bank, worst case: 16 voices, harmonic mode (per-sample sin per partial)
function synthRun(n) {
  var s = S.Synth(FS, { waveform: 'harmonic' });
  for (var v = 0; v < 16; v++) s.noteOn(48 + v % 12, 0.8);
  var out = new Float32Array(Q);
  for (var i = 0; i < n; i += Q) s.render(out, Q);
}

var e = bench('engine  ', engineRun);
var s = bench('synth 16', synthRun);
var worst = e + s;
console.log('worst-case combined: ' + worst.toFixed(3) + ' ms per quantum' +
  (worst < 4 ? '  — under the 4 ms target' : '  — OVER the 4 ms target'));
process.exit(worst < 4 ? 0 : 1);