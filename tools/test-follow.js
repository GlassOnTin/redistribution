// test-follow.js — the Follow gate. Follow copies the frame's loudest
// partial ADDITIVELY onto the nearest tone of the engine's held chord
// (the original stays), rescaling the band's bins radially about the
// sub-bin peak, and blooms two harmonics above the moved partial.
//
// Measured behaviour the pins rest on (probe-follow measurements, 48k):
//  - a strong out-of-chord tone usually JOINS the detected chord (the
//    detector is magnitude-driven), so the common case is n = 0: bloom
//    only, original intact. F#5 over an Am pad reads D7 (F# is its third)
//    and blooms at 1480/2220 Hz.
//  - n != 0 shows up at chord transitions: with Am held and the pad
//    stopping, a solo G5 is pulled +2 semitones toward A for the ~5 frames
//    before the vote adopts a chord containing G. The stream DFT shows the
//    copy at ~880-890 Hz (bin-quantised, ±11.7 Hz placement) above the
//    inert baseline.
//  - copies land on the 23.4 Hz frame grid; phase is inherited from the
//    source, so a copy landing on a bin that already carries a tone can
//    dip it (complex cancellation) — that wobble is named character.
'use strict';
var t = require('./harness.js');
var P = require('../pipeline.js');
var RD = require('../params.js');

var FS = 48000, CHUNK = 128;
var midi = function (n) { return 440 * Math.pow(2, (n - 69) / 12); };

// Am pad = A4 C5 E5 (midi 69,72,76); optional test tone from t=pre.
// padAlways keeps the pad under the tone (chord stays established);
// otherwise the pad stops at pre and the tone plays solo (transition)
function render(follow, toneHz, toneAmp, pre, total, padAlways) {
  var N = Math.floor(total * FS);
  var x = new Float32Array(N);
  for (var i = 0; i < N; i++) {
    var tt = i / FS;
    x[i] = (padAlways || tt < pre)
      ? 0.15 * (Math.sin(2 * Math.PI * midi(69) * tt) +
                Math.sin(2 * Math.PI * midi(72) * tt) +
                Math.sin(2 * Math.PI * midi(76) * tt))
      : 0;
    if (toneHz && tt >= pre)
      x[i] += toneAmp * Math.sin(2 * Math.PI * toneHz * tt);
  }
  var eng = P.createEngine(FS, { defaults: RD.DEFAULTS });
  eng.params.budget = 1; eng.params.frame = 'long';
  eng.params.lock = 0; eng.params.gravity = 0; eng.params.follow = follow;
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
  return { x: x, y: y, em: em, eng: eng };
}

// unwindowed DFT amplitude at f over 16384 samples from off
function dftAt(y, off, f) {
  var re = 0, im = 0, w = 2 * Math.PI * f / FS;
  for (var k = 0; k < 16384; k++) {
    var s = y[off + k]; re += s * Math.cos(w * k); im -= s * Math.sin(w * k);
  }
  return 2 * Math.sqrt(re * re + im * im) / 16384;
}

function rms(y, off, n) {
  var s = 0;
  for (var i = 0; i < n; i++) s += y[off + i] * y[off + i];
  return Math.sqrt(s / n);
}

t.test('followInterval pins the semitone math', function () {
  t.ok(P.followInterval(739.99, 9, 'minor') === -2,
    'F#5 to Am = -2 (to E5), got ' + P.followInterval(739.99, 9, 'minor'));
  t.ok(P.followInterval(739.99, 2, 'dom7') === 0,
    'F#5 is the third of D7 (n=0), got ' + P.followInterval(739.99, 2, 'dom7'));
  t.ok(P.followInterval(783.99, 9, 'minor') === 2,
    'G5 to Am = +2 (to A5), got ' + P.followInterval(783.99, 9, 'minor'));
  t.ok(P.followInterval(783.99, 0, 'major') === 0,
    'G5 is the fifth of C major, got ' + P.followInterval(783.99, 0, 'major'));
  t.ok(P.followInterval(783.99, 0, null) === null, 'qualityless chord -> null');
  // an octave-mapped wrap: B5 (pc 11) to C major root 0 -> down to B? B is
  // not in C major; nearest is C (+1) — d=1
  t.ok(P.followInterval(987.77, 0, 'major') === 1,
    'B5 to C major = +1, got ' + P.followInterval(987.77, 0, 'major'));
});

t.test('follow=0 is the exact identity (bypass)', function () {
  var r = render(0, 493.88, 0.25, 1.2, 2.4);
  var worst = 0;
  for (var i = 4096; i < r.x.length - 4096; i++) {
    var d = Math.abs(r.y[i] - r.x[i]);
    if (d > worst) worst = d;
  }
  t.ok(worst < 1e-7, 'untouched (worst ' + worst.toExponential(2) + ')');
});

