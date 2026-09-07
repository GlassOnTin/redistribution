#!/usr/bin/env node
// smoke-worker.js — drives the real worker.js under a node shim. The engine
// itself is covered by the test-* gates; this covers the worker plumbing:
// importScripts routing under a Worker scope, message protocol, transferable
// output, and the error path. In the browser the same file runs in a
// DedicatedWorker; nothing here reaches a unit test.
//
//   node tools/smoke-worker.js
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const REPO = path.join(__dirname, '..');

function makeSandbox() {
  const posted = [];
  const sandbox = {
    console, Math, JSON, Error, Promise, Array, Object, String, Number, Boolean,
    Uint8Array, Int32Array, Float32Array, Float64Array, isNaN, parseInt,
    parseFloat, setTimeout, clearTimeout, isFinite,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.importScripts = (...ps) => {
    for (const p of ps) {
      const clean = p.split('?')[0];
      const mod = require(`${REPO}/${clean}`);
      if (clean.includes('params')) sandbox.RDParams = mod;
      else if (clean.includes('pipeline')) sandbox.RDPipeline = mod;
      else if (clean.includes('loops')) sandbox.RDLoops = mod;
    }
  };
  sandbox.postMessage = (m) => posted.push(m);
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(`${REPO}/worker.js`, 'utf8'), sandbox,
    { filename: 'worker.js' });
  return { sandbox, posted };
}

// worker.js wires onmessage = fn; capture it
let handler = null;
const t = { pass: 0, fail: 0, checks: 0 };
function ok(c, msg) {
  t.checks++;
  if (!c) throw new Error('check failed: ' + msg);
}

// --- run 1: happy path ---
{
  const { sandbox } = makeSandbox();
  handler = sandbox.onmessage;
  ok(typeof handler === 'function', 'worker.js installs an onmessage handler');
  const posted = [];
  sandbox.postMessage = (m) => posted.push(m);
  handler.call(sandbox, { data: { type: 'render', loop: 'sweep', fs: 48000,
    params: { budget: 0.6, gravity: 0.5 } } });
  ok(posted.length === 1, 'exactly one reply');
  const m = posted[0];
  ok(m.ok === true, 'render succeeds');
  ok(m.left instanceof Float32Array && m.right instanceof Float32Array,
    'stereo Float32Arrays returned');
  ok(m.left.length === m.right.length && m.left.length === 96000,
    'full loop length (' + m.left.length + ')');
  let finite = true, energy = 0;
  for (let i = 0; i < m.left.length; i += 97) {
    if (!isFinite(m.left[i]) || !isFinite(m.right[i])) { finite = false; break; }
    energy += m.left[i] * m.left[i];
  }
  ok(finite, 'output is finite everywhere (sampled)');
  ok(energy > 0, 'output is not silent');
  ok(m.stats && m.stats.frames > 0, 'stats reported (' + m.stats.frames + ' frames)');

  // determinism: same message -> bit-identical output (engine is stateless per render)
  const posted2 = [];
  sandbox.postMessage = (m2) => posted2.push(m2);
  handler.call(sandbox, { data: { type: 'render', loop: 'sweep', fs: 48000,
    params: { budget: 0.6, gravity: 0.5 } } });
  const a = posted[0].left, b = posted2[0].left;
  let diff = 0;
  for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > diff) diff = d; }
  ok(diff === 0, 'two identical renders are bit-identical (diff ' + diff + ')');
}

// --- run 2: fresh sandbox, error path ---
{
  const { sandbox } = makeSandbox();
  handler = sandbox.onmessage;
  const posted = [];
  sandbox.postMessage = (m) => posted.push(m);
  handler.call(sandbox, { data: { type: 'render', loop: 'does-not-exist', fs: 48000, params: {} } });
  ok(posted.length === 1 && posted[0].ok === false, 'unknown loop -> ok:false');
  ok(String(posted[0].error).includes('unknown loop'), 'error mentions the cause (' +
    posted[0].error + ')');
  handler.call(sandbox, { data: { type: 'bogus' } });
  ok(posted.length === 2 && posted[1].ok === false, 'unknown message type -> ok:false');
}

console.log(t.pass === t.fail ? '' : '');
console.log('smoke-worker: ' + t.checks + ' checks, all pass');
process.exit(0);