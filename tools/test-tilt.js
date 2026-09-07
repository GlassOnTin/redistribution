// test-tilt.js — the Tilt gate. Tilt is post-OLA (emission-time) DSB ring
// modulation over a Butterworth 3-way split (LP 200 Hz / HP 2 kHz / mid by
// complementary subtraction). Pins: sidebands at f±s with in-band tones
// getting clean DSB, group selectivity (a mid-group shift must leave a
// high-group tone in place), DSB symmetry, and tilt surviving the modify
// path (it runs whether or not isBypass takes the fast path).
//
// Documented character (not a bug, named in README): the complementary mid
// band is phase-distorted, so an out-of-group shift leaves an in-phase
// residual carrier — 0.56 of a 9 kHz tone survives unshifted with
// TiltHigh=±100 (hp has +32° at 9 kHz), 0.84 of a 60 Hz tone with TiltLow=30.
// In-group tones get the clean DSB shape (carrier < 0.12).
'use strict';
var t = require('./harness.js');
var P = require('../pipeline.js');
var RD = require('../params.js');

var FS = 48000, CHUNK = 128, PRIME = 20480, TONE = 24000;

// render a tone through the engine; silence priming optional
function run(tilt, freq, opts) {
  opts = opts || {};
  var eng = P.createEngine(FS, { defaults: RD.DEFAULTS });
  var d = eng.params;
  d.budget = opts.budget !== undefined ? opts.budget : 1;
  d.lock = 0; d.gravity = 0; d.intensity = 0; d.frame = 'long';
  d.tiltLow = tilt[0]; d.tiltMid = tilt[1]; d.tiltHigh = tilt[2];
  var N = PRIME + TONE;
  var x = new Float32Array(N);
  var from = opts.prime ? PRIME : 0;
  for (var i = from; i < N; i++) x[i] = Math.sin(2 * Math.PI * freq * i / FS);
  var y = new Float32Array(N);
  var a = new Float32Array(CHUNK), oa = new Float32Array(CHUNK);
  var rin = new Float32Array(CHUNK), rout = new Float32Array(CHUNK);
  var pos = 0, em = 0;
  while (pos < N + 4096) {
    var n = Math.min(CHUNK, N + 4096 - pos);
    for (var j = 0; j < n; j++) a[j] = pos + j < N ? x[pos + j] : 0;
    var give = eng.process(a, rin, oa, rout, n);
    for (j = 0; j < give; j++) if (em + j < N) y[em + j] = oa[j];
    em += give; pos += n;
  }
  // plain DFT over a mid-run window (16384 = 3072 periods at 9 kHz, exact)
  var O = from + 12000 > N - 16384 ? from + 4000 : from + 12000;
  return function (f) {
    var re = 0, im = 0, w = 2 * Math.PI * f / FS;
    for (var k = 0; k < 16384; k++) {
      var s = y[O + k]; re += s * Math.cos(w * k); im -= s * Math.sin(w * k);
    }
    return 2 * Math.sqrt(re * re + im * im) / 16384;
  };
}

t.test('tiltHigh +100 splits a 9 kHz tone to 8900/9100 (DSB)', function () {
  var d = run([0, 0, 100], 9000);
  // measured: 0.4968 / 0.5569 / 0.4993
  t.ok(d(8900) > 0.4, 'lower sideband at 8900 (' + d(8900).toFixed(3) + ')');
  t.ok(d(9100) > 0.4, 'upper sideband at 9100 (' + d(9100).toFixed(3) + ')');
  t.ok(d(9000) > 0.4 && d(9000) < 0.75,
    'residual carrier in the documented Butterworth-leak range (' + d(9000).toFixed(3) + ')');
  t.ok(d(8800) < 0.06 && d(9200) < 0.06,
    'no spurious far sidebands at 8800/9200 (' + d(8800).toFixed(3) + '/' + d(9200).toFixed(3) + ')');
});