t.test('modify path at budget 1 with follow ~0 stays transparent', function () {
  var r = render(0.001, 739.99, 0.0, 1.2, 2.4, true);
  var off = Math.min(r.em - 16384 - 8, r.x.length - 16384);
  var d440 = dftAt(r.y, off, midi(69));
  t.ok(Math.abs(d440 - 0.15) < 0.008,
    'pad tone amplitude held (' + d440.toFixed(3) + ' vs 0.15)');
});

t.test('peak already a chord tone: original intact, bloom added', function () {
  // F#5 over Am: the detector hears D7 (F# is its third), so n=0 and only
  // the bloom fires — at 1480/2220 Hz
  var r0 = render(0.001, 739.99, 0.25, 1.2, 2.4, true);
  var r9 = render(0.9, 739.99, 0.25, 1.2, 2.4, true);
  var off = Math.min(r9.em - 16384 - 8, r9.x.length - 16384);
  var orig = dftAt(r9.y, off, 739.99);
  var bloom2 = dftAt(r9.y, off, 1480), bloom3 = dftAt(r9.y, off, 2220);
  var far = dftAt(r9.y, off, 500);
  t.ok(orig > 0.2, 'original partial intact (' + orig.toFixed(3) + ')');
  t.ok(bloom2 > 0.01, '2nd harmonic bloomed (' + bloom2.toFixed(3) + ', inert ' +
    dftAt(r0.y, off, 1480).toFixed(3) + ')');
  t.ok(bloom3 > 0.002, '3rd harmonic bloomed (' + bloom3.toFixed(3) + ', inert ' +
    dftAt(r0.y, off, 2220).toFixed(3) + ')');
  t.ok(far < 0.01, 'no spurious far partials at 500 Hz (' + far.toFixed(4) + ')');
});

t.test('transition pull: solo tone is dragged to the decaying chord', function () {
  // Am pad stops, solo G5 enters: for ~5 frames the held chord is still Am
  // and follow pulls G5 (+2) toward A5 — the copy lands near 880 Hz
  // (bin-quantised placement ±11.7 Hz)
  var r0 = render(0.001, 783.99, 0.25, 1.2, 2.6, false);
  var r9 = render(0.9, 783.99, 0.25, 1.2, 2.6, false);
  var off = Math.floor(1.22 * FS);
  var copy = dftAt(r9.y, off, 880), base = dftAt(r0.y, off, 880);
  var orig = dftAt(r9.y, off, 783.99);
  t.ok(copy > 0.015, 'copy present near A5 (' + copy.toFixed(3) + ', inert ' +
    base.toFixed(3) + ')');
  t.ok(base < 0.005, 'inert baseline clean (' + base.toFixed(4) + ')');
  t.ok(orig > 0.2, 'original G5 intact (' + orig.toFixed(3) + ')');
});

t.test('no chord: follow is inert', function () {
  // solo G5 from t=0 — no chord ever holds a quality, so follow must not
  // add anything
  var r = render(0.9, 783.99, 0.25, 0, 1.6, false);
  t.ok(r.eng.chord.quality === null,
    'chord qualityless over a lone tone (' + r.eng.chord.root + '/' +
    r.eng.chord.quality + ')');
  var off = Math.min(r.em - 16384 - 8, 1.6 * FS - 16384 | 0);
  var shifted = dftAt(r.y, off, 880);
  t.ok(shifted < 0.005, 'no copy without a chord (' + shifted.toFixed(4) + ')');
});

t.test('RMS growth stays bounded', function () {
  var r = render(0.9, 739.99, 0.25, 1.2, 2.4, true);
  var off = Math.min(r.em - 16384 - 8, r.x.length - 16384);
  var ratio = rms(r.y, off, 16384) / rms(r.x, off, 16384);
  // measured 1.02-1.05 on tonal material; the worst-case single-band
  // ceiling at follow=1 is +5.1 dB (phase-aligned copy) — far above what
  // real frames hit
  t.ok(ratio < 1.15, 'out/in RMS = ' + ratio.toFixed(3));
});

t.test('same seed renders identically', function () {
  var a = render(0.9, 739.99, 0.25, 1.2, 2.0, true);
  var b = render(0.9, 739.99, 0.25, 1.2, 2.0, true);
  var worst = 0;
  for (var i = 0; i < a.y.length; i++) {
    var d = Math.abs(a.y[i] - b.y[i]);
    if (d > worst) worst = d;
  }
  t.ok(worst === 0, 'deterministic (worst ' + worst.toExponential(2) + ')');
});

console.log(t.pass + '/' + (t.pass + t.fail) + ' tests pass, ' + t.checks + ' checks');
process.exit(t.fail > 0 ? 1 : 0);