// worklet-effect.js — AudioWorkletProcessor 'redistribution-effect'.
//
// NOT standalone: app.js fetches pipeline.js + params.js + this file and
// concatenates them into one Blob URL for addModule — the AudioWorklet
// global scope has neither importScripts nor module imports. This file
// therefore assumes RDPipeline and RDParams are already on the global.
//
// One instance of this processor serves the whole page: every source (loop
// player, synth, mic) sums into it, so Gravity/Memory/Hunt state is shared
// across everything — that sharing is the musical point (VISION).
//
// Params arrive by postMessage and go straight into engine.params; the
// engine smooths them per frame boundary itself (alpha 0.5), so the worklet
// never interpolates. The main thread applies the voice-count budget scaling
// before sending `budget`.
'use strict';
(function () {
  var FS_GUESS = sampleRate; // AudioWorkletGlobalScope provides sampleRate

  class RedistributionEffect extends AudioWorkletProcessor {
    constructor(options) {
      super();
      // input recording must cover the very first quantum to be useful (the
      // engine's OLA frame grid is not translation-invariant), so it is set
      // at construction via processorOptions, not by a later message
      var po = options && options.processorOptions;
      this.eng = RDPipeline.createEngine(FS_GUESS, { defaults: RDParams.DEFAULTS });
      this.tapsOn = false;
      this.tapEvery = 1;          // post every Nth frame
      this.tapCount = 0;
      // Emission buffer: the engine may emit fewer samples than the output
      // quantum on a given call (its OLA ring is bursty at frame completion).
      // The offline worker path concatenates those partial emissions into one
      // contiguous stream; carrying the remainder here (instead of
      // zero-padding the quantum) keeps the live output sample-identical to
      // it. Only genuine starvation (startup fill) pads zeros.
      this.pendL = new Float32Array(4096);
      this.pendR = new Float32Array(4096);
      this.pendN = 0;
      this.pendStart = 0;
      this.sL = null; this.sR = null; this.sN = 0;
      this.primed = false;
      this.shortEmits = 0;        // starved quanta after the buffer first filled
      this.deferred = 0;          // samples zero-padded because of it
      this.inTotal = 0;           // samples fed to the engine
      this.firstIn = -1;          // engine-input index of first loud sample
      this.firstOut = -1;         // emitted index of first loud sample
      // full input recording (selftest only): when enabled, every quantum's
      // summed input — null buses included, as zeros, so the recording is the
      // engine's exact input stream — is kept for a 'flush-input' pull
      this.recIn = !!(po && po.recordInput);
      this.inRecL = [];
      this.inRecR = [];
      var self = this;
      this.eng.onFrame = function (info) {
        if (!self.tapsOn) return;
        if (++self.tapCount % self.tapEvery) return;
        var eng = self.eng;
        self.port.postMessage({
          type: 'taps',
          bandsE: new Float32Array(eng.bandsE),
          edge: new Int32Array(eng.bands.edge),
          destEdge: new Int32Array(eng.destEdge),
          W: info.block,
          fs: FS_GUESS,
          short: info.short,
          stats: { frames: info.stats.frames, longs: info.stats.longs,
            shorts: info.stats.shorts, switches: info.stats.switches },
          latencyMs: (info.block - (info.short ? 256 : 1024)) / FS_GUESS * 1000
        });
      };
      this.port.onmessage = function (e) {
        var m = e.data;
        if (m.type === 'params') {
          for (var k in m.p) self.eng.params[k] = m.p[k];
        } else if (m.type === 'taps') {
          self.tapsOn = !!m.on;
          if (m.every) self.tapEvery = m.every;
        } else if (m.type === 'reset') {
          self.eng.reset();
        } else if (m.type === 'ping') {         // selftest: constructor has run
          self.port.postMessage({ type: 'pong' });
        } else if (m.type === 'record-input') {
          self.recIn = !!m.on;
          if (!m.on) { self.inRecL = []; self.inRecR = []; }
        } else if (m.type === 'flush-input') {
          var L = self.inRecL, R = self.inRecR;
          self.inRecL = []; self.inRecR = [];
          self.port.postMessage({ type: 'input-rec', L: L, R: R },
            L.concat(R).map(function (b) { return b.buffer; }));
        } else if (m.type === 'emit-stats') {
          self.port.postMessage({ type: 'emit-stats',
            shortEmits: self.shortEmits, deferred: self.deferred,
            inTotal: self.inTotal, firstIn: self.firstIn,
            firstOut: self.firstOut, pendN: self.pendN });
        }
      };
    }

    process(inputs, outputs) {
      var out = outputs[0];
      var oL = out[0], oR = out[1] || out[0];
      var n = oL.length;

      // sum every input bus into stereo (all sources share the one engine)
      var inL = null, inR = null;
      var i, ch, bus;
      for (bus = 0; bus < inputs.length; bus++) {
        var ib = inputs[bus];
        if (!ib || ib.length === 0) continue;
        if (!inL) { inL = new Float32Array(n); inR = new Float32Array(n); }
        var bl = ib[0];
        var br = ib[1] || ib[0];
        for (i = 0; i < n; i++) { inL[i] += bl[i]; inR[i] += br[i]; }
        for (ch = 2; ch < ib.length; ch++) {
          var bc = ib[ch];
          for (i = 0; i < n; i++) inR[i] += bc[i];  // extras fold to the right
        }
      }

      var P = this;
      if (!P.sL || P.sN !== n) { P.sL = new Float32Array(n); P.sR = new Float32Array(n); P.sN = n; }
      // first-loud markers, for the selftest's pipeline decomposition
      if (P.firstIn < 0 && inL) {
        for (i = 0; i < n; i++)
          if (inL[i] > 0.01 || inL[i] < -0.01) { P.firstIn = P.inTotal + i; break; }
      }
      P.inTotal += n;
      if (P.recIn) {
        P.inRecL.push(new Float32Array(inL || n));
        P.inRecR.push(new Float32Array(inR || n));
      }
      var give = P.eng.process(inL, inR, P.sL, P.sR, n);
      // append the engine's partial emission to the pending buffer
      if (P.pendStart + P.pendN + give > P.pendL.length) {
        P.pendL.copyWithin(0, P.pendStart, P.pendStart + P.pendN);
        P.pendR.copyWithin(0, P.pendStart, P.pendStart + P.pendN);
        P.pendStart = 0;
      }
      var base = P.pendStart + P.pendN, j;
      for (j = 0; j < give; j++) {
        P.pendL[base + j] = P.sL[j];
        P.pendR[base + j] = P.sR[j];
      }
      P.pendN += give;
      if (P.pendN >= n) P.primed = true;
      // emit exactly n samples from the buffer; pad zeros only if starved
      var k = Math.min(n, P.pendN);
      for (j = 0; j < k; j++) { oL[j] = P.pendL[P.pendStart + j]; oR[j] = P.pendR[P.pendStart + j]; }
      for (; j < n; j++) { oL[j] = 0; oR[j] = 0; }
      if (P.firstOut < 0) {
        for (j = 0; j < n; j++)
          if (oL[j] > 0.01 || oL[j] < -0.01) { P.firstOut = P.inTotal - n + j; break; }
      }
      P.pendStart += k; P.pendN -= k;
      if (P.pendN === 0) P.pendStart = 0;
      if (k < n && P.primed) { P.shortEmits++; P.deferred += n - k; }
      // keep the output bus alive even when silent: returning false with no
      // inputs lets Chrome collect the node — always claim activity while
      // the page owns the instance (it disconnects explicitly)
      return true;
    }
  }
  registerProcessor('redistribution-effect', RedistributionEffect);
})();