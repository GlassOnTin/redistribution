// test-synth.js — the synth bank gate + loop determinism. Analytic probes with
// a plain DFT (the goertzel helpers in the older probes were biased 1.08x and
// are retired). Pins: band-limited saw harmonic series (p-th harmonic ~ 1/p of
// the fundamental), no alias above the table cutoff, voice stealing keeps the
// oldest voice bound, release retires voices, harmonic-mode inharmonicity is
// measurable, and budgetScale matches the annex numbers.
'use strict';
var t = require('./harness.js');
var S = require('../synth.js');
var RD = require('../params.js');
var Loops = require('../loops.js');

var FS = 48000, N = 8192;

function dft(x, f) {
  var w = 2 * Math.PI * f / FS, re = 0, im = 0;
  for (var k = 0; k < x.length; k++) {
    re += x[k] * Math.cos(w * k); im -= x[k] * Math.sin(w * k);
  }
  return 2 * Math.sqrt(re * re + im * im) / x.length;
}

function sustain(synth, note, blocks) {
  synth.noteOn(note);
  var out = new Float32Array(N * blocks), buf = new Float32Array(N);
  for (var b = 0; b < blocks; b++) { synth.render(buf, N); out.set(buf, b * N); }
  return out;
}

t.test('band-limited saw: harmonic amplitudes follow 1/p, no alias above cutoff', function () {
  var s = S.Synth(FS);
  var x = sustain(s, 69, 2);                    // A4 440, table k=4: 13 harmonics
  var h1 = dft(x, 440);
  t.ok(h1 > 0.3, 'fundamental present (' + h1.toFixed(3) + ')');
  for (var p = 2; p <= 8; p++) {
    var want = h1 / p, got = dft(x, 440 * p);
    t.ok(Math.abs(got - want) < 0.06 * h1,
      'harmonic ' + p + ': ' + got.toFixed(4) + ' vs ' + want.toFixed(4));
  }
  // table cutoff for 440 is ~12 kHz -> harmonic 28 missing; check 13 kHz region
  var alias = dft(x, 13000);
  t.ok(alias < 0.02, 'no content above the table cutoff (' + alias.toFixed(4) + ')');
});

t.test('sine table selection: an 8 kHz note produces no image above Nyquist margin', function () {
  var s = S.Synth(FS);
  var x = sustain(s, 69 + 48, 1);               // ~7.04 kHz — near the top table
  var f = 440 * Math.pow(2, 48 / 12);
  var h1 = dft(x, f);
  t.ok(h1 > 0.2, 'high note sounds (' + h1.toFixed(3) + ')');
  // harmonic 2 would sit at 14 kHz; the chosen table must have killed it
  t.ok(dft(x, 2 * f) < 0.4 * h1, 'second harmonic bounded at high note (' +
    dft(x, 2 * f).toFixed(4) + ' vs ' + h1.toFixed(4) + ')');
});

t.test('voice stealing: 17th note reuses the oldest, count stays <= 16', function () {
  var s = S.Synth(FS);
  for (var n = 0; n < 17; n++) s.noteOn(60 + n);
  t.ok(s.activeCount() <= 16, 'active count capped (' + s.activeCount() + ')');
  // note 60 was the oldest — its voice must have been stolen away
  var held = s.voices.filter(function (v) { return v.gate && v.note === 60; }).length;
  t.ok(held === 0, 'oldest note was stolen (' + held + ' voices still hold it)');
});

t.test('release: noteOff decays to silence and the voice retires', function () {
  var s = S.Synth(FS);
  s.noteOn(69);
  var buf = new Float32Array(N);
  s.render(buf, N);
  s.noteOff(69);
  // release is 60 ms -> 2880 samples; render past it
  var tail = new Float32Array(N);
  for (var b = 0; b < 2; b++) s.render(buf, N);   // 16384 samples > 2880
  s.render(tail, N);
  var r = 0;
  for (var i = 0; i < N; i++) r += tail[i] * tail[i];
  t.ok(Math.sqrt(r / N) < 1e-3, 'tail is silent (' + Math.sqrt(r / N).toExponential(2) + ')');
  t.ok(s.activeCount() === 0, 'voice retired (active ' + s.activeCount() + ')');
});

t.test('harmonic mode: 6 partials, p^-0.8 amplitudes, measurable inharmonicity', function () {
  var s = S.Synth(FS, { waveform: 'harmonic' });
  var x = sustain(s, 69, 2);                    // A4 440
  var f0 = 440;
  // partial 6 lands at f0*6*(1+4e-4*36) = f0*6.0864 — resolvable at 48 kHz
  var p6 = dft(x, f0 * 6 * (1 + 4e-4 * 36));
  var p6harm = dft(x, f0 * 6);
  t.ok(p6 > 0.05, 'inharmonic partial 6 present (' + p6.toFixed(4) + ')');
  t.ok(p6 > p6harm, 'partial 6 sits at the inharmonic position, not the harmonic one (' +
    p6.toFixed(4) + ' vs ' + p6harm.toFixed(4) + ')');
  var p1 = dft(x, f0);
  t.ok(p1 > p6 * 4, 'amplitudes fall (p1 ' + p1.toFixed(3) + ' > 4x p6 ' + p6.toFixed(3) + ')');
});

t.test('budgetScale matches the annex: 1 voice -> 1.00, 8 -> 0.37, 16 -> 0.22', function () {
  t.near(RD.budgetScale(1), 1, 1e-9, 'single voice unscaled');
  t.near(RD.budgetScale(8), 0.37, 0.01, '8 voices lands on the annex number');
  t.near(RD.budgetScale(16), 0.22, 0.01, '16 voices lands on the annex number');
  t.ok(RD.budgetScale(2) < 1 && RD.budgetScale(2) > RD.budgetScale(3),
    'monotonically decreasing');
});

t.test('loops: deterministic, head-roomed, unknown id throws', function () {
  for (var i = 0; i < Loops.LOOPS.length; i++) {
    var id = Loops.LOOPS[i].id;
    var a = Loops.render(id, FS), b = Loops.render(id, FS);
    t.ok(a.left.length === b.left.length && a.right.length === b.right.length,
      id + ': consistent length');
    var diff = 0;
    for (var j = 0; j < a.left.length; j++) {
      var d = Math.max(Math.abs(a.left[j] - b.left[j]), Math.abs(a.right[j] - b.right[j]));
      if (d > diff) diff = d;
    }
    t.ok(diff === 0, id + ': two renders bit-identical');
    var pk = 0;
    for (j = 0; j < a.left.length; j++) pk = Math.max(pk, Math.abs(a.left[j]), Math.abs(a.right[j]));
    t.ok(pk <= 0.901, id + ': peak within head-room (' + pk.toFixed(3) + ')');
  }
  var threw = false;
  try { Loops.render('nope', FS); } catch (e) { threw = true; }
  t.ok(threw, 'unknown loop id throws');
});

console.log(t.pass + '/' + (t.pass + t.fail) + ' tests pass, ' + t.checks + ' checks');
process.exit(t.fail > 0 ? 1 : 0);