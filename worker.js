// worker.js — offline render in a DedicatedWorker: renders a built-in loop
// through the pipeline with the given params and returns the stereo output.
// The selftest compares this against the live worklet's recorded output for
// the same params — they should agree, because both drive the same engine
// with the same 128-sample chunking the engine is chunk-size independent in.
//
// importScripts (not addModule) works here: a Worker global scope has it.
// The ?v= cache-buster propagates — app.js composes these URLs.
'use strict';
// cache-buster from our own URL (?v= set by the page that created us)
const V = (self.location && /v=([^&]+)/.exec(self.location.search) || [])[1] || '1';
importScripts('params.js?v=' + V, 'pipeline.js?v=' + V, 'loops.js?v=' + V);

onmessage = function (e) {
  const m = e.data;
  try {
    if (m.type !== 'render') throw new Error('worker: unknown message ' + m.type);
    const fs = m.fs || 48000;
    const loop = RDLoops.render(m.loop, fs);
    const eng = RDPipeline.createEngine(fs, { defaults: RDParams.DEFAULTS });
    for (const k in m.params) eng.params[k] = m.params[k];
    const lead = m.lead > 0 ? (m.lead | 0) : 0;   // leading silence: matches
    // the live graph's startup lag so the engine's adaptive state (Memory
    // persists through silence) sees the same history as in the selftest
    const N = (m.seconds ? Math.min((m.seconds * fs) | 0, loop.left.length) : loop.left.length) + lead;
    const CH = 1024;
    const aL = new Float32Array(CH), aR = new Float32Array(CH);
    const oL = new Float32Array(CH), oR = new Float32Array(CH);
    const outL = new Float32Array(N), outR = new Float32Array(N);
    let pos = -lead, got = 0, flushed = 0;
    while (pos < N || got < N) {
      let n;
      if (pos < 0) {
        n = Math.min(CH, -pos); aL.fill(0); aR.fill(0); pos += n;
      } else if (pos < N) {
        n = Math.min(CH, N - pos);
        // N is loopLen + lead: past the loop's end (a lead-ed render runs
        // `lead` samples of it) read silence, not out-of-bounds undefined
        for (let j = 0; j < n; j++) {
          const s = pos + j;
          aL[j] = s < loop.left.length ? loop.left[s] : 0;
          aR[j] = s < loop.right.length ? loop.right[s] : 0;
        }
        pos += n;
      } else {
        n = CH; aL.fill(0); aR.fill(0);
        if (++flushed > 4096) break;
      }
      const give = eng.process(aL, aR, oL, oR, n);
      for (let j = 0; j < give && got < N; j++) { outL[got + j] = oL[j]; outR[got + j] = oR[j]; }
      got += give;
    }
    postMessage({ id: m.id, ok: true, left: outL, right: outR, fs: fs,
      stats: eng.stats }, [outL.buffer, outR.buffer]);
  } catch (err) {
    postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
  }
};