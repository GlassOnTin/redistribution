#!/usr/bin/env node
// test-worklet.js — drives the real worklet-effect.js under a node vm shim.
// The worklet's emission path is logic, not plumbing: the engine can emit
// fewer samples than the output quantum (bursty OLA frame completions), and
// the worklet must carry the remainder across quanta so the live stream
// equals the offline (worker.js-style) accumulation sample-for-sample.
// Regression target: the zero-padding desync found in the first live
// selftest run (23 short quanta -> live/offline residual 0.55).
//
//   node tools/test-worklet.js
'use strict';
var fs = require('fs');
var vm = require('vm');
var path = require('path');
var t = require('./harness.js');
var REPO = path.join(__dirname, '..');
var RDParams = require('../params.js');
var RDPipeline = require('../pipeline.js');
var RDLoops = require('../loops.js');

function makeWorklet() {
  var registered = {};
  var posted = [];
  var sandbox = {
    console: console, Math: Math, Float32Array: Float32Array, Int32Array: Int32Array,
    Float64Array: Float64Array, isFinite: isFinite,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.sampleRate = 48000;
  sandbox.AudioWorkletProcessor = function () {
    this.port = {
      onmessage: null,
      postMessage: function (m) { posted.push(m); },
    };
  };
  sandbox.registerProcessor = function (name, cls) { registered[name] = cls; };
  vm.createContext(sandbox);
  // the real blob composition order: params + pipeline + effect
  for (var f of ['params.js', 'pipeline.js', 'worklet-effect.js'])
    vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), sandbox,
      { filename: f });
  var Cls = registered['redistribution-effect'];
  if (!Cls) throw new Error('processor not registered');
  var node = new Cls();
  node.__posted = posted;
  return node;
}

// offline reference: same engine, same params, accumulate partial emissions
// into one contiguous stream (the worker.js contract)
function offlineRender(loop, fs, seconds, over) {
  var eng = RDPipeline.createEngine(fs, { defaults: RDParams.DEFAULTS });
  for (var k in over) eng.params[k] = over[k];
  var CH = 1024;
  var N = Math.min((seconds * fs) | 0, loop.left.length);
  var aL = new Float32Array(CH), aR = new Float32Array(CH);
  var oL = new Float32Array(CH), oR = new Float32Array(CH);
  var outL = new Float32Array(N);
  var pos = 0, got = 0, flushed = 0;
  while (pos < N || got < N) {
    var n;
    if (pos < N) {
      n = Math.min(CH, N - pos);
      for (var j = 0; j < n; j++) { aL[j] = loop.left[pos + j]; aR[j] = loop.right[pos + j]; }
      pos += n;
    } else {
      n = CH; aL.fill(0); aR.fill(0);
      if (++flushed > 64) break;
    }
    var give = eng.process(aL, aR, oL, oR, n);
    for (j = 0; j < give && got < N; j++) outL[got + j] = oL[j];
    got += give;
  }
  return outL.subarray(0, got);
}