t.test('DSB is symmetric: -100 lands the same sidebands', function () {
  var dp = run([0, 0, 100], 9000), dm = run([0, 0, -100], 9000);
  // measured: identical to 4 decimals (0.4968/0.5569/0.4993 both ways)
  t.ok(Math.abs(dp(8900) - dm(8900)) < 0.05,
    'lower sideband symmetric (' + dp(8900).toFixed(3) + ' vs ' + dm(8900).toFixed(3) + ')');
  t.ok(Math.abs(dp(9000) - dm(9000)) < 0.05,
    'carrier symmetric (' + dp(9000).toFixed(3) + ' vs ' + dm(9000).toFixed(3) + ')');
});

t.test('tiltMid on an in-band tone gives clean DSB', function () {
  var d = run([0, 100, 0], 1000);
  // measured: 0.4962 / 0.0571 / 0.4965
  t.ok(d(900) > 0.4, 'sideband at 900 (' + d(900).toFixed(3) + ')');
  t.ok(d(1100) > 0.4, 'sideband at 1100 (' + d(1100).toFixed(3) + ')');
  t.ok(d(1000) < 0.12, 'carrier suppressed in-group (' + d(1000).toFixed(3) + ')');
});

t.test('tiltLow +30 splits a 60 Hz tone to 30/90', function () {
  var d = run([30, 0, 0], 60);
  // measured: 0.5011 / 0.843 / 0.4777
  t.ok(d(30) > 0.35, 'sideband at 30 Hz (' + d(30).toFixed(3) + ')');
  t.ok(d(90) > 0.35, 'sideband at 90 Hz (' + d(90).toFixed(3) + ')');
  t.ok(d(60) < 0.95, 'residual carrier in the documented range (' + d(60).toFixed(3) + ')');
});

t.test('group selectivity: mid tilt leaves a 9 kHz tone in place', function () {
  var d = run([0, 100, 0], 9000);
  // measured: 0.2805 / 0.9987 / 0.2758 — hp passes, the phase-distorted mid
  // leak carries 0.28 to each sideband
  t.ok(d(9000) > 0.9, 'tone stays at 9000 (' + d(9000).toFixed(3) + ')');
  t.ok(d(8900) < 0.35 && d(9100) < 0.35,
    'only the mid leak spills (' + d(8900).toFixed(3) + '/' + d(9100).toFixed(3) + ')');
});

t.test('tilt survives the modify path (independent of isBypass)', function () {
  var d = run([0, 0, 100], 9000, { budget: 0.998, level: 20, prime: true });
  // measured: 0.4995 / 0.5564 / 0.4954 — quantize noise does not mask the tone
  t.ok(d(8900) > 0.35, 'sideband survives allocation+quantize (' + d(8900).toFixed(3) + ')');
  t.ok(d(9100) > 0.35, 'sideband survives allocation+quantize (' + d(9100).toFixed(3) + ')');
});

t.test('neutral tilt is the exact identity', function () {
  var eng = P.createEngine(FS, { defaults: RD.DEFAULTS });
  var d = eng.params;
  d.budget = 1; d.lock = 0; d.frame = 'long';
  var N = 12000, x = new Float32Array(N);
  for (var i = 0; i < N; i++) x[i] = 0.4 * Math.sin(2 * Math.PI * 9000 * i / FS);
  var y = new Float32Array(N);
  var a = new Float32Array(CHUNK), oa = new Float32Array(CHUNK);
  var rin = new Float32Array(CHUNK), rout = new Float32Array(CHUNK);
  var pos = 0, em = 0;
  while (pos < N + 4096) {
    var n = Math.min(CHUNK, N + 4096 - pos);
    for (var j = 0; j < n; j++) a[j] = pos + j < N ? x[pos + j] : 0;
    var give = eng.process(a, rin, oa, rout, n);
    for (j = 0; j < give; j++) if (em + j < N) y[em + j] = oa[j];
    em += give; pos += n;
  }
  var w = 0;
  for (i = 2048; i < N - 4096; i++) { var dd = Math.abs(y[i] - x[i]); if (dd > w) w = dd; }
  t.ok(w < 1e-7, 'neutral tilt untouched (worst ' + w.toExponential(2) + ')');
});

console.log(t.pass + '/' + (t.pass + t.fail) + ' tests pass, ' + t.checks + ' checks');
process.exit(t.fail > 0 ? 1 : 0);