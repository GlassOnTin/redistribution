// test-chord.js — the chord-detection gate. detectChord builds a pitch-class
// histogram from spectral peaks (parabolic-interpolated, weighted by the
// codec's bit allocation) and template-matches major / minor / dom7 at 12
// roots. Pins: triads resolve, transposition moves the root, single tones
// and flat histograms fail the shape gate, the engine's held chord tracks
// the pad loop (Am F C G) by vote, and short blips do not displace it.
//
// Frame-level detection is deliberately allowed to wobble (overlapping low
// mainlobes at 23 Hz/bin): the engine votes over ~0.4 s, so the pins are on
// the voted readout, not on every frame.
'use strict';
var t = require('./harness.js');
var P = require('../pipeline.js');
var RD = require('../params.js');
var RDLoops = require('../loops.js');

var FS = 48000, W = 2048, K = W >> 1;

// synthetic spectrum: for each frequency, magnitude split across the two
// nearest bins in proportion to the fractional offset, so the weighted
// centroid lands on the true frequency (a single round()ed bin would sit up
// to half a bin — 12 Hz — off, a semitone at the low end of the grid)
function magsAt(freqs) {
  var m = new Float32Array(K);
  for (var i = 0; i < freqs.length; i++) {
    var kf = freqs[i] / (FS / W), k0 = Math.floor(kf), fr = kf - k0;
    if (k0 >= 1 && k0 < K) m[k0] += Math.sqrt(1 - fr);
    if (k0 + 1 >= 1 && k0 + 1 < K) m[k0 + 1] += Math.sqrt(fr);
  }
  return m;
}
var edge = P.buildBands(FS, K, W).edge;
var B = P.bandCount({ edge: edge });
var midi = function (n) { return 440 * Math.pow(2, (n - 69) / 12); };
// bits: 15 on the bands holding the tones, 0 elsewhere (max salience boost)
function bitsAt(freqs) {
  var b = new Int32Array(B);
  for (var i = 0; i < freqs.length; i++) {
    var kf = freqs[i] / (FS / W), k0 = Math.floor(kf);
    for (var j = 0; j < B; j++) if (k0 >= edge[j] && k0 < edge[j + 1]) b[j] = 15;
  }
  return b;
}

t.test('C major triad resolves with margin', function () {
  var f = [midi(72), midi(76), midi(79)];           // C5 E5 G5
  var det = P.detectChord(magsAt(f), bitsAt(f), edge, FS, W, B);
  t.ok(det.root === 0, 'root C (' + det.root + ')');
  t.ok(det.quality === 'major', 'quality major (' + det.quality + ')');
  t.ok(det.score > 0.8, 'template sum near 1.0 (' + det.score.toFixed(3) + ')');
  t.ok(det.margin > 0.25, 'clear of other roots (' + det.margin.toFixed(3) + ')');
});

t.test('transposition moves the root', function () {
  var f = [midi(75), midi(79), midi(82)];           // D#5 G5 A#5
  var det = P.detectChord(magsAt(f), bitsAt(f), edge, FS, W, B);
  t.ok(det.root === 3, 'root D# (' + det.root + ')');
  t.ok(det.quality === 'major', 'quality follows (' + det.quality + ')');
});

t.test('A minor and C7 shapes are distinguished', function () {
  var am = P.detectChord(magsAt([midi(69), midi(72), midi(76)]), bitsAt([midi(69), midi(72), midi(76)]), edge, FS, W, B);
  t.ok(am.root === 9 && am.quality === 'minor',
    'A minor (' + am.root + '/' + am.quality + ')');
  var c7 = P.detectChord(magsAt([midi(72), midi(76), midi(79), midi(82)]), bitsAt([midi(72), midi(76), midi(79), midi(82)]), edge, FS, W, B);
  t.ok(c7.root === 0 && c7.quality === 'dom7',
    'C dom7 (' + c7.root + '/' + c7.quality + ')');
});

t.test('a single tone fails the shape gate', function () {
  var det = P.detectChord(magsAt([midi(60), midi(72)]), bitsAt([midi(60), midi(72)]), edge, FS, W, B);
  t.ok(det.quality === null, 'octaves read qualityless (' + det.quality + ')');
  t.ok(det.margin < 0.12, 'margin collapses without a third (' + det.margin.toFixed(3) + ')');
});

t.test('a flat histogram fails', function () {
  var m = new Float32Array(K);
  for (var k = 1; k < K; k++) m[k] = 1;
  var det = P.detectChord(m, null, edge, FS, W, B);
  t.ok(det.quality === null, 'noise is not a chord');
  t.ok(det.margin < 0.05, 'margin ~0 on flat input (' + det.margin.toFixed(3) + ')');
});

