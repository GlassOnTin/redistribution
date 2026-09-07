// selftest.js — in-browser ladder. Drives the real page pieces in the real
// browser and reports pass/fail per rung:
//   1. AudioContext comes up.
//   2. The blob-composed worklet module (pipeline + params + effect +
//      recorder) registers.
//   3. The effect processes a loop non-silently and finitely.
//   4. The same params through worker.js (offline) match the live worklet's
//      recorded output sample-for-sample after alignment.
// Rung 4 is the M2 gate: live spectrogram/audible path and offline render are
// the same engine doing the same thing.
'use strict';
const out = document.getElementById('out');
const log = (s) => { document.getElementById('log').textContent += s + '\n'; };
function step(name, fn) {
  const row = document.createElement('div');
  row.className = 'step';
  row.textContent = '… ' + name;
  out.appendChild(row);
  return fn().then((msg) => {
    row.textContent = 'ok  ' + name + (msg ? ' — ' + msg : '');
    row.className = 'step ok';
  }, (e) => {
    row.textContent = 'FAIL ' + name + ' — ' + (e && e.message || e);
    row.className = 'step bad';
    throw e;
  });
}

const PARAMS = { budget: 0.6, gravity: 0.5, memory: 2, hunt: 0.25, lock: 0,
  frame: 'long', mask: 'drop' };
const LOOP = 'sweep', SECS = 2;

let ctx, fs;
let recInNode = null;
let recordedIn = [];   // pre-effect capture, filled in rung 3
// dev tool: default the cache-buster to fresh-per-load so worklet/worker
// edits are picked up without a manual ?v= bump (deployed pages use ?v=)
const V = new URLSearchParams(location.search).get('v') || String(Date.now());
let effectNode, recNode, recorded = [];   // shared with offlineCompare()

