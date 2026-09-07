// test-energy.js — the conservation and budget gates. Pins four behaviours the
// rest of the engine leans on: ExactEnergy conserves bin energy through the
// fold, the plain complex-sum fold does not (it partially cancels), Budget
// bites on dense material and saturates once demand is met, and drop/hide do
// what their names say to starved bands.
//
// Numbers below are measured behaviour (probe15/probe16), not analytic ground
// truth; the assertions carry margin around them.
'use strict';
var t = require('./harness.js');
var P = require('../pipeline.js');
var RD = require('../params.js');

var FS = 48000, CHUNK = 128, N = 24000;

function makeEng(params, mapInit) {
  var eng = P.createEngine(FS, { defaults: RD.DEFAULTS });
  var d = eng.params;
  for (var k in params) d[k] = params[k];
  if (mapInit !== undefined) for (var j = 0; j < eng.map.length; j++) eng.map[j] = mapInit;
  return eng;
}

// drive with SEPARATE in/out right-channel buffers: aliasing them feeds the
// engine's own output back as input and compounds divergence between runs
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

// 3-tone bed (the engine's usual test diet): two tones plus a soft top tone
// and a little noise
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

// white noise bed, used where dense broad-band material is the point
function sigN(seed) {
  var x = new Float32Array(N);
  var r = P.mulberry32(seed);
  for (var i = 0; i < N; i++) x[i] = 0.2 * (r() * 2 - 1);
  return x;
}

// per-long-frame total bin energy, median over the mid-run frames (the tail
// is the zero-filled flush and reads 0)
function series(x, params, mapInit) {
  var tot = [];
  var eng = makeEng(params, mapInit);
  eng.onBins = function (mL, mR, K, short) {
    if (short) return;
    var s = 0;
    for (var k = 1; k < K; k++) s += mL[k] * mL[k] + mR[k] * mR[k];
    tot.push(s);
  };
  drive(eng, x);
  return tot;
}
function medMid(tot) {
  var s = tot.slice(5, 22).slice().sort(function (a, b) { return a - b; });
  return s[Math.floor(s.length / 2)];
}

t.test('budget bites on dense material and saturates above demand', function () {
  var x = sigN(3);
  var base = { gravity: 0, hunt: 0, lock: 0, memory: 30, level: 0, mask: 'drop' };
  var E = [];
  [0.02, 0.04, 0.08, 0.16, 0.32, 0.64].forEach(function (b) {
    E.push(medMid(series(x, Object.assign({ budget: b }, base))));
  });
  // measured: 298 / 806 / 3242 / 7522 / 7522 / 7522
  for (var i = 1; i < 4; i++) t.ok(E[i] > E[i - 1] * 1.5,
    'energy rises with budget at step ' + i + ' (' + E[i - 1].toFixed(0) + ' -> ' + E[i].toFixed(0) + ')');
  t.ok(E[3] / E[0] >= 10, 'budget 0.16 yields >=10x the energy of 0.02 (' + (E[3] / E[0]).toFixed(1) + 'x)');
  t.near(E[4] / E[3], 1, 0.05, 'saturates by budget 0.32');
  t.near(E[5] / E[4], 1, 0.02, 'plateau holds to 0.64');
});

t.test('exactEnergy conserves bin energy through the fold', function () {
  var x = sig(11);
  // quantize-only reference: gravity 1e-5 is below the bypass threshold so
  // the modify path runs, but its fold strength is nil. Measured ratios are
  // 1.0000 at all three gravities.
  var ref = medMid(series(x, { budget: 1, gravity: 1e-5, hunt: 0, lock: 0, memory: 30, mask: 'drop' }));
  [0.4, 0.7, 1.0].forEach(function (g) {
    var me = medMid(series(x, { budget: 1, gravity: g, hunt: 0, lock: 0, memory: 30, mask: 'drop', exactEnergy: true }, 1));
    t.near(me / ref, 1, 0.02, 'exact fold conserves energy at gravity ' + g + ' (' + (me / ref).toFixed(4) + ')');
  });
});

t.test('plain complex-sum fold partially cancels', function () {
  var x = sig(11);
  var ref = medMid(series(x, { budget: 1, gravity: 1e-5, hunt: 0, lock: 0, memory: 30, mask: 'drop' }));
  // measured 0.70 at 0.7, 0.64 at 1.0: many-to-one coherent sums cancel
  [0.7, 1.0].forEach(function (g) {
    var me = medMid(series(x, { budget: 1, gravity: g, hunt: 0, lock: 0, memory: 30, mask: 'drop' }, 1));
    t.ok(me / ref < 0.9, 'plain fold loses energy at gravity ' + g + ' (' + (me / ref).toFixed(3) + ')');
    t.ok(me / ref > 0.4, 'plain fold does not annihilate at gravity ' + g + ' (' + (me / ref).toFixed(3) + ')');
  });
});

t.test('drop zeroes starved bands; hide buries them under the neighbour', function () {
  var x = sigN(5);
  // level -60: the allocation scale is now dBFS-anchored (+96 offset), so
  // -60 keeps this bed below threshold — the fixture needs everything
  // starved for the drop/hide comparison to bite
  var base = { budget: 0.15, gravity: 0, hunt: 0, lock: 0, level: -60 };
  function measure(mask) {
    var eng = makeEng(Object.assign({ mask: mask }, base));
    var totals = [], starvedEs = [];
    eng.onBins = function (mL, mR, K, short) {
      if (short) return;
      var s = Array.from(eng.starved), bands = eng.bands, B = eng.bandCount;
      var tt = 0, se = 0;
      for (var k = 1; k < K; k++) {
        var e2 = mL[k] * mL[k] + mR[k] * mR[k];
        tt += e2;
        for (var j = 0; j < B; j++) {
          if (s[j] && k >= bands.edge[j] && k < bands.edge[j + 1]) { se += e2; break; }
        }
      }
      totals.push(tt); starvedEs.push(se);
    };
    drive(eng, x);
    // mid-run median: the tail frames are the zero-filled flush
    var mid = function (arr) {
      var q = arr.slice(5, 22).sort(function (a, b) { return a - b; });
      return q[Math.floor(q.length / 2)];
    };
    return { total: mid(totals), starvedE: mid(starvedEs) };
  }
  // everything starves on this bed: drop should leave near nothing, hide
  // should pile the starved bands' energy into the neighbours' ranges
  // (measured: drop 455 total / 0 starved-range, hide 11373 / 10861)
  var dr = measure('drop'), hi = measure('hide');
  t.ok(dr.total < 0.15 * hi.total, 'drop removes starved bands (total ' + dr.total.toFixed(0) + ' vs ' + hi.total.toFixed(0) + ')');
  t.ok(dr.starvedE < 0.02 * hi.starvedE, 'drop zeroes starved ranges (' + dr.starvedE.toFixed(0) + ' vs ' + hi.starvedE.toFixed(0) + ')');
  t.ok(hi.starvedE > 0.5 * hi.total, 'hide keeps starved-range energy in neighbours (10861/11373 shape)');
});

console.log(t.pass + '/' + (t.pass + t.fail) + ' tests pass, ' + t.checks + ' checks');
process.exit(t.fail > 0 ? 1 : 0);