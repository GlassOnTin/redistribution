// test-hunt.js — the Hunt gate. Hunt has two independent effects and both are
// pinned here: the allocation smoothing time constant (1 frame at hunt 0, 64
// frames at hunt 1, so bit assignments lag material changes) and the
// remainder dither (spare bits go to a noise-perturbed band choice instead of
// a fixed fractional order — the audible allocator churn). The dither test
// relies on opts.rng being injectable: two seeds must agree at hunt 0 and
// disagree at hunt 1.
'use strict';
var t = require('./harness.js');
var P = require('../pipeline.js');
var RD = require('../params.js');

var FS = 48000, CHUNK = 128;
var SILENCE_FRAMES = 20, TONE_FRAMES = 40;

// silence for 20 long frames, then dense noise; snapshot per-long-frame bits
function run(hunt, seed) {
  var eng = P.createEngine(FS, {
    defaults: RD.DEFAULTS,
    rng: seed !== undefined ? P.mulberry32(seed) : undefined
  });
  var d = eng.params;
  // level -40: the allocation scale is now dBFS-anchored (+96 offset), so
  // -40 restores the effective level this fixture was calibrated at
  d.budget = 0.5; d.gravity = 0; d.hunt = hunt; d.lock = 0; d.memory = 30; d.level = -40; d.mask = 'drop';
  var bits = [], snaps = [];
  eng.onBins = function (mL, mR, K, short) {
    if (short) return;
    var s = 0;
    for (var j = 0; j < eng.bits.length; j++) s += eng.bits[j];
    bits.push(s);
    snaps.push(Array.from(eng.bits));
  };
  var a = new Float32Array(CHUNK), oa = new Float32Array(CHUNK);
  var rin = new Float32Array(CHUNK), rout = new Float32Array(CHUNK);
  var r = P.mulberry32(9);
  var nTotal = (SILENCE_FRAMES + TONE_FRAMES) * 1024;
  var pos = 0;
  while (pos < nTotal + 4096) {
    var n = Math.min(CHUNK, nTotal + 4096 - pos);
    for (var i = 0; i < n; i++) {
      var tt = pos + i;
      a[i] = tt < SILENCE_FRAMES * 1024 ? 0 : 0.4 * (r() * 2 - 1);
    }
    eng.process(a, rin, oa, rout, n);
    pos += n;
  }
  return { bits: bits, snaps: snaps };
}

t.test('hunt 0 re-allocates within frames; hunt 1 lags by tens of frames', function () {
  var ONSET = SILENCE_FRAMES; // first tone long-frame index in the bits array
  var f0 = run(0), f1 = run(1);
  // measured hunt 0: 0, 35, 51, 57, ... 61 steady
  var steady0 = f0.bits[f0.bits.length - 4];
  t.ok(f0.bits[ONSET + 1] > steady0 * 0.5,
    'hunt 0 near steady state 1 frame after onset (' + f0.bits[ONSET + 1] + ' vs ' + steady0 + ')');
  t.ok(f0.bits[ONSET + 4] >= steady0 * 0.9,
    'hunt 0 converged by frame 4 (' + f0.bits[ONSET + 4] + ')');
  // measured hunt 1: 0,1,2,3,... ~1 bit per frame, steady 61 far later
  t.ok(f1.bits[ONSET + 10] < steady0 * 0.35,
    'hunt 1 still far from steady at frame +10 (' + f1.bits[ONSET + 10] + ' vs ' + steady0 + ')');
  t.ok(f1.bits[ONSET + 1] <= f1.bits[ONSET + 10] && f1.bits[ONSET + 10] < f1.bits[ONSET + 30],
    'hunt 1 rises monotonically toward steady state');
});

t.test('remainder dither: hunt 0 is seed-independent, hunt 1 is not', function () {
  var a0 = run(0, 1), b0 = run(0, 2), a1 = run(1, 1), b1 = run(1, 2);
  // a mid-convergence long frame with a non-empty remainder pool
  var pick = function (r) {
    for (var i = SILENCE_FRAMES + 2; i < r.snaps.length; i++) {
      var s = r.snaps[i], f = 0;
      for (var j = 0; j < s.length; j++) f += s[j];
      if (f > 20 && f < 70) return s;
    }
    return null;
  };
  var s0a = pick(a0), s0b = pick(b0), s1a = pick(a1), s1b = pick(b1);
  t.ok(s0a && s1a, 'mid-convergence frames exist');
  var diffs = function (x, y) { var c = 0; for (var j = 0; j < x.length; j++) if (x[j] !== y[j]) c++; return c; };
  t.near(diffs(s0a, s0b), 0, 0.5, 'hunt 0 bit assignment independent of rng seed');
  // measured: 10 of 30 bands differ
  t.ok(diffs(s1a, s1b) >= 5, 'hunt 1 dithers the remainder across bands (diffs=' + diffs(s1a, s1b) + ')');
  var t0 = 0, t1 = 0;
  for (var j = 0; j < s1a.length; j++) { t0 += s1a[j]; t1 += s1b[j]; }
  t.near(t0, t1, 0.5, 'dither redistributes the same remainder pool (' + t0 + ' == ' + t1 + ')');
});

console.log(t.pass + '/' + (t.pass + t.fail) + ' tests pass, ' + t.checks + ' checks');
process.exit(t.fail > 0 ? 1 : 0);