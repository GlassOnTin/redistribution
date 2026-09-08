// test-follow.js — the Follow gate. Follow retunes the input into the
// engine's held chord. Two modes. 'partial': every prominent partial snaps
// to the nearest chord tone, harmonic stacks moving together (per-note
// harmonizer). 'frame': the dominant partial sets one interval and the
// whole frame is transposed by it. Replace semantics: an out-of-chord
// partial's bins are scaled by (1-g) and the moved copy written at gain g —
// at follow=1 a clean move, below it the original and pulled pitch sound
// together. In-chord partials (n=0) are skipped and stay sample-exact.
//
// Measured behaviour the pins rest on (probe + debug-instrumentation runs,
// 48k, lock 0 unless noted):
//  - the detector reads the FOLLOWED spectrum, so a fired pull reinforces
//    the held chord (A5 copies keep Am alive); a strong out-of-chord STACK
//    usually adopts its own chord instead (n=0, untouched). The pull is
//    therefore pinned at chord transitions and tone onsets, where the
//    vote still holds a chord that does not contain the dominant — about
//    5 frames (~0.1 s) at 48k.
//  - partial mode moves harmonic stacks coherently: a G5 tone with a 3rd
//    harmonic moves both +2 semitones in the same frames (debug log shows
//    one window list, r=1.122, for peak 33 and its 3f partner 100).
//  - a moved copy arrives well below full amplitude: the per-bin round()
//    placement of a radially-rescaled window leaves spectral holes, and
//    OLA sums against whatever the destination already carries. Measured
//    retention ~50% for a +2 semitone move of a solo tone (0.25 in ->
//    ~0.12 out at the destination); a gather-based (interpolating) write
//    was measured far worse (0.01) and rejected. Frame mode is coarser
//    still (its bins each carry their own phase error, a scalar rotation
//    cannot fix) — named character, not pinned numerically.
//  - a partial within 2 bins of a stronger one merges and moves as one
//    (radius 2: a radius of 5 was measured eating a real semitone
//    neighbour, F#5's fundamental 3.5 bins from a stronger E5).
//  - harmonic grouping can misfire when an out-of-chord partial lands
//    near an integer multiple of an in-chord one (G6 sits 1.8 Hz from
//    3x C5 and joins C5's group) — named limitation, not pinned.
//  - the codec's own masking is part of the loop: a quiet out-of-chord
//    fundamental (0.06 over the pad) is DROPPED by mask=drop before
//    follow ever sees it; only tones strong enough to survive masking
//    are retuned.
'use strict';
var t = require('./harness.js');
var P = require('../pipeline.js');
var RD = require('../params.js');
var RDLoops = require('../loops.js');

var FS = 48000, CHUNK = 128;
var midi = function (n) { return 440 * Math.pow(2, (n - 69) / 12); };

// Am pad = A4 C5 E5 (midi 69,72,76); tones = [[f, amp], ...] starting at
// t=pre (5 ms ramp). padAlways keeps the pad under the tones (chord stays
// established); otherwise the pad stops at pre (transition).
function render(follow, tones, pre, total, padAlways, mode) {
  var N = Math.floor(total * FS);
  var x = new Float32Array(N);
  for (var i = 0; i < N; i++) {
    var tt = i / FS;
    x[i] = (padAlways || tt < pre)
      ? 0.15 * (Math.sin(2 * Math.PI * midi(69) * tt) +
                Math.sin(2 * Math.PI * midi(72) * tt) +
                Math.sin(2 * Math.PI * midi(76) * tt))
      : 0;
    for (var tn = 0; tn < tones.length; tn++) {
      if (tt >= pre) {
        var env = Math.min(1, (tt - pre) / 0.005);
        x[i] += tones[tn][1] * env * Math.sin(2 * Math.PI * tones[tn][0] * tt);
      }
    }
  }
  var eng = P.createEngine(FS, { defaults: RD.DEFAULTS });
  eng.params.budget = 1; eng.params.frame = 'long';
  eng.params.lock = 0; eng.params.gravity = 0; eng.params.follow = follow;
  if (mode) eng.params.followMode = mode;
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

var G5 = 783.99;                        // out-of-chord for Am (+2 to A5)

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
  var r = render(0, [[493.88, 0.25]], 1.2, 2.4);
  var worst = 0;
  for (var i = 4096; i < r.x.length - 4096; i++) {
    var d = Math.abs(r.y[i] - r.x[i]);
    if (d > worst) worst = d;
  }
  t.ok(worst < 1e-7, 'untouched (worst ' + worst.toExponential(2) + ')');
});

