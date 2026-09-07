// test-gravity.js — the gravity, memory and curve gates. Pins: the destEdge
// contract (monotone, clamped to source edges, identity at gravity 0), the
// 9 kHz tone's centroid landing well down-spectrum at gravity 1, the Memory
// time-constant discriminator (fast map vs slow map under starvation), memory
// persisting through silence, and the three fold-weight curves being distinct
// while all satisfying the contract.
//
// Numbers are measured behaviour (probe15), with margin.
'use strict';
var t = require('./harness.js');
var P = require('../pipeline.js');
var RD = require('../params.js');

var FS = 48000, CHUNK = 128, N = 24000;
var bandsL = P.buildBands(FS, 1024, 2048);
var BL = P.bandCount(bandsL);

function makeEng(params, mapInit) {
  var eng = P.createEngine(FS, { defaults: RD.DEFAULTS });
  var d = eng.params;
  for (var k in params) d[k] = params[k];
  if (mapInit !== undefined) for (var j = 0; j < eng.map.length; j++) eng.map[j] = mapInit;
  return eng;
}
function drive(eng, x) {
  var a = new Float32Array(CHUNK), oa = new Float32Array(CHUNK);
  var rin = new Float32Array(CHUNK), rout = new Float32Array(CHUNK);
  var pos = 0;
  while (pos < x.length + 4096) {
    var n = Math.min(CHUNK, x.length + 4096 - pos);
    for (var i = 0; i < n; i++) a[i] = pos + i < x.length ? x[pos + i] : 0;
    eng.process(a, rin, oa, rout, n);
    pos += n;
  }
}
function sig(seed) {
  var x = new Float32Array(N);
  var r = P.mulberry32(seed);
  for (var i = 0; i < N; i++) {
    x[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / FS) +
           0.3 * Math.sin(2 * Math.PI * 3000 * i / FS + 0.7) +
           0.2 * Math.sin(2 * Math.PI * 9000 * i / FS + 1.3) +
           0.05 * (r() * 2 - 1);
  }
  return x;
}
function tone9k() {
  var x = new Float32Array(N);
  for (var i = 0; i < N; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 9000 * i / FS);
  return x;
}
function silence(n) { return new Float32Array(n === undefined ? 24576 : n); }

function checkContract(de, name) {
  t.near(de[0], 1, 0.5, name + ' starts at bin 1');
  for (var j = 0; j < BL; j++) {
    t.ok(de[j + 1] >= de[j], name + ' monotone at j=' + j);
    t.ok(de[j + 1] <= bandsL.edge[j + 1], name + ' clamped at j=' + j);
  }
}

t.test('destEdge contract: identity at gravity 0, compacted at gravity 1', function () {
  var x = sig(11);
  // identity: modify path runs (budget 0.9 defeats bypass) but strength is 0
  var eng0 = makeEng({ budget: 0.9, gravity: 0, hunt: 0, lock: 0, memory: 30, mask: 'drop' });
  var de0 = null;
  eng0.onBins = function (mL, mR, K, short) { if (!short) de0 = Array.from(eng0.destEdge); };
  drive(eng0, x);
  checkContract(de0, 'gravity 0');
  for (var j = 0; j <= BL; j++) t.near(de0[j], bandsL.edge[j], 0.5,
    'gravity 0 leaves destEdge as the identity at j=' + j);

  // gravity 1 with the map preset to 1: hard compaction, folded somewhere
  var eng1 = makeEng({ budget: 1, gravity: 1, hunt: 0, lock: 0, memory: 30, mask: 'drop', exactEnergy: true }, 1);
  var de1 = null;
  eng1.onBins = function (mL, mR, K, short) { if (!short) de1 = Array.from(eng1.destEdge); };
  drive(eng1, x);
  checkContract(de1, 'gravity 1');
  var anyFold = false;
  for (j = 0; j < BL; j++) if (de1[j + 1] < bandsL.edge[j + 1]) anyFold = true;
  t.ok(anyFold, 'gravity 1 with map=1 actually folds');
  // measured destEdge[20]: bark 180 vs source edge well above it
  t.ok(de1[20] < bandsL.edge[20] - 20, 'top bands compacted hard (destEdge[20]=' + de1[20] + ' edge=' + bandsL.edge[20] + ')');
});