(function main() {
  var fs = 48000;
  var over = { budget: 0.6, gravity: 0.5 };
  var loop = RDLoops.render('sweep', fs);
  var SECONDS = 1;

  t.test('worklet output is sample-identical to the offline accumulation', function () {
    var node = makeWorklet();
    node.port.onmessage({ data: { type: 'params', p: over } });
    var n = 128;
    var N = (SECONDS * fs) | 0;
    var live = new Float32Array(N);
    var got = 0, pos = 0;
    var inL = new Float32Array(n), inR = new Float32Array(n);
    var oL = new Float32Array(n), oR = new Float32Array(n);
    while (got < N) {
      for (var j = 0; j < n; j++) {
        inL[j] = pos < loop.left.length ? loop.left[pos + j] : 0;
        inR[j] = pos < loop.right.length ? loop.right[pos + j] : 0;
      }
      pos += n;
      var ok = node.process([[inL, inR]], [[oL, oR]]);
      t.ok(ok === true, 'process claims activity');
      for (j = 0; j < n && got < N; j++) live[got + j] = oL[j];
      got += n;
      if (pos > N + fs) break;   // guard
    }
    // live stream has startup zeros (engine fill); find first loud sample
    var firstLoud = 0;
    while (firstLoud < N && Math.abs(live[firstLoud]) < 0.01) firstLoud++;
    t.ok(firstLoud < N, 'worklet emits sound (first loud at ' + firstLoud + ')');

    var off = offlineRender(loop, fs, SECONDS, over);
    var offLoud = 0;
    while (offLoud < off.length && Math.abs(off[offLoud]) < 0.01) offLoud++;

    // align on sound onset, then compare full-length; must be exact (same
    // engine, same machine arithmetic — the emission buffer only re-times)
    var d0 = firstLoud - offLoud;
    var worst = 0, at = -1;
    var hi = Math.min(N, off.length - Math.max(0, d0) * 0) - 0;
    for (var i = offLoud; i < off.length; i++) {
      var li = i + d0;
      if (li < 0 || li >= N) continue;
      var d = Math.abs(live[li] - off[i]);
      if (d > worst) { worst = d; at = i; }
    }
    t.ok(worst < 1e-9, 'worklet stream matches offline (worst ' + worst.toExponential(2) +
      ' at ' + at + ', onset delta ' + d0 + ')');
  });

  t.test('no starvation after the emission buffer primes', function () {
    var node = makeWorklet();
    var n = 128;
    var inL = new Float32Array(n), inR = new Float32Array(n);
    var oL = new Float32Array(n), oR = new Float32Array(n);
    var pos = 0;
    for (var q = 0; q < 400; q++) {           // 400 quanta = ~1.07 s at 48k
      for (var j = 0; j < n; j++) {
        inL[j] = pos < loop.left.length ? loop.left[pos + j] : 0;
        inR[j] = pos < loop.right.length ? loop.right[pos + j] : 0;
      }
      pos += n;
      node.process([[inL, inR]], [[oL, oR]]);
    }
    t.ok(node.primed, 'emission buffer primed');
    t.ok(node.shortEmits === 0, 'no starved quanta after priming (' +
      node.shortEmits + ', ' + node.deferred + ' samples)');
  });

  t.test('taps post with band data and are gateable', function () {
    var node = makeWorklet();
    node.port.onmessage({ data: { type: 'taps', on: true, every: 1 } });
    var n = 128;
    var inL = new Float32Array(n), inR = new Float32Array(n);
    var oL = new Float32Array(n), oR = new Float32Array(n);
    var pos = 0;
    for (var q = 0; q < 100; q++) {
      for (var j = 0; j < n; j++) {
        inL[j] = pos < loop.left.length ? loop.left[pos + j] : 0;
        inR[j] = pos < loop.right.length ? loop.right[pos + j] : 0;
      }
      pos += n;
      node.process([[inL, inR]], [[oL, oR]]);
    }
    var taps = node.__posted.filter(function (m) { return m.type === 'taps'; });
    t.ok(taps.length > 0, 'taps posted (' + taps.length + ')');
    var m = taps[0];
    t.ok(m.bandsE instanceof Float32Array && m.bandsE.length > 0,
      'bandsE is a Float32Array with ' + (m.bandsE ? m.bandsE.length : 0) + ' bands');
    t.ok(m.edge instanceof Int32Array && m.destEdge instanceof Int32Array,
      'edge maps present');
    t.ok(typeof m.fs === 'number' && m.fs === 48000, 'fs reported');
    // gates off again
    node.port.onmessage({ data: { type: 'taps', on: false } });
    var before = node.__posted.length;
    node.process([[inL, inR]], [[oL, oR]]);
    node.process([[inL, inR]], [[oL, oR]]);
    t.ok(node.__posted.length === before, 'no taps while gated off');
  });

  console.log(t.pass + '/' + (t.pass + t.fail) + ' tests pass, ' + t.checks + ' checks');
  process.exit(t.fail > 0 ? 1 : 0);
})();