t.test('modify path at budget 1 with follow ~0 stays transparent', function () {
  var r = render(0.001, [], 1.2, 2.4, true);
  var off = Math.min(r.em - 16384 - 8, r.x.length - 16384);
  var d440 = dftAt(r.y, off, midi(69));
  t.ok(Math.abs(d440 - 0.15) < 0.008,
    'pad tone amplitude held (' + d440.toFixed(3) + ' vs 0.15)');
});

t.test('partial mode, all-chord input: nothing moved in steady state', function () {
  // every peak is a chord tone (n=0) -> no windows, no bloom; the steady
  // output must match a follow~0 render. (The pad's stop transition is
  // excluded: decaying frames grow pseudo-peaks between the fading tones
  // and follow retunes those at gain g — measured 2 frames of divergence.)
  var r0 = render(0.001, [], 1.2, 2.4, true);
  var r9 = render(0.9, [], 1.2, 2.4, true);
  var worst = 0;
  for (var i = Math.floor(1.4 * FS); i < Math.floor(2.3 * FS); i++) {
    var d = Math.abs(r9.y[i] - r0.y[i]);
    if (d > worst) worst = d;
  }
  t.ok(worst < 1e-7, 'in-chord content untouched (worst ' +
    worst.toExponential(2) + ')');
});

t.test('partial mode pull is replace, both directions', function () {
  // Am pad stops, solo G5 enters: for ~5 frames the vote still holds Am
  // and follow pulls G5 (+2) toward A5. Replace semantics: the SOURCE bins
  // drop AND the destination rises (the old additive copy kept the source).
  var r0 = render(0.001, [[G5, 0.25]], 1.2, 2.8, false);
  var r9 = render(0.9, [[G5, 0.25]], 1.2, 2.8, false);
  var off = Math.floor(1.21 * FS);
  var copy = dftAt(r9.y, off, 880), base = dftAt(r0.y, off, 880);
  var orig = dftAt(r9.y, off, G5), orig0 = dftAt(r0.y, off, G5);
  t.ok(copy > 0.03, 'copy present near A5 (' + copy.toFixed(3) + ', inert ' +
    base.toFixed(3) + ')');
  t.ok(base < 0.005, 'inert baseline clean (' + base.toFixed(4) + ')');
  t.ok(orig < orig0 * 0.85,
    'source G5 dropped while pulled (' + orig.toFixed(3) + ' vs inert ' +
    orig0.toFixed(3) + ')');
});

t.test('partial mode moves a harmonic stack coherently', function () {
  // G5 + 3rd harmonic over the pad: both partials carry n=+2 in the same
  // frames (3f joins the fundamental's group) and land at k*f0*r together
  var tones = [[G5, 0.25], [G5 * 3, 0.08]];
  var r0 = render(0.001, tones, 1.2, 2.8, false);
  var r9 = render(0.9, tones, 1.2, 2.8, false);
  var off = Math.floor(1.21 * FS);
  var c1 = dftAt(r9.y, off, 880), b1 = dftAt(r0.y, off, 880);
  var c3 = dftAt(r9.y, off, 2640), b3 = dftAt(r0.y, off, 2640);
  var s1 = dftAt(r9.y, off, G5), s3 = dftAt(r9.y, off, 2352);
  t.ok(c1 > 0.03, 'fundamental copy at A5 (' + c1.toFixed(3) + ', inert ' +
    b1.toFixed(3) + ')');
  t.ok(c3 > 0.01, '3rd harmonic copy at 3*A5 (' + c3.toFixed(3) + ', inert ' +
    b3.toFixed(3) + ')');
  t.ok(s1 < 0.2, 'source fundamental dropped (' + s1.toFixed(3) + ' from 0.25)');
  t.ok(s3 < 0.06, 'source 3rd harmonic dropped (' + s3.toFixed(3) + ' from 0.08)');
});