async function run() {
  document.getElementById('log').textContent = '';
  out.textContent = '';
  recorded = [];
  recordedIn = [];
  recInNode = null;

  // selftest.html loads these as classic script tags with no cache-buster;
  // a stale cached copy would make the main-thread engine differ from the
  // worklet blob and the worker (both use ?v=). Re-eval the fetched text so
  // all three run the same bytes.
  for (const f of ['params.js', 'pipeline.js', 'loops.js']) {
    const r = await fetch(f + '?v=' + V);
    if (!r.ok) throw new Error(f + ': HTTP ' + r.status);
    (0, eval)(await r.text());
  }

  await step('AudioContext starts', async () => {
    // pin 48000: this workstation's device runs 192000, where the quantum
    // deadline is 667 us and the engine (benched at 48k budgets) overruns it
    // — Chrome backs up the worklet's input FIFO and delivery drifts. Every
    // ordinary device is 44.1/48k; Chrome resamples the hardware stream.
    ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    await ctx.resume();
    fs = ctx.sampleRate;
    return fs + ' Hz';
  });

  await step('worklet module registers from Blob', async () => {
    const texts = [];
    for (const f of ['pipeline.js', 'params.js', 'worklet-effect.js']) {
      const r = await fetch(f + '?v=' + V);
      if (!r.ok) throw new Error(f + ': HTTP ' + r.status);
      texts.push(await r.text());
    }
    // recorder processor, only for the selftest
    texts.push(`
      class Rec extends AudioWorkletProcessor {
        constructor(){ super(); this.buf = [];
          this.port.onmessage = (e) => {
            if (e.data.type === 'flush') {
              this.port.postMessage({ type: 'flushed', data: this.buf }, this.buf.map(b => b.buffer));
              this.buf = [];
            }
          };
        }
        process(inputs){ const ch = inputs[0][0];
          if (ch && ch.length) this.buf.push(new Float32Array(ch)); return true; }
      }
      registerProcessor('selftest-recorder', Rec);`);
    const url = URL.createObjectURL(new Blob(texts, { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
  });

  await step('effect renders a loop through the live graph', async () => {
    effectNode = new AudioWorkletNode(ctx, 'redistribution-effect', {
      numberOfInputs: 4, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { recordInput: true } });
    recNode = new AudioWorkletNode(ctx, 'selftest-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    recInNode = new AudioWorkletNode(ctx, 'selftest-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    recNode.port.onmessage = (e) => {
      if (e.data.type === 'flushed') for (const b of e.data.data) recorded.push(b);
    };
    recInNode.port.onmessage = (e) => {
      if (e.data.type === 'flushed') for (const b of e.data.data) recordedIn.push(b);
    };
    // the engine's input recording is on from construction (processorOptions)
    // — a parallel recorder node is not a faithful proxy for the effect's
    // input timeline, and the engine's frame grid is not translation-invariant
    const mute = ctx.createGain();
    mute.gain.value = 0;                        // pull the graph, stay silent
    effectNode.connect(recNode); recNode.connect(mute); mute.connect(ctx.destination);
    // the input recorder needs its own pull path — a worklet with no
    // downstream connection is not guaranteed a quantum every render tick
    const muteIn = ctx.createGain();
    muteIn.gain.value = 0;
    recInNode.connect(muteIn); muteIn.connect(ctx.destination);
    effectNode.port.postMessage({ type: 'params',
      p: Object.assign({}, RDParams.DEFAULTS, PARAMS) });
    const loop = RDLoops.render(LOOP, fs);
    const buf = ctx.createBuffer(2, loop.left.length, fs);
    buf.copyToChannel(loop.left, 0);
    buf.copyToChannel(loop.right, 1);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.connect(effectNode);
    src.connect(recInNode);                     // capture the effect's input too
    // warm the graph before starting: the effect's constructor runs on the
    // audio thread some quanta after node creation, and a source started
    // before that lands in a partially-primed input FIFO (delivery offset
    // varies run to run). A port round-trip proves the processor exists; the
    // settle delay lets all three nodes pull a steady stream of silence.
    await new Promise((res) => {
      effectNode.port.onmessage = (e) => { if (e.data.type === 'pong') res(); };
      effectNode.port.postMessage({ type: 'ping' });
    });
    await new Promise((res) => setTimeout(res, 100));
    src.start();
    await new Promise((res) => setTimeout(res, (SECS + 0.2) * 1000));
    src.stop(); src.disconnect();
    recNode.port.postMessage({ type: 'flush' });
    recInNode.port.postMessage({ type: 'flush' });
    await new Promise((res) => { const w = (e) => {
      if (e.data.type === 'flushed') { recNode.port.onmessage = null; res(); } };
      recNode.port.addEventListener('message', w); });
    await new Promise((res) => { const w = (e) => {
      if (e.data.type === 'flushed') { recInNode.port.onmessage = null; res(); } };
      recInNode.port.addEventListener('message', w); });
    const total = recorded.reduce((a, b) => a + b.length, 0);
    if (total < fs) throw new Error('recorded only ' + total + ' samples');
    // engine emission health: quanta where the engine gave fewer samples than
    // the output quantum (zero-padded into the stream, deferred to later)
    const emitStats = await new Promise((res) => {
      const h = effectNode.port.onmessage;
      effectNode.port.onmessage = (e) => {
        if (e.data.type === 'emit-stats') { effectNode.port.onmessage = h; res(e.data); }
      };
      effectNode.port.postMessage({ type: 'emit-stats' });
    });
    window.__rdEmit = emitStats;   // keep the first pull for later rungs
    if (emitStats.shortEmits > 0)
      throw new Error('engine emitted short on ' + emitStats.shortEmits +
        ' quanta (' + emitStats.deferred + ' samples zero-padded/deferred)');
    let bad = 0;
    for (const b of recorded) for (let i = 0; i < b.length; i++)
      if (!isFinite(b[i])) { bad++; break; }
    if (bad) throw new Error(bad + ' non-finite blocks');
    let peak = 0;
    for (const b of recorded) for (let i = 0; i < b.length; i++)
      if (Math.abs(b[i]) > peak) peak = Math.abs(b[i]);
    if (peak < 0.01) throw new Error('output near-silent (peak ' + peak + ')');
    return (total / fs).toFixed(2) + ' s recorded, peak ' + peak.toFixed(3);
  });

  await step('offline worker.js render matches the live output',
    () => offlineCompare());

  document.getElementById('log').textContent += '\nALL RUNGS GREEN';
}

async function offlineCompare() {
  // uses the module PARAMS — the same set rung 3 sent the live engine; a
  // local copy here once shadowed it with lock at its DEFAULT (0.5) and the
  // phase integrator made every comparison fail at full scale
  const live = concatFloat32(recorded);
  const liveIn = concatFloat32(recordedIn);
  const loop = RDLoops.render(LOOP, fs);

  // (a) BufferSource passthrough: the parallel recorder's capture must equal
  // the loop samples bit-for-bit after the graph's startup lag. Its lag is
  // measured on the recorder itself — the effect node's input arrives on a
  // different timeline (different node, different FIFO), so this lag is NOT
  // the engine's; (b) measures that one from the engine's own recording.
  const firstLoud = (x) => {
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.01) return i;
    return x.length;
  };
  const recLag = firstLoud(liveIn) - firstLoud(loop.left);
  let srcWorst = 0, srcAt = -1;
  const srcHi = Math.min(liveIn.length, recLag + loop.left.length) - 4096;
  for (let i = recLag; i < srcHi; i++) {
    const d = Math.abs(liveIn[i] - loop.left[i - recLag]);
    if (d > srcWorst) { srcWorst = d; srcAt = i; }
  }
  // 1e-9 not 0: graph delivery has shown denormal-level dust at stream start
  if (srcWorst > 1e-9) {
    window.__rdFail = { lag: recLag, at: srcAt, fs: fs,
      liveIn: Array.from(liveIn.slice(srcAt - 512, srcAt + 512)),
      loop: Array.from(loop.left.slice(srcAt - recLag - 512, srcAt - recLag + 512)) };
    throw new Error('BufferSource is not bit-exact: worst ' +
      srcWorst.toExponential(2) + ' at ' + srcAt + ' (lag ' + recLag + ')' +
      '; stashed on window.__rdFail');
  }

  // (b) live engine state: feed the engine's own recorded input into a fresh
  // main-thread engine with the same params — the output must equal the live
  // capture. The recording IS the engine's exact input stream (null-input
  // quanta as zeros), so no timeline inference is involved.
  const engInRec = await new Promise((res) => {
    const h = effectNode.port.onmessage;
    effectNode.port.onmessage = (e) => {
      if (e.data.type === 'input-rec') { effectNode.port.onmessage = h; res(e.data); }
    };
    effectNode.port.postMessage({ type: 'flush-input' });
  });
  const engInL = concatFloat32(engInRec.L);
  const engInR = concatFloat32(engInRec.R);
  // the engine's own input lag: where the loop's first sample lands in the
  // stream the engine actually consumed. Measured on this recording, not on
  // the parallel recorder's — the two nodes' input timelines differ by a
  // few hundred samples and the engine's state follows its own stream.
  const inLag = firstLoud(engInL) - firstLoud(loop.left);
  const eng = RDPipeline.createEngine(fs, { defaults: RDParams.DEFAULTS });
  for (const k in PARAMS) eng.params[k] = PARAMS[k];
  const CH = 128;
  const aL = new Float32Array(CH), aR = new Float32Array(CH);
  const oL = new Float32Array(CH), oR = new Float32Array(CH);
  const local = new Float32Array(engInL.length + CH * 64);
  let pos = 0, got = 0, flushed = 0;
  while (pos < engInL.length || got < live.length) {
    let n;
    if (pos < engInL.length) {
      n = Math.min(CH, engInL.length - pos);
      for (let j = 0; j < n; j++) { aL[j] = engInL[pos + j]; aR[j] = engInR[pos + j]; }
      pos += n;
    } else {
      n = CH; aL.fill(0); aR.fill(0);
      if (++flushed > 64) break;
    }
    const give = eng.process(aL, aR, oL, oR, n);
    for (let j = 0; j < give && got < local.length; j++) local[got + j] = oL[j];
    got += give;
  }
  let liveLoud = firstLoud(live), localLoud = firstLoud(local);
  let d0 = liveLoud - localLoud;
  // The live emission stream cannot be sample-identical to the offline
  // accumulation: the worklet must emit a full quantum every call, so the
  // engine's startup emission debt is inserted as real zeros and the stream
  // sits at a constant offset (d0) that the offline render compresses out.
  // On top of that the live capture is hardware-clocked (resampled from the
  // device rate) and drifts a few hundred ppm against the offline render.
  // So: per-4096-segment comparison with local ±64-sample realignment, the
  // same structure as (c). Real engine differences survive at full scale.
  const SEGB = 4096;
  const bLo = Math.max(0, liveLoud - 4096);
  const bHi = Math.min(live.length, local.length - Math.max(0, d0)) - SEGB;
  let engWorst = 0, engAt = -1, bSegs = 0;
  for (let s0 = bLo; s0 + SEGB <= bHi; s0 += SEGB) {
    let e0 = 0;
    for (let i = s0; i < s0 + SEGB; i += 8) e0 += live[i] * live[i];
    if (Math.sqrt(e0 / (SEGB / 8)) < 0.01) continue;
    let bestD = Infinity, bestS = 0;
    for (let s = -64; s <= 64; s++) {
      let dd = 0, cnt = 0;
      for (let i = s0; i < s0 + SEGB; i += 8) {
        const j = i - d0 + s;
        if (j < 0 || j >= local.length) continue;
        dd += Math.abs(live[i] - local[j]); cnt++;
      }
      if (cnt && dd / cnt < bestD) { bestD = dd / cnt; bestS = s; }
    }
    bSegs++;
    if (bestD > engWorst) { engWorst = bestD; engAt = s0; }
  }
  if (!bSegs) throw new Error('no loud segments to compare in (b)');
  if (engWorst > 1e-3) {
    const emitStats = await new Promise((res) => {
      const h = effectNode.port.onmessage;
      effectNode.port.onmessage = (e) => {
        if (e.data.type === 'emit-stats') { effectNode.port.onmessage = h; res(e.data); }
      };
      effectNode.port.postMessage({ type: 'emit-stats' });
    });
    window.__rdFail = { emit: emitStats, inLag: inLag, d0: d0, at: engAt,
      live: Array.from(live.slice(engAt, engAt + 2048)),
      local: Array.from(local.slice(engAt - d0, engAt - d0 + 2048)),
      engIn: Array.from(engInL.slice(engAt - d0 + 2048,
        engAt - d0 + 2048 + 2048)) };
    throw new Error('live engine != fresh engine on the same ' +
      'input: segment residual ' + engWorst.toExponential(2) + ' at ' + engAt +
      ' (onset delta ' + d0 + ', liveLoud ' + liveLoud + ', localLoud ' + localLoud +
      ', inLag ' + inLag + ', ' + bSegs + ' segments' +
      '; worklet firstIn ' + emitStats.firstIn + ', firstOut ' + emitStats.firstOut +
      ', inTotal ' + emitStats.inTotal + ', pendN ' + emitStats.pendN + ')');
  }

  // (c) cross-implementation: the worker render must match the live capture
  // too. The engine's adaptive state (Memory persists through silence by
  // design) makes the length of leading silence part of the output, so the
  // worker must see the same input history as the live engine: inLag samples
  // of silence, then the loop. (Equalising on output onsets instead once
  // over-silenced the worker engine by d0 — the emission-debt zeros in the
  // live stream — and the allocation diverged from there on.)
  const worker = new Worker('worker.js?v=' + V);
  const ask = (msg) => new Promise((res) => {
    worker.onmessage = (e) => res(e.data);
    worker.postMessage(msg);
  });
  const m = await ask({ type: 'render', loop: LOOP, fs: fs, seconds: SECS,
    params: PARAMS, lead: inLag });
  worker.terminate();
  if (!m.ok) throw new Error('worker render failed: ' + m.error);
  const off = m.left;

  // live = compressed render shifted by d0 (the emission-debt zeros) plus
  // hardware-clock drift, so: per-4096-sample segment comparison with local
  // ±64-sample re-alignment, the same structure as (b). Real engine
  // differences (different warp, different allocation) survive local
  // alignment at full scale; clock drift is absorbed by it. Near-silent
  // segments are skipped — the onset edge has nothing to compare.
  const SEG = 4096;
  const lo = Math.max(0, liveLoud - 4096);
  const hi = Math.min(live.length, off.length - Math.max(0, d0)) - SEG;
  let worstRes = 0, worstAt = -1, sMin = Infinity, sMax = -Infinity, segs = 0;
  for (let s0 = lo; s0 + SEG <= hi; s0 += SEG) {
    let e0 = 0;
    for (let i = s0; i < s0 + SEG; i += 8) e0 += live[i] * live[i];
    if (Math.sqrt(e0 / (SEG / 8)) < 0.01) continue;    // near-silent segment
    let bestD = Infinity, bestS = 0;
    for (let s = -64; s <= 64; s++) {
      let d = 0, cnt = 0;
      for (let i = s0; i < s0 + SEG; i += 8) {
        const j = i - d0 + s;
        if (j < 0 || j >= off.length) continue;
        d += Math.abs(live[i] - off[j]); cnt++;
      }
      if (cnt && d / cnt < bestD) { bestD = d / cnt; bestS = s; }
    }
    segs++;
    if (bestS < sMin) sMin = bestS;
    if (bestS > sMax) sMax = bestS;
    if (bestD > worstRes) { worstRes = bestD; worstAt = s0; }
  }
  if (!segs) throw new Error('no segments loud enough to compare');
  if (worstRes > 1e-3) {
    // isolate the failure: a main-thread reference render of the same
    // synthetic input (silence + loop). If the worker matches this but the
    // live capture does not, the live engine's input stream is not the
    // silence+loop we assumed; if the worker does not match it either, the
    // divergence is in the worker context itself.
    const ref = (() => {
      const eng = RDPipeline.createEngine(fs, { defaults: RDParams.DEFAULTS });
      for (const k in PARAMS) eng.params[k] = PARAMS[k];
      const CH = 128;
      const aL = new Float32Array(CH), aR = new Float32Array(CH);
      const oL = new Float32Array(CH), oR = new Float32Array(CH);
      const out = new Float32Array(off.length + CH * 64);
      let pos = 0, got = 0, flushed = 0;
      while (pos < off.length || got < out.length) {
        let n;
        if (pos < off.length) {
          n = Math.min(CH, off.length - pos);
          for (let j = 0; j < n; j++) { const s = pos + j - inLag;
            aL[j] = s >= 0 && s < loop.left.length ? loop.left[s] : 0;
            aR[j] = aL[j]; }
          pos += n;
        } else { n = CH; aL.fill(0); aR.fill(0); if (++flushed > 64) break; }
        const give = eng.process(aL, aR, oL, oR, n);
        for (let j = 0; j < give && got < out.length; j++) out[got + j] = oL[j];
        got += give;
      }
      return out.subarray(0, got);
    })();
    let refWorst = 0, refAt = -1;
    for (let i = 0; i < Math.min(ref.length, off.length); i++) {
      const d = Math.abs(ref[i] - off[i]);
      if (d > refWorst) { refWorst = d; refAt = i; }
    }
    // and diff the engine's recorded input against the synthetic one —
    // locates any delivery dropout/duplication in the live graph
    const refIn = new Float32Array(Math.min(engInL.length, off.length + 8192));
    for (let i = inLag; i < refIn.length; i++) {
      const s = i - inLag;
      refIn[i] = s < loop.left.length ? loop.left[s] : 0;
    }
    let inWorst = 0, inAt = -1, inNeq = 0;
    for (let i = 0; i < refIn.length; i++) {
      const d = Math.abs(engInL[i] - refIn[i]);
      if (d > inWorst) { inWorst = d; inAt = i; }
      if (engInL[i] !== refIn[i]) inNeq++;
    }
    // stash the worst segment for offline analysis from the console/agent
    let bS = 0, bD = Infinity;
    for (let s = -64; s <= 64; s++) {
      let d = 0, cnt = 0;
      for (let i = worstAt; i < worstAt + SEG; i += 8) {
        const j = i - d0 + s;
        if (j < 0 || j >= off.length) continue;
        d += Math.abs(live[i] - off[j]); cnt++;
      }
      if (cnt && d / cnt < bD) { bD = d / cnt; bS = s; }
    }
    window.__rdFail = {
      lead: inLag, d0: d0, fs: fs, worstAt: worstAt, shift: bS,
      refWorst: refWorst, refAt: refAt, inWorst: inWorst, inAt: inAt,
      inNeq: inNeq,
      live: Array.from(live.slice(worstAt, worstAt + 2048)),
      off: Array.from(off.slice(worstAt - d0 + bS, worstAt - d0 + bS + 2048)),
    };
    throw new Error('live vs offline residual ' + worstRes.toExponential(2) +
      ' at ' + worstAt + ' (' + (worstAt / fs).toFixed(3) + ' s) after local' +
      ' alignment (lead ' + inLag + ', d0 ' + d0 + ', ' + segs + ' segments' +
      ', best shift ' + bS + '; ref-vs-off worst ' + refWorst.toExponential(2) +
      ' at ' + refAt + '; engIn-vs-synthetic worst ' + inWorst.toExponential(2) +
      ' at ' + inAt + ', ' + inNeq + ' samples); segment stashed on' +
      ' window.__rdFail');
  }
  return 'residual ' + worstRes.toExponential(2) + ' over ' + segs +
    ' segments (lead ' + inLag + ', d0 ' + d0 + ', clock drift ' + sMin +
    '..' + sMax + ' samples)';
}

function concatFloat32(arr) {
  const n = arr.reduce((a, b) => a + b.length, 0);
  const o = new Float32Array(n);
  let p = 0;
  for (const b of arr) { o.set(b, p); p += b.length; }
  return o;
}

document.getElementById('run').addEventListener('click', () => {
  run().catch(() => {});
});