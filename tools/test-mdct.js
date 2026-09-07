// test-mdct.js — the decision gate. Pins the TDAC window family and the
// band builder before anything else is trusted.
'use strict';
var t = require('./harness.js');
var P = require('../pipeline.js');

var FS = 48000;

// w_a^2[offA + n] + w_b^2[offB + n] = 1 over the pair's overlap region.
// Offsets come from the scheduler: LONG at s, START at s+1024, first SHORT at
// s+2048 (i.e. START+1024), STOP 256 after the last SHORT, next LONG at STOP+1024.
function pairIdentity(wa, wb, offA, offB, len, name) {
  for (var n = 0; n < len; n++) {
    var s = wa[offA + n] * wa[offA + n] + wb[offB + n] * wb[offB + n];
    t.near(s, 1, 1e-12, name + ' TDAC at n=' + n);
  }
}

var LONG = P.sineWindow(2048), SHORT = P.sineWindow(512);
var START = P.startWindow(), STOP = P.stopWindow();

t.test('TDAC identity: LONG/LONG', function () {
  pairIdentity(LONG, LONG, 0, 1024, 1024, 'long/long');
});
t.test('TDAC identity: LONG/START', function () {
  pairIdentity(LONG, START, 1024, 0, 1024, 'long/start');
});
t.test('TDAC identity: START/SHORT', function () {
  pairIdentity(START, SHORT, 1024, 0, 256, 'start/short');
});
t.test('TDAC identity: SHORT/SHORT', function () {
  pairIdentity(SHORT, SHORT, 0, 256, 256, 'short/short');
});
t.test('TDAC identity: SHORT/STOP', function () {
  pairIdentity(SHORT, STOP, 256, 0, 256, 'short/stop');
});
t.test('TDAC identity: STOP/LONG', function () {
  pairIdentity(STOP, LONG, 1024, 0, 1024, 'stop/long');
});
t.test('TDAC identity: all four window shapes reconstruct', function () {
  // every legal sequence of the state machine reconstructs a sine exactly
  var shapes = {
    long: P.sineWindow(2048), short: P.sineWindow(512),
    start: P.startWindow(), stop: P.stopWindow()
  };
  var seq = [
    { shape: 'long', w: 2048, hop: 1024 }, { shape: 'long', w: 2048, hop: 1024 },
    { shape: 'start', w: 2048, hop: 1024 },
    { shape: 'short', w: 512, hop: 256 }, { shape: 'short', w: 512, hop: 256 },
    { shape: 'short', w: 512, hop: 256 }, { shape: 'short', w: 512, hop: 256 },
    { shape: 'stop', w: 2048, hop: 1024 },
    { shape: 'long', w: 2048, hop: 1024 }, { shape: 'long', w: 2048, hop: 1024 }
  ];
  // OLA of w^2 * x over the sequence == x in the interior
  var N = 8192, x = new Float64Array(N), y = new Float64Array(N);
  for (var i = 0; i < N; i++) x[i] = Math.sin(2 * Math.PI * 1000 * i / FS);
  var pos = 0;
  for (var f = 0; f < seq.length; f++) {
    var s = seq[f], win = shapes[s.shape];
    for (var n = 0; n < s.w; n++) {
      var idx = pos + n;
      if (idx >= 0 && idx < N) y[idx] += win[n] * win[n] * x[idx];
    }
    pos += s.hop;
  }
  // interior only: away from the sequence edges
  var lo = 2048, hi = N - 2048;
  var worst = 0;
  for (var q = lo; q < hi; q++) {
    var d = Math.abs(y[q] - x[q]);
    if (d > worst) worst = d;
  }
  t.ok(worst < 1e-12, 'OLA sum == 1 through the full transition sequence (worst ' + worst.toExponential(2) + ')');
});

t.test('FFT round-trip', function () {
  var fft = P.makeFFT(2048);
  var re = new Float64Array(2048), im = new Float64Array(2048);
  for (var i = 0; i < 2048; i++) { re[i] = Math.sin(2 * Math.PI * 17 * i / 2048); }
  fft.forward(re, im);
  fft.inverse(re, im);
  var worst = 0;
  for (var j = 0; j < 2048; j++) {
    var d = Math.abs(re[j] - Math.sin(2 * Math.PI * 17 * j / 2048));
    if (d > worst) worst = d;
  }
  t.ok(worst < 1e-12, 'IFFT(FFT(x)) == x (worst ' + worst.toExponential(2) + ')');
});

t.test('Parseval: windowed block energy == 2 x sum of squared bin magnitudes', function () {
  var W = 2048, fft = P.makeFFT(W);
  var win = P.sineWindow(W);
  var re = new Float64Array(W), im = new Float64Array(W);
  var x = new Float64Array(W);
  for (var i = 0; i < W; i++) { x[i] = win[i] * Math.sin(2 * Math.PI * 43.7 * i / FS + 0.3); re[i] = x[i]; }
  fft.forward(re, im);
  var tSum = 0, fSum = 0;
  for (var j = 0; j < W; j++) tSum += x[j] * x[j];
  for (var k = 0; k < W; k++) fSum += re[k] * re[k] + im[k] * im[k];
  t.near(fSum / tSum, W, 0.001 * W, 'Parseval ratio (unnormalised forward DFT)');
});

t.test('bands: count in range, none empty, none over-wide, at 44.1k and 48k', function () {
  [44100, 48000].forEach(function (fs) {
    [2048, 512].forEach(function (W) {
      var K = W >> 1;
      var b = P.buildBands(fs, K, W);
      var B = P.bandCount(b);
      t.ok(B >= 24 && B <= 34, 'band count ' + B + ' in [24,34] (fs=' + fs + ' W=' + W + ')');
      for (var j = 0; j < B; j++) {
        var width = b.edge[j + 1] - b.edge[j];
        t.ok(width >= 1, 'band ' + j + ' non-empty');
        t.ok(width <= 100, 'band ' + j + ' width ' + width + ' <= 100');
        t.ok(b.edge[j] < b.edge[j + 1], 'edges monotone at j=' + j);
      }
      t.ok(b.edge[0] === 1 && b.edge[B] === K, 'bands span [1, K)');
    });
  });
});

t.test('fold weights: monotone rising for all three curves', function () {
  var b = P.buildBands(FS, 1024, 2048);
  ['bark', 'power', 'linear'].forEach(function (curve) {
    var r = P.foldWeights(b, FS, 1024, 2048, curve, 0.7);
    for (var j = 1; j < r.length; j++) {
      t.ok(r[j] >= r[j - 1] - 1e-9, curve + ' monotone at j=' + j);
    }
    t.near(r[0], 0, 0.05, curve + ' starts near 0');
    t.near(r[r.length - 1], 1, 0.05, curve + ' ends near 1');
  });
});

t.test('bark and ATH functions behave', function () {
  t.ok(P.barkOf(100) < P.barkOf(1000) && P.barkOf(1000) < P.barkOf(8000), 'bark rises');
  t.ok(P.ath(3000) < P.ath(80), 'hearing is most sensitive near 3 kHz');
  t.ok(P.ath(20000) > P.ath(3000), 'threshold rises at the top end');
});

console.log(t.pass + '/' + (t.pass + t.fail) + ' tests pass, ' + t.checks + ' checks');
process.exit(t.fail > 0 ? 1 : 0);