t.test('partial mode, in-chord tone stays while out-of-chord pulls', function () {
  // F#5 (0.25, survives masking) over the pad: it pulls -2 to E5 while the
  // pad's A4/C5 stay sample-exact; the copy lands inside E5's own bin and
  // must not gut it
  var r0 = render(0.001, [[739.99, 0.25]], 0.4, 2.4, true);
  var r9 = render(0.9, [[739.99, 0.25]], 0.4, 2.4, true);
  var off = Math.min(r9.em - 16384 - 8, r9.x.length - 16384);
  var src = dftAt(r9.y, off, 739.99), src0 = dftAt(r0.y, off, 739.99);
  var e5 = dftAt(r9.y, off, 659.26);
  t.ok(src < src0 * 0.2,
    'F#5 source dropped (' + src.toFixed(3) + ' from ' + src0.toFixed(3) + ')');
  t.ok(e5 > 0.14, 'E5 bin holds under the landing copy (' + e5.toFixed(3) + ')');
  var a4 = dftAt(r9.y, off, midi(69)), c5 = dftAt(r9.y, off, midi(72));
  t.ok(Math.abs(a4 - 0.15) < 0.01 && Math.abs(c5 - 0.15) < 0.01,
    'in-chord A4/C5 untouched (' + a4.toFixed(3) + ', ' + c5.toFixed(3) + ')');
});

t.test('partial mode bloom on a moved dominant', function () {
  // pure G5 (no harmonics of its own) pulled to A5: the bloom redraws it at
  // 2*A5 and 3*A5 — weak by the same placement loss as the copy itself
  var r0 = render(0.001, [[G5, 0.25]], 0.5, 2.6, true);
  var r9 = render(0.9, [[G5, 0.25]], 0.5, 2.6, true);
  var off = Math.min(r9.em - 16384 - 8, r9.x.length - 16384);
  var b2 = dftAt(r9.y, off, 1760), b3 = dftAt(r9.y, off, 2640);
  t.ok(b2 > 0.002, '2x bloom present (' + b2.toFixed(4) + ', inert ' +
    dftAt(r0.y, off, 1760).toFixed(4) + ')');
  t.ok(b3 > 0.002, '3x bloom present (' + b3.toFixed(4) + ', inert ' +
    dftAt(r0.y, off, 2640).toFixed(4) + ')');
});

t.test('frame mode transposes the whole frame at a tone onset', function () {
  // G5 onset over a steady Am pad: while the vote still holds Am, the
  // dominant sets +2 and EVERYTHING moves — the pad's A4 drops out of 440
  // and reappears at 494 (B4) along with the G5 -> 880 move
  var r0 = render(0.001, [[G5, 0.25]], 1.8, 2.8, true, 'frame');
  var r9 = render(0.9, [[G5, 0.25]], 1.8, 2.8, true, 'frame');
  var off = Math.floor(1.83 * FS);
  var a4 = dftAt(r9.y, off, 440), b4 = dftAt(r9.y, off, 494);
  var a40 = dftAt(r0.y, off, 440);
  var g5 = dftAt(r9.y, off, G5), a5 = dftAt(r9.y, off, 880);
  t.ok(a4 < a40 * 0.3, 'pad A4 dropped by the transpose (' + a4.toFixed(3) +
    ' from ' + a40.toFixed(3) + ')');
  t.ok(b4 > 0.008, 'pad reappears at B4 (' + b4.toFixed(3) + ')');
  t.ok(g5 < 0.1, 'G5 source dropped (' + g5.toFixed(3) + ' from 0.25)');
  t.ok(a5 > 0.01, 'G5 copy at A5 (' + a5.toFixed(3) + ', inert ' +
    dftAt(r0.y, off, 880).toFixed(3) + ')');
});