// --- engine e2e: drive the engine, read the voted held chord ---
var CHUNK = 1024;
function drive(eng, data) {
  var N = data.length;
  var a = new Float32Array(CHUNK), oa = new Float32Array(CHUNK);
  var rin = new Float32Array(CHUNK), rout = new Float32Array(CHUNK);
  var pos = 0;
  while (pos < N + 8192) {
    var n = Math.min(CHUNK, N + 8192 - pos);
    for (var j = 0; j < n; j++) a[j] = pos + j < N ? data[pos + j] : 0;
    eng.process(a, rin, oa, rout, n);
    pos += n;
  }
}
// simple additive tones, midi note list per chord segment; secsPer is a
// number (all segments equal) or a per-segment array of seconds
function renderNotes(chords, secsPer) {
  var durs = chords.map(function (_, i) {
    return Array.isArray(secsPer) ? secsPer[i] : secsPer;
  });
  var len = Math.floor(durs.reduce(function (a, b) { return a + b; }, 0) * FS);
  var L = new Float32Array(len);
  var tAcc = 0;
  for (var ci = 0; ci < chords.length; ci++) {
    var t0 = Math.floor(tAcc * FS), n = Math.floor(durs[ci] * FS);
    tAcc += durs[ci];
    for (var vi = 0; vi < chords[ci].length; vi++) {
      var f = midi(chords[ci][vi]);
      var w = 2 * Math.PI * f / FS;
      for (var i = 0; i < n; i++)
        L[t0 + i] += Math.sin(w * (t0 + i)) * 0.2;
    }
  }
  return L;
}

t.test('held chord tracks the pad loop (Am F C G) by vote', function () {
  var loop = RDLoops.render('pad', FS);
  var mono = new Float32Array(loop.left.length);
  for (var i = 0; i < mono.length; i++)
    mono[i] = (loop.left[i] + loop.right[i]) * 0.5;
  var eng = P.createEngine(FS, { defaults: RD.DEFAULTS });
  eng.params.budget = 0.6; eng.params.frame = 'long';
  var timeline = [];
  eng.onFrame = function (info) {
    timeline.push({ t: info.start / FS, root: eng.chord.root,
      quality: eng.chord.quality, conf: eng.chord.confidence });
  };
  drive(eng, mono);
  // the vote window is 9 frames (~0.39 s); sample the settled tail of each
  // one-second chord. Pad chords (loops.js): Am F C G.
  var expect = [[9, 'minor'], [5, 'major'], [0, 'major'], [7, 'major']];
  for (var c = 0; c < 4; c++) {
    var win = timeline.filter(function (r) {
      return r.t >= c + 0.72 && r.t < c + 0.95;
    });
    t.ok(win.length > 0, 'frames sampled in chord ' + c + ' window');
    var got = win[win.length - 1];
    t.ok(got.root === expect[c][0],
      'chord ' + c + ' root ' + expect[c][0] + ' (got ' + got.root +
      ' conf ' + got.conf.toFixed(2) + ')');
  }
});

t.test('hysteresis: a 90 ms blip does not displace the held chord', function () {
  // voiced in the register the frame can resolve (A4 C5 E5 / C5 E5 G5):
  // single-partial chords below ~300 Hz sit inside one bin's mainlobe and
  // are physically undetectable at this transform size
  var blip = renderNotes([[69, 72, 76], [72, 76, 79], [69, 72, 76]], [0.5, 0.09, 0.5]);
  var eng = P.createEngine(FS, { defaults: RD.DEFAULTS });
  eng.params.budget = 1; eng.params.frame = 'long';
  var log = [];
  eng.onFrame = function (info) {
    log.push({ t: info.start / FS, root: eng.chord.root, quality: eng.chord.quality });
  };
  drive(eng, blip);
  var during = log.filter(function (r) { return r.t > 0.42 && r.t < 0.68; });
  t.ok(during.length > 0 && during.every(function (r) { return r.root === 9; }),
    'held chord rides out the blip (' +
    during.map(function (r) { return r.root; }).join(',') + ')');
  // and a sustained change does land (vote window ~0.39 s after the change)
  var after = log.filter(function (r) { return r.t > 0.85; });
  t.ok(after.length > 0 && after[after.length - 1].root === 9,
    'still Am after the blip (' + (after[after.length - 1] || {}).root + ')');
});

t.test('a sustained chord change is adopted', function () {
  var seg = renderNotes([[69, 72, 76], [72, 76, 79]], [0.7, 0.7]);
  var eng = P.createEngine(FS, { defaults: RD.DEFAULTS });
  eng.params.budget = 1; eng.params.frame = 'long';
  var log = [];
  eng.onFrame = function (info) {
    log.push({ t: info.start / FS, root: eng.chord.root, quality: eng.chord.quality });
  };
  drive(eng, seg);
  var late = log.filter(function (r) { return r.t > 1.15; });
  t.ok(late.length > 0 && late[late.length - 1].root === 0,
    'C major adopted (' + (late[late.length - 1] || {}).root + '/' +
    (late[late.length - 1] || {}).quality + ')');
});

console.log(t.pass + '/' + (t.pass + t.fail) + ' tests pass, ' + t.checks + ' checks');
process.exit(t.fail > 0 ? 1 : 0);