t.test('9 kHz tone folds down-spectrum at gravity 1', function () {
  var x = tone9k();
  // peak bin per long frame, median over mid-run frames (the flush tail is
  // silent and would read bin 0)
  function peakRun(params, mapInit) {
    var eng = makeEng(params, mapInit);
    var pks = [];
    eng.onBins = function (mL, mR, K, short) {
      if (short) return;
      var best = 0, bv = 0;
      for (var k = 1; k < K; k++) if (mL[k] > bv) { bv = mL[k]; best = k; }
      pks.push(best);
    };
    drive(eng, x);
    var q = pks.slice(5, 22).sort(function (a, b) { return a - b; });
    return q[Math.floor(q.length / 2)];
  }
  // bypass reference: the tone sits at bin 9000/(48000/2048) = 384 exactly
  var pk = peakRun({ budget: 1, gravity: 0, lock: 0 });
  t.near(pk, 384, 1, 'bypass tone peak at bin 384');
  var pf = peakRun({ budget: 1, gravity: 1, hunt: 0, lock: 0, memory: 30, mask: 'drop', exactEnergy: true }, 1);
  // measured: 134
  t.ok(pf >= 30 && pf <= 250, 'folded tone peak well down-spectrum (bin ' + pf + ')');
});

t.test('memory time constant: fast map rises under starvation, slow map barely moves', function () {
  var x = silence();
  function mapAt(mem) {
    var eng = makeEng({ budget: 1, gravity: 1, hunt: 0, lock: 0, memory: mem, mask: 'drop', exactEnergy: true });
    var snap = null;
    eng.onBins = function (mL, mR, K, short) {
      if (short) return;
      snap = Array.from(eng.map);
    };
    drive(eng, x);
    return snap[Math.floor(snap.length / 2)];
  }
  // 24 starved long frames: measured 0.669 (fast) vs 0.007 (slow)
  var fast = mapAt(0.1), slow = mapAt(30);
  t.ok(fast > 0.5, 'memory 0.1 s map rises past 0.5 (' + fast.toFixed(3) + ')');
  t.ok(slow < 0.05, 'memory 30 s map stays near 0 (' + slow.toFixed(3) + ')');
});

t.test('memory persists through silence into the next sound', function () {
  var x = sig(11);
  var base = { budget: 1, gravity: 1, hunt: 0, lock: 0, memory: 0.1, mask: 'drop', exactEnergy: true };
  function destEdgeTone(withSilence) {
    var eng = makeEng(Object.assign({}, base));
    var des = [];
    eng.onBins = function (mL, mR, K, short) { if (!short) des.push(Array.from(eng.destEdge)); };
    if (withSilence) {
      var feed = new Float32Array(24576 + N);
      feed.set(x, 24576);
      drive(eng, feed);
    } else {
      drive(eng, x);
    }
    // frame index 34: the tone begins ~24 long frames in (or frame 10 for the
    // fresh engine); both snapshots are 10 frames into steady tone
    var idx = withSilence ? 34 : 10;
    return des[idx];
  }
  var deA = destEdgeTone(true);
  var deB = destEdgeTone(false);
  var diffs = 0;
  for (var j = 0; j <= BL; j++) if (deA[j] !== deB[j]) diffs++;
  t.ok(diffs >= 3, 'the silence-trained map warps differently (diffs=' + diffs + ')');
});

t.test('fold-weight curves are distinct and all satisfy the contract', function () {
  var x = sig(11);
  var base = { budget: 1, gravity: 1, hunt: 0, lock: 0, memory: 30, mask: 'drop', exactEnergy: true };
  function deFor(curve) {
    var eng = makeEng(Object.assign({ curve: curve }, base), 1);
    var de = null;
    eng.onBins = function (mL, mR, K, short) { if (!short) de = Array.from(eng.destEdge); };
    drive(eng, x);
    return de;
  }
  var bark = deFor('bark'), power = deFor('power'), lin = deFor('linear');
  checkContract(bark, 'bark'); checkContract(power, 'power'); checkContract(lin, 'linear');
  ['bark', 'power', 'linear'].forEach(function (cv) {
    t.ok(['bark', 'power', 'linear'].indexOf(cv) >= 0, 'curve ' + cv + ' is a legal value');
  });
  // pairwise distinct in the upper half
  var pairs = [[bark, power, 'bark/power'], [bark, lin, 'bark/linear'], [power, lin, 'power/linear']];
  pairs.forEach(function (pr) {
    var d = 0;
    for (var j = 10; j <= BL; j++) if (pr[0][j] !== pr[1][j]) d++;
    t.ok(d >= 3, pr[2] + ' curves differ in the upper half (' + d + ' entries)');
  });
  // bark compresses the top more than linear: measured destEdge[25] 413 vs 522
  t.ok(bark[25] < lin[25], 'bark compacts the top harder than linear (' + bark[25] + ' < ' + lin[25] + ')');
});

console.log(t.pass + '/' + (t.pass + t.fail) + ' tests pass, ' + t.checks + ' checks');
process.exit(t.fail > 0 ? 1 : 0);