t.test('no chord: follow is inert', function () {
  // solo G5 from t=0 — no chord ever holds a quality, so follow must not
  // move anything
  var r = render(0.9, [[G5, 0.25]], 0, 1.6, false);
  t.ok(r.eng.chord.quality === null,
    'chord qualityless over a lone tone (' + r.eng.chord.root + '/' +
    r.eng.chord.quality + ')');
  var off = Math.min(r.em - 16384 - 8, r.x.length - 16384);
  var shifted = dftAt(r.y, off, 880);
  t.ok(shifted < 0.005, 'no copy without a chord (' + shifted.toFixed(4) + ')');
});

t.test('RMS stays bounded in both modes', function () {
  var rP = render(0.9, [[G5, 0.25], [G5 * 3, 0.08]], 0.5, 2.6, true);
  var offP = Math.min(rP.em - 16384 - 8, rP.x.length - 16384);
  var ratioP = rms(rP.y, offP, 16384) / rms(rP.x, offP, 16384);
  t.ok(ratioP < 1.15, 'partial mode out/in RMS = ' + ratioP.toFixed(3));
  var rF = render(0.9, [[G5, 0.25]], 1.8, 2.8, true, 'frame');
  var offF = Math.min(rF.em - 16384 - 8, rF.x.length - 16384);
  var ratioF = rms(rF.y, offF, 16384) / rms(rF.x, offF, 16384);
  t.ok(ratioF < 1.15, 'frame mode out/in RMS = ' + ratioF.toFixed(3));
});

t.test('arp loop end-to-end: finite, close in energy, audibly different',
  function () {
    var loop = RDLoops.render('arp', FS);
    var N = loop.left.length;
    function run(follow) {
      var eng = P.createEngine(FS, { defaults: RD.DEFAULTS });
      eng.params.budget = 1; eng.params.frame = 'long';
      eng.params.lock = 0; eng.params.gravity = 0; eng.params.follow = follow;
      var y = new Float32Array(N);
      var a = new Float32Array(CHUNK), oa = new Float32Array(CHUNK);
      var rin = new Float32Array(CHUNK), rout = new Float32Array(CHUNK);
      var pos = 0, em = 0, held = false;
      while (pos < N + 4096) {
        var n = Math.min(CHUNK, N + 4096 - pos);
        for (var j = 0; j < n; j++) a[j] = pos + j < N ? loop.left[pos + j] : 0;
        var give = eng.process(a, rin, oa, rout, n);
        for (j = 0; j < give; j++) if (em + j < N) y[em + j] = oa[j];
        if (eng.chord.quality) held = true;
        em += give; pos += n;
      }
      return { y: y, em: em, held: held };
    }
    var r0 = run(0.001), r9 = run(0.9);
    var finite = true;
    for (var i = 0; i < N; i++) if (!isFinite(r9.y[i])) finite = false;
    t.ok(finite, 'output finite');
    t.ok(r9.held, 'engine holds a chord over the arp');
    var off = Math.min(r9.em - 16384 - 8, N - 16384);
    var ratio = rms(r9.y, off, 16384) / rms(r0.y, off, 16384);
    t.ok(ratio > 0.8 && ratio < 1.25,
      'RMS near the inert render (' + ratio.toFixed(3) + ')');
    var worst = 0;
    for (i = 0; i < N; i++) {
      var d = Math.abs(r9.y[i] - r0.y[i]);
      if (d > worst) worst = d;
    }
    t.ok(worst > 0.5, 'output differs from inert (worst ' + worst.toFixed(3) + ')');
  });

t.test('same seed renders identically', function () {
  var a = render(0.9, [[G5, 0.25], [G5 * 3, 0.08]], 1.2, 2.0, false);
  var b = render(0.9, [[G5, 0.25], [G5 * 3, 0.08]], 1.2, 2.0, false);
  var worst = 0;
  for (var i = 0; i < a.y.length; i++) {
    var d = Math.abs(a.y[i] - b.y[i]);
    if (d > worst) worst = d;
  }
  t.ok(worst === 0, 'deterministic (worst ' + worst.toExponential(2) + ')');
});

console.log(t.pass + '/' + (t.pass + t.fail) + ' tests pass, ' + t.checks + ' checks');
process.exit(t.fail > 0 ? 1 : 0);