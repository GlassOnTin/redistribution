// test-bypass.js — gate 2. With every mechanism neutral (budget=1 -> the
// isBypass fast path) the engine must be an exact identity: the sample the
// engine emits as its k-th output equals input sample k, for any legal frame
// schedule. This is what makes the TDAC window family and the scheduler
// trustworthy before any modification is layered on. A second, looser gate
// checks that the full modify path (allocation + quantize + fold) is *nearly*
// an identity at full budget — lossy by design, but not catastrophically.
//
// Emission is indexed, not chunk-indexed: the engine runs a fixed output
// backlog (the latency), so each process() call returns the oldest finalised
// samples, which do not align with the chunk's input position.
'use strict';
var t = require('./harness.js');
var P = require('../pipeline.js');
var RD = require('../params.js');

var FS = 48000, CHUNK = 128, N = 12000;

// Feed x, collect emitted output in emission order. Returns { y, emitted }.
function run(x, params, fs, onEvent) {
  var eng = P.createEngine(fs || FS, { defaults: RD.DEFAULTS });
  var d = eng.params;
  // fully neutral set -> isBypass fast path (budget 1 AND lock 0)
  d.budget = 1; d.lock = 0; d.gravity = 0; d.intensity = 0;
  for (var k in params) d[k] = params[k];
  if (onEvent) eng.onEvent = onEvent;
  var y = new Float32Array(x.length);
  var emitted = 0, pos = 0;
  var a = new Float32Array(CHUNK), oa = new Float32Array(CHUNK);
  var rin = new Float32Array(CHUNK);  // right-channel input: NOT the output
  var rout = new Float32Array(CHUNK); // buffer — aliasing the two would feed
  while (pos < x.length + 4096) {     // the engine's own output back in
    var n = Math.min(CHUNK, x.length + 4096 - pos);
    for (var i = 0; i < n; i++) a[i] = pos + i < x.length ? x[pos + i] : 0;
    var give = eng.process(a, rin, oa, rout, n);
    for (i = 0; i < give; i++) if (emitted + i < x.length) y[emitted + i] = oa[i];
    emitted += give;
    pos += n;
  }
  return { y: y, emitted: emitted };
}

// mono test signal: two sines + a little noise
function makeSignal(seed) {
  var x = new Float32Array(N);
  var r = P.mulberry32(seed);
  for (var i = 0; i < N; i++) {
    x[i] = 0.4 * Math.sin(2 * Math.PI * 220 * i / FS) +
           0.3 * Math.sin(2 * Math.PI * 3170 * i / FS + 1.1) +
           0.1 * (r() * 2 - 1);
  }
  return x;
}

function worstDiff(x, y, lo, hi) {
  var w = 0, at = -1;
  for (var i = lo; i < hi; i++) {
    var d = Math.abs(y[i] - x[i]);
    if (d > w) { w = d; at = i; }
  }
  return { w: w, at: at };
}

var x = makeSignal(7);
var INTERIOR = [2048, N - 4096]; // safely final for all schedules tested

t.test('bypass: Frame=long is an exact identity at zero offset', function () {
  var r = run(x, { frame: 'long' });
  var w = worstDiff(x, r.y, INTERIOR[0], INTERIOR[1]);
  t.ok(w.w < 1e-7, 'long identity (worst ' + w.w.toExponential(2) + ' at ' + w.at + ')');
});

t.test('bypass: Frame=short is an exact identity at zero offset', function () {
  var r = run(x, { frame: 'short' });
  var w = worstDiff(x, r.y, INTERIOR[0], INTERIOR[1]);
  t.ok(w.w < 1e-7, 'short identity (worst ' + w.w.toExponential(2) + ' at ' + w.at + ')');
});

t.test('bypass: Frame=adaptive through impulse-driven switches', function () {
  // impulses spaced past one long hop on a noise-free bed: each burst is
  // followed by a quiet frame with large flux and tiny top-band energy — one
  // ratio spike, which is what trips the transient counter (lockout stops
  // thrash). A noise bed would bury the spike under its own top-band energy.
  var NA = 24000; // several full long<->short cycles need runway
  var xi = new Float32Array(NA);
  for (var i = 0; i < NA; i++) {
    xi[i] = 0.4 * Math.sin(2 * Math.PI * 220 * i / FS) +
            0.3 * Math.sin(2 * Math.PI * 3170 * i / FS + 1.1);
  }
  for (i = 2000; i < NA - 1200; i += 2200) xi[i] += 0.9;
  var count = 0;
  var r2 = run(xi, { frame: 'adaptive' }, FS, function (ev) {
    if (ev.type === 'switch') count++;
  });
  t.ok(count >= 4, 'schedule actually switched (switches=' + count + ')');
  var w = worstDiff(xi, r2.y, 2048, NA - 4096);
  t.ok(w.w < 1e-7, 'adaptive identity (worst ' + w.w.toExponential(2) + ' at ' + w.at + ')');
});

t.test('bypass: frame mode switched mid-stream stays an identity', function () {
  var eng = P.createEngine(FS, { defaults: RD.DEFAULTS });
  var d = eng.params;
  d.budget = 1; d.lock = 0; d.frame = 'long';
  var y = new Float32Array(N);
  var emitted = 0, pos = 0;
  var a = new Float32Array(CHUNK), oa = new Float32Array(CHUNK);
  var rin = new Float32Array(CHUNK), rout = new Float32Array(CHUNK);
  while (pos < N + 4096) {
    var n = Math.min(CHUNK, N + 4096 - pos);
    // flip the mode every 4000 samples: long -> short -> adaptive -> long
    d.frame = ['long', 'short', 'adaptive', 'long'][Math.floor(pos / 4000) % 4];
    for (var j = 0; j < n; j++) a[j] = pos + j < N ? x[pos + j] : 0;
    var give = eng.process(a, rin, oa, rout, n);
    for (j = 0; j < give; j++) if (emitted + j < N) y[emitted + j] = oa[j];
    emitted += give;
    pos += n;
  }
  var w = worstDiff(x, y, INTERIOR[0], INTERIOR[1]);
  t.ok(w.w < 1e-7, 'mid-stream identity (worst ' + w.w.toExponential(2) + ' at ' + w.at + ')');
});

t.test('bypass: latency is the expected frame hop, not W-1', function () {
  var r = run(x, { frame: 'long' });
  // run() feeds N + 4096 samples; the engine holds ~one hop in flight, so the
  // unemitted residue should be close to the hop, nowhere near W-1
  var backlog = (N + 4096) - r.emitted;
  t.ok(backlog > 512 && backlog < 4096,
    'output backlog ' + backlog + ' samples (expected ~1024, W-1 would be 2047)');
  // the first emitted hop is the warm-up (one covering frame, w^2 only) — it
  // is NOT an exact copy; the identity begins at the second hop
  var w = worstDiff(x, r.y, 1024, 2048);
  t.ok(w.w < 1e-7, 'second hop onward is exact (worst ' + w.w.toExponential(2) + ')');
});

t.test('bypass at 44100 Hz', function () {
  var r = run(x, { frame: 'long' }, 44100);
  var w = worstDiff(x, r.y, INTERIOR[0], INTERIOR[1]);
  t.ok(w.w < 1e-7, '44.1k identity (worst ' + w.w.toExponential(2) + ' at ' + w.at + ')');
});

t.test('full modify path at full budget is nearly an identity', function () {
  // budget must stay BELOW the 0.999 bypass threshold or isBypass takes the
  // fast path and this test proves nothing. Tone-only signal: a noise bed
  // would have its high bands starved (the masking model's designed loss, as
  // heavy as 1-bit quantize) and dominate the error for reasons this test is
  // not about. The engine eases params from defaults over ~13 frames, so
  // prime with silence and measure steady state. Gate is "small error".
  var PRIME = 20480;
  var xt = new Float32Array(N);
  for (var i = 0; i < N; i++) {
    xt[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / FS) +
            0.3 * Math.sin(2 * Math.PI * 3170 * i / FS + 1.1);
  }
  var xp = new Float32Array(PRIME + N);
  for (i = 0; i < N; i++) xp[PRIME + i] = xt[i];
  var r = run(xp, { frame: 'long', level: 40, budget: 0.998 });
  // skip the post-onset allocator convergence: sm eases up from its silent
  // value for ~10 frames, quantizing coarsely while it does
  var w = worstDiff(xp, r.y, PRIME + 10240, PRIME + N - 4096);
  t.ok(w.w < 0.02, 'high-budget modify path near-identity (worst ' + w.w.toExponential(2) + ' at ' + w.at + ')');
});

console.log(t.pass + '/' + (t.pass + t.fail) + ' tests pass, ' + t.checks + ' checks');
process.exit(t.fail > 0 ? 1 : 0);