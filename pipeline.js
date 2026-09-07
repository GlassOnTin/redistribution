// pipeline.js — the algorithm.
// Dual-loaded: worklets compose it into a blob URL (classic script),
// worker.js importScripts it, node requires it. No DOM, no Web Audio API,
// no unseeded Math.random — the PRNG is seeded so node and browser produce
// identical allocator dither for the same input.
//
// Transform note (VISION.md correction 1): analysis is the plain complex DFT
// of the sine-windowed block. Its real/imag parts play the MDCT/MDST roles;
// keeping phase is what makes Lock, Mask=hide and the gravity fold defined
// at all. TDAC reconstruction is exact for hop = W/2 across the whole legal
// window family, so a neutral parameter set is an exact identity, not an
// approximation.
(function (root) {
  'use strict';

  // ---------- deterministic PRNG (mulberry32) ----------
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- iterative radix-2 FFT, precomputed tables, no allocation ----------
  function makeFFT(n) {
    var levels = Math.round(Math.log2(n));
    if ((1 << levels) !== n) throw new Error('FFT size must be a power of two');
    var cosT = new Float64Array(n / 2), sinT = new Float64Array(n / 2);
    for (var i = 0; i < n / 2; i++) {
      cosT[i] = Math.cos(2 * Math.PI * i / n);
      sinT[i] = Math.sin(2 * Math.PI * i / n);
    }
    var rev = new Uint32Array(n);
    for (var j = 0; j < n; j++) {
      var r = 0, x = j;
      for (var b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[j] = r;
    }
    function transform(re, im, inverse) {
      for (var i = 0; i < n; i++) {
        var jj = rev[i];
        if (jj > i) {
          var t = re[i]; re[i] = re[jj]; re[jj] = t;
          t = im[i]; im[i] = im[jj]; im[jj] = t;
        }
      }
      for (var size = 2; size <= n; size <<= 1) {
        var half = size >> 1, step = n / size;
        for (var off = 0; off < n; off += size) {
          for (var p = off, k = 0; p < off + half; p++, k += step) {
            var q = p + half;
            var c = cosT[k], s = inverse ? sinT[k] : -sinT[k];
            var xr = re[q] * c - im[q] * s;
            var xi = re[q] * s + im[q] * c;
            re[q] = re[p] - xr; im[q] = im[p] - xi;
            re[p] += xr; im[p] += xi;
          }
        }
      }
      if (inverse) {
        var inv = 1 / n;
        for (var m = 0; m < n; m++) { re[m] *= inv; im[m] *= inv; }
      }
    }
    return {
      forward: function (re, im) { transform(re, im, false); },
      inverse: function (re, im) { transform(re, im, true); }
    };
  }

  // ---------- windows (TDAC family) ----------
  function sineWindow(W) {
    var w = new Float64Array(W);
    for (var n = 0; n < W; n++) w[n] = Math.sin(Math.PI * (n + 0.5) / W);
    return w;
  }
  // START: left half pairs with the preceding LONG, first quarter of the right
  // half pairs with the first SHORT, the rest is zero (shorts own that span).
  function startWindow() {
    var W = 2048, w = new Float64Array(W), n;
    for (n = 0; n < 1024; n++) w[n] = Math.sin(Math.PI * (n + 0.5) / 2048);
    for (n = 1024; n < 1280; n++) w[n] = Math.cos(Math.PI * (n - 1024 + 0.5) / 512);
    for (n = 1280; n < W; n++) w[n] = 0;
    return w;
  }
  // STOP: first quarter pairs with the last SHORT, the flat region is owned
  // alone, the right half pairs with the next LONG.
  function stopWindow() {
    var W = 2048, w = new Float64Array(W), n;
    for (n = 0; n < 256; n++) w[n] = Math.sin(Math.PI * (n + 0.5) / 512);
    for (n = 256; n < 1024; n++) w[n] = 1;
    for (n = 1024; n < W; n++) w[n] = Math.sin(Math.PI * (n + 0.5) / 2048);
    return w;
  }

  // ---------- bands ----------
  var BARK_EDGES_HZ = [0, 100, 200, 300, 400, 510, 630, 770, 920, 1080, 1270,
    1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400, 5300, 6400, 7700, 9500,
    12000, 15500];
  var MAX_BAND_BINS = 100, MAX_BITS_PER_BAND = 15;

  function buildBands(fs, K, W) {
    var dF = fs / W;
    var edges = [1];
    for (var i = 1; i < BARK_EDGES_HZ.length; i++) {
      var bin = Math.ceil(BARK_EDGES_HZ[i] / dF);
      if (bin > edges[edges.length - 1] && bin < K) edges.push(bin);
    }
    edges.push(K);
    var out = [edges[0]];
    for (var j = 0; j < edges.length - 1; j++) {
      var lo = edges[j], hi = edges[j + 1], width = hi - lo;
      if (width > MAX_BAND_BINS) {
        var parts = Math.ceil(width / MAX_BAND_BINS), w = width / parts;
        for (var p = 1; p < parts; p++) {
          var b = Math.round(lo + p * w);
          if (b > out[out.length - 1] && b < hi) out.push(b);
        }
      }
      out.push(hi);
    }
    return { edge: Int32Array.from(out) };
  }
  function bandCount(b) { return b.edge.length - 1; }

  function barkOf(f) {
    return 13 * Math.atan(0.00076 * f) + 3.5 * Math.atan((f / 7500) * (f / 7500));
  }
  function ath(f) {
    var fk = f / 1000;
    var v = 3.64 * Math.pow(fk, -0.8) - 6.5 * Math.exp(-0.6 * (fk - 3.3) * (fk - 3.3)) + 1e-3 * fk * fk * fk * fk;
    return Math.min(95, Math.max(-5, v));
  }

  // Fold-weight profile per band, r in [0,1] rising across the spectrum.
  function foldWeights(bands, fs, K, W, curve, power) {
    var B = bandCount(bands), dF = fs / W;
    var fLo = 1 * dF, fHi = (K - 1) * dF;
    var r = new Float32Array(B);
    for (var j = 0; j < B; j++) {
      var f = ((bands.edge[j] + bands.edge[j + 1]) / 2) * dF;
      var v;
      if (curve === 'bark') v = (barkOf(f) - barkOf(fLo)) / (barkOf(fHi) - barkOf(fLo) + 1e-12);
      else if (curve === 'power') v = Math.pow(f / fHi, power);
      else v = f / fHi;
      r[j] = Math.min(1, Math.max(0, v));
    }
    return r;
  }

  // Overlap map: for each short band, the [longIdx, weight] pairs covering it.
  function buildLongShortMap(bandsL, bandsS) {
    var BL = bandCount(bandsL), BS = bandCount(bandsS);
    var map = new Array(BS);
    for (var s = 0; s < BS; s++) {
      var lo = bandsS.edge[s], hi = bandsS.edge[s + 1], list = [], tot = 0;
      for (var l = 0; l < BL; l++) {
        var o = Math.min(hi, bandsL.edge[l + 1]) - Math.max(lo, bandsL.edge[l]);
        if (o > 0) { list.push([l, o]); tot += o; }
      }
      for (var q = 0; q < list.length; q++) list[q][1] /= (tot || 1);
      map[s] = list;
    }
    return map;
  }

  // Bypass fast path: every mechanism neutral -> the transform chain is an
  // exact identity, so modification is skipped entirely. Kept local so
  // pipeline.js stays load-order independent of params.js.
  function isBypass(P) {
    return P.budget >= 0.999 && P.gravity <= 1e-6 && P.mask !== 'hide' &&
      P.intensity <= 1e-6 && P.lock <= 1e-6 &&
      Math.abs(P.tiltLow) < 1e-6 && Math.abs(P.tiltMid) < 1e-6 &&
      Math.abs(P.tiltHigh) < 1e-6;
  }

  // ---------- the engine ----------
  function createEngine(fs, opts) {
    opts = opts || {};
    var rng = opts.rng || mulberry32(0x5eed11);

    var W_L = 2048, H_L = 1024, K_L = W_L >> 1;
    var W_S = 512, H_S = 256, K_S = W_S >> 1;
    var fftL = makeFFT(W_L), fftS = makeFFT(W_S);
    var winL = sineWindow(W_L), winS = sineWindow(W_S);
    var winSTART = startWindow(), winSTOP = stopWindow();
    var bandsL = buildBands(fs, K_L, W_L), bandsS = buildBands(fs, K_S, W_S);
    var BL = bandCount(bandsL), BS = bandCount(bandsS);
    var lsMap = buildLongShortMap(bandsL, bandsS);
    var MAX_BITS = BL * MAX_BITS_PER_BAND;

    var P = {}; // live params — the caller mutates engine.params directly
    var DEFAULTS = opts.defaults || {};
    for (var dk in DEFAULTS) P[dk] = DEFAULTS[dk];

    var sm = new Float64Array(BL);            // hunt-smoothed demand, long grid
    var wMap = new Float64Array(BL);          // Memory: starved-band map
    var bitsL = new Int32Array(BL), bitsS = new Int32Array(BS);
    var starvedLong = new Uint8Array(BL), starvedShort = new Uint8Array(BS);
    var corrL = new Float64Array(BL), corrS = new Float64Array(BS);
    var prevA = {
      long: [{ re: new Float64Array(K_L + 1), im: new Float64Array(K_L + 1), ok: new Uint8Array(K_L + 1) },
             { re: new Float64Array(K_L + 1), im: new Float64Array(K_L + 1), ok: new Uint8Array(K_L + 1) }],
      short: [{ re: new Float64Array(K_S + 1), im: new Float64Array(K_S + 1), ok: new Uint8Array(K_S + 1) },
              { re: new Float64Array(K_S + 1), im: new Float64Array(K_S + 1), ok: new Uint8Array(K_S + 1) }]
    };

    var RING = 8192, RMASK = RING - 1;
    var inL = new Float32Array(RING), inR = new Float32Array(RING);
    var outL = new Float32Array(RING), outR = new Float32Array(RING);
    var inPos = 0, readPos = 0, emitPos = 0;

    var zRe = [new Float64Array(W_L), new Float64Array(W_L)];
    var zIm = [new Float64Array(W_L), new Float64Array(W_L)];
    var yRe = new Float64Array(W_L), yIm = new Float64Array(W_L);
    var yEn = new Float64Array(W_L);
    var destEdge = new Int32Array(BL + 1);

    var state = 'long';                 // long | shorts | start | stop
    var frameStart = 0;
    var shortsInGroup = 0;
    var switchLockout = 0, transientRun = 0, quietRun = 0;
    var prevTopE = null;

    var tiltPhase = [0, 0, 0], tiltNow = [0, 0, 0], tiltTarget = [0, 0, 0];

    // smoothed (frame-boundary applied) internal copies of continuous params
    var cur = { budget: 1, gravity: 0, memory: 2, hunt: 0.25, lock: 0.5,
      intensity: 0, level: -20, power: 0.7, curve: 'bark', mask: 'drop',
      frame: 'long', exactEnergy: false };
    var frameMode = 'long';             // applied without smoothing

    var stats = { frames: 0, longs: 0, shorts: 0, switches: 0, nanResets: 0 };

    // tap state for the spectrogram / overlay
    var bandsE = new Float32Array(BL);
    var tapBins = null;                 // set by onBins tap (render harness)

    var engine = {
      params: P, fs: fs, stats: stats,
      bands: bandsL, bandCount: BL,
      bandsE: bandsE, map: wMap, bits: bitsL, starved: starvedLong,
      destEdge: destEdge,
      onFrame: null,   // fn(info) after each frame
      onBins: null,    // fn(magL, magR, K) after each frame, pre-inversion
      onEvent: null,   // fn({type:'switch'|'nan', ...})
      reset: reset
    };

    function reset() {
      sm.fill(0); wMap.fill(0); corrL.fill(0); corrS.fill(0);
      for (var m = 0; m < 2; m++) {
        prevA.long[m].re.fill(0); prevA.long[m].im.fill(0); prevA.long[m].ok.fill(0);
        prevA.short[m].re.fill(0); prevA.short[m].im.fill(0); prevA.short[m].ok.fill(0);
      }
      inL.fill(0); inR.fill(0); outL.fill(0); outR.fill(0);
      inPos = 0; readPos = 0; emitPos = 0; frameStart = 0;
      state = 'long'; shortsInGroup = 0; switchLockout = 0;
      transientRun = 0; quietRun = 0; prevTopE = null;
      tiltPhase = [0, 0, 0]; tiltNow = [0, 0, 0];
      cur = { budget: 1, gravity: 0, memory: 2, hunt: 0.25, lock: 0.5,
        intensity: 0, level: -20, power: 0.7, curve: 'bark', mask: 'drop',
        frame: 'long', exactEnergy: false };
      frameMode = String(P.frame || 'long');
    }

    function ring(a) { return a & RMASK; }

    function smoothParams() {
      // continuous params ease toward targets once per frame (alpha 0.5,
      // ~2 frames at 43 ms — zipper-free); tilt eases slower (alpha 0.25).
      var a = 0.5;
      cur.budget += a * ((+P.budget || 0) - cur.budget);
      cur.gravity += a * ((+P.gravity || 0) - cur.gravity);
      cur.memory += a * ((+P.memory || 2) - cur.memory);
      cur.hunt += a * ((+P.hunt || 0) - cur.hunt);
      cur.lock += a * ((+P.lock || 0) - cur.lock);
      cur.intensity += a * ((+P.intensity || 0) - cur.intensity);
      cur.level += a * ((+P.level !== undefined ? +P.level : -20) - cur.level);
      cur.power += a * ((+P.power || 0.7) - cur.power);
      cur.mask = P.mask === 'hide' ? 'hide' : 'drop';
      cur.curve = ['bark', 'power', 'linear'].indexOf(P.curve) >= 0 ? P.curve : 'bark';
      cur.exactEnergy = !!P.exactEnergy;
      var at = 0.25;
      tiltTarget[0] = +P.tiltLow || 0; tiltTarget[1] = +P.tiltMid || 0; tiltTarget[2] = +P.tiltHigh || 0;
      for (var g = 0; g < 3; g++) tiltNow[g] += at * (tiltTarget[g] - tiltNow[g]);
      var fm = String(P.frame || 'long');
      if (fm !== frameMode) { frameMode = fm; prevTopE = null; }
    }

    // ---------- main entry: process n samples, return produced ----------
    function process(inBufL, inBufR, outBufL, outBufR, n) {
      var i;
      for (i = 0; i < n; i++) {
        inL[ring(inPos + i)] = inBufL ? inBufL[i] : 0;
        inR[ring(inPos + i)] = inBufR ? inBufR[i] : 0;
      }
      inPos += n;

      for (;;) {
        var need = frameStart + frameLen();
        if (inPos < need) break;
        processFrame();
      }

      var avail = emitPos - readPos;
      var give = Math.min(avail, n);
      for (i = 0; i < give; i++) {
        outBufL[i] = outL[ring(readPos + i)];
        outBufR[i] = outR[ring(readPos + i)];
        // clear as we consume: when the OLA writes wrap this ring index again
        // (8192 samples later), they must start from zero, not the stale sum
        outL[ring(readPos + i)] = 0;
        outR[ring(readPos + i)] = 0;
      }
      readPos += give;
      for (i = give; i < n; i++) { outBufL[i] = 0; outBufR[i] = 0; }
      return give;
    }
    engine.process = process;

    function frameLen() { return state === 'shorts' ? W_S : W_L; }

    // ---------- scheduler ----------
    function advanceScheduler() {
      // samples below the next frame start are final
      emitUpTo(frameStart);
      if (state === 'shorts') {
        shortsInGroup++;
        if (shortsInGroup >= 4 && leaveShorts()) {
          state = 'stop';
          frameStart += H_S;         // STOP replaces the next short slot: its
                                     // first quarter pairs with the last
                                     // short's second half
          stats.switches++;
          if (engine.onEvent) engine.onEvent({ type: 'switch', to: 'long' });
        } else {
          frameStart += H_S;
        }
        return;
      }
      frameStart += H_L;
      if (state === 'stop') { state = 'long'; return; }
      if (state === 'start') { state = 'shorts'; shortsInGroup = 0; return; }
      // in 'long': decide the next transition
      if (frameMode === 'short') { state = 'start'; return; }
      if (frameMode === 'adaptive' && switchLockout <= 0 && transientRun >= 1) {
        state = 'start'; transientRun = 0; switchLockout = 4; stats.switches++;
        if (engine.onEvent) engine.onEvent({ type: 'switch', to: 'short' });
        return;
      }
      if (switchLockout > 0) switchLockout--;
    }

    function leaveShorts() {
      if (frameMode === 'long') return true;
      if (frameMode === 'short') return false;
      return quietRun >= 8;            // adaptive: 8 quiet short frames
    }

    function emitUpTo(limit) {
      while (emitPos < limit && emitPos - readPos < RING) emitPos++;
    }

    // ---------- one transform frame ----------
    function processFrame() {
      var start = frameStart;
      var short = state === 'shorts';
      var w = short ? W_S : W_L, K = short ? K_S : K_L;
      var fft = short ? fftS : fftL;
      var win = short ? winS : (state === 'start' ? winSTART : (state === 'stop' ? winSTOP : winL));
      var hop = short ? H_S : H_L;
      var bands = short ? bandsS : bandsL;
      var B = short ? BS : BL;

      smoothParams();

      var c, n, k, j;
      for (c = 0; c < 2; c++) {
        var src = c === 0 ? inL : inR;
        var zr = zRe[c], zi = zIm[c];
        for (n = 0; n < w; n++) { zr[n] = src[ring(start + n)] * win[n]; zi[n] = 0; }
        fft.forward(zr, zi);
      }

      // sanitize
      var bad = false;
      for (k = 1; k < K && !bad; k++) {
        if (!isFinite(zRe[0][k]) || !isFinite(zIm[0][k]) ||
            !isFinite(zRe[1][k]) || !isFinite(zIm[1][k])) bad = true;
      }
      if (bad) {
        for (c = 0; c < 2; c++) {
          zRe[c].fill(0); zIm[c].fill(0);
          var pv = prevA[short ? 'short' : 'long'][c];
          pv.ok.fill(0);
        }
        corrL.fill(0); corrS.fill(0);
        stats.nanResets++;
        if (engine.onEvent) engine.onEvent({ type: 'nan' });
      }

      // band energies (L+R) on this frame's grid
      var Eb = new Float64Array(B);
      for (j = 0; j < B; j++) {
        var e = 0;
        for (k = bands.edge[j]; k < bands.edge[j + 1]; k++) {
          e += zRe[0][k] * zRe[0][k] + zIm[0][k] * zIm[0][k] +
               zRe[1][k] * zRe[1][k] + zIm[1][k] * zIm[1][k];
        }
        Eb[j] = e;
      }

      var bypass = isBypass(P);
      if (!bypass) {
        computeAllocation(Eb, bands, B, hop, short);
        quantize(bands, B, short);
        updateMemory(hop, short);
        foldAndMask(bands, B, K, Eb, short);
        applyIntensity(bands, B);
        applyLock(bands, B, K, hop, w, short);
        applyTilt(K, hop);
      }
      updateDetector(Eb, bands, B, short);

      // tap: post-modification magnitudes (pre-mirror), for spectrograms
      if (engine.onBins) {
        var mL = new Float32Array(K), mR = new Float32Array(K);
        for (k = 0; k < K; k++) {
          mL[k] = Math.sqrt(zRe[0][k] * zRe[0][k] + zIm[0][k] * zIm[0][k]);
          mR[k] = Math.sqrt(zRe[1][k] * zRe[1][k] + zIm[1][k] * zIm[1][k]);
        }
        engine.onBins(mL, mR, K, short, start);
      }
      if (engine.onFrame) {
        for (j = 0; j < BL; j++) bandsE[j] = Eb[j];
        engine.onFrame({ short: short, start: start, block: w, stats: stats });
      }

      // inverse transform per channel: mirror bins, IFFT, window, OLA
      for (c = 0; c < 2; c++) {
        var zr2 = zRe[c], zi2 = zIm[c];
        zr2[0] = isFinite(zr2[0]) ? zr2[0] : 0; zi2[0] = 0;
        zr2[K] = isFinite(zr2[K]) ? zr2[K] : 0; zi2[K] = 0;
        for (k = 1; k < K; k++) { zr2[w - k] = zr2[k]; zi2[w - k] = -zi2[k]; }
        for (k = K + 1; k < w - K; k++) { zr2[k] = 0; zi2[k] = 0; }
        fft.inverse(zr2, zi2);
        var dst = c === 0 ? outL : outR;
        for (n = 0; n < w; n++) dst[ring(start + n)] += zr2[n] * win[n];
      }

      stats.frames++;
      if (short) stats.shorts++; else stats.longs++;
      advanceScheduler();
    }

    // ---------- allocation: masking model -> demand -> smoothed -> bits ----------
    function computeAllocation(Eb, bands, B, hop, short) {
      var dF = fs / (short ? W_S : W_L);
      var L = new Float64Array(B), thr = new Float64Array(B), demand = new Float64Array(B);
      var j, i;
      for (j = 0; j < B; j++) {
        var fLo = bands.edge[j] * dF, fHi = (bands.edge[j + 1] - 1) * dF;
        L[j] = 10 * Math.log10(Eb[j] + 1e-12) + cur.level;
        thr[j] = ath((fLo + fHi) / 2);
      }
      // spreading: a masker raises neighbours' thresholds. Upper slope
      // 10 dB/band, lower slope 20 dB/band, window +-4 bands.
      var spread = new Float64Array(B);
      for (j = 0; j < B; j++) {
        var m = thr[j];
        for (i = Math.max(0, j - 4); i <= Math.min(B - 1, j + 4); i++) {
          var d = j - i;
          var contrib = L[i] - (d >= 0 ? 10 * d : -20 * d);
          if (contrib > m) m = contrib;
        }
        spread[j] = m;
      }
      for (j = 0; j < B; j++) {
        thr[j] = Math.max(spread[j] - 5.9, thr[j]);
        demand[j] = Math.min(15, Math.max(0, (L[j] - thr[j]) / 6.02));
      }

      if (short) {
        // map short-grid demand onto the long grid, smooth there, map bits down
        for (j = 0; j < BL; j++) {
          var dL = 0;
          var list = null;
          // inverse of lsMap: weight by short band overlap
          for (var s = 0; s < BS; s++) {
            var pairs = lsMap[s];
            for (var q = 0; q < pairs.length; q++) {
              if (pairs[q][0] === j) { dL += demand[s] * pairs[q][1]; break; }
            }
          }
          var alpha = 1 - Math.exp(-hop / (huntTau() * fs));
          sm[j] += alpha * (dL - sm[j]);
        }
        assignBitsLong();
        // long bits -> short bands by overlap-weighted proportion
        var bsum = 0;
        for (j = 0; j < BS; j++) {
          var v = 0, pairs = lsMap[j];
          for (var q2 = 0; q2 < pairs.length; q2++) v += bitsL[pairs[q2][0]] * pairs[q2][1];
          bitsS[j] = Math.round(v);
          if (bitsS[j] > MAX_BITS_PER_BAND) bitsS[j] = MAX_BITS_PER_BAND;
          bsum += bitsS[j];
        }
        for (j = 0; j < BS; j++) starvedShort[j] = bitsS[j] === 0 ? 1 : 0;
      } else {
        for (j = 0; j < BL; j++) {
          var alpha2 = 1 - Math.exp(-hop / (huntTau() * fs));
          sm[j] += alpha2 * (demand[j] - sm[j]);
        }
        assignBitsLong();
        for (j = 0; j < BL; j++) starvedLong[j] = bitsL[j] === 0 ? 1 : 0;
      }
    }

    function huntTau() {
      // hunt 0 -> 1 frame, hunt 1 -> 64 frames (~21 ms .. ~1.4 s at long hop)
      var f = Math.min(1, Math.max(0, cur.hunt));
      return 1 + 63 * f * f;
    }

    function assignBitsLong() {
      var scale = (typeof P.voices === 'number' && P.voices > 1)
        ? 1 / (1 + 0.12 * (P.voices - 1)) : 1;
      var total = Math.round(Math.min(1, Math.max(0, cur.budget)) * MAX_BITS * scale);
      var sum = 0, j;
      for (j = 0; j < BL; j++) sum += sm[j];
      var t = new Float64Array(BL);
      if (sum > total) { var f = sum > 0 ? total / sum : 0; for (j = 0; j < BL; j++) t[j] = sm[j] * f; }
      else { for (j = 0; j < BL; j++) t[j] = sm[j]; }
      var bits = new Int32Array(BL), assigned = 0;
      for (j = 0; j < BL; j++) {
        bits[j] = Math.min(MAX_BITS_PER_BAND, Math.floor(t[j]));
        assigned += bits[j];
      }
      // distribute leftovers by fractional remainder; hunt dithers the order
      var order = [];
      for (j = 0; j < BL; j++) order.push(j);
      var rem = total - assigned;
      while (rem > 0) {
        var best = -1, bestV = -1;
        for (var q = 0; q < order.length; q++) {
          var jj = order[q];
          if (bits[jj] >= MAX_BITS_PER_BAND) continue;
          var frac = t[jj] - Math.floor(t[jj]);
          var v = frac + (cur.hunt > 0 ? cur.hunt * (rng() - 0.5) * 2 : 0);
          if (v > bestV) { bestV = v; best = jj; }
        }
        if (best < 0) break;
        bits[best]++; rem--;
      }
      for (j = 0; j < BL; j++) bitsL[j] = bits[j];
    }

    // ---------- Memory: long-term starved map (long grid) ----------
    function updateMemory(hop, short) {
      var tau = Math.max(0.01, cur.memory);
      var beta = 1 - Math.exp(-hop / (tau * fs));
      for (var j = 0; j < BL; j++) {
        var starved;
        if (short) {
          starved = 0; var tw = 0;
          var list = lsMapInverse(j);
          for (var q = 0; q < list.length; q++) { starved += starvedShort[list[q][0]] * list[q][1]; tw += list[q][1]; }
          starved = tw > 0 ? starved / tw : 0;
        } else {
          starved = starvedLong[j];
        }
        wMap[j] += beta * (starved - wMap[j]);
      }
    }
    function lsMapInverse(longIdx) {
      var list = [];
      for (var s = 0; s < BS; s++) {
        var pairs = lsMap[s];
        for (var q = 0; q < pairs.length; q++) {
          if (pairs[q][0] === longIdx) { list.push([s, pairs[q][1]]); break; }
        }
      }
      return list;
    }

    // ---------- transient/quiet detector (heuristic; named in README) ----------
    function updateDetector(Eb, bands, B, short) {
      var nTop = Math.min(6, B);
      var hf = 0, i;
      for (i = B - nTop; i < B; i++) hf += Eb[i];
      var flux = 0;
      if (prevTopE) {
        for (i = 0; i < nTop; i++) {
          flux += Math.abs(Math.sqrt(Eb[B - nTop + i]) - prevTopE[i]);
        }
      }
      if (!prevTopE) prevTopE = new Float64Array(nTop);
      for (i = 0; i < nTop; i++) prevTopE[i] = Math.sqrt(Eb[B - nTop + i]);
      var ratio = flux / (hf + 1e-12);
      if (short) {
        // in shorts: quiet tracking drives the return to long. Two ways to
        // be quiet: the top bands fall below an absolute floor, or frame
        // flux is small against a non-trivial floor (noise bed case).
        quietRun = hf < 1e-2 || ratio < 0.08 ? quietRun + 1 : 0;
      } else if (state === 'long') {
        if (frameMode !== 'adaptive') return;
        transientRun = ratio > 0.35 ? transientRun + 1 : 0;
        quietRun = hf < 1e-5 || ratio < 0.08 ? quietRun + 1 : 0;
      }
    }

    // ---------- Gravity fold + Mask ----------
    function foldAndMask(bands, B, K, Eb, short) {
      var weights = foldWeights(bands, fs, K, short ? W_S : W_L, cur.curve, cur.power);
      var strength = new Float64Array(B);
      var j;
      for (j = 0; j < B; j++) {
        if (short) {
          // long-grid wMap -> short band by overlap weight
          var pairs = lsMap[j], v = 0, tw = 0;
          for (var q = 0; q < pairs.length; q++) { v += wMap[pairs[q][0]] * pairs[q][1]; tw += pairs[q][1]; }
          strength[j] = cur.gravity * (tw > 0 ? v / tw : 0);
        } else {
          strength[j] = cur.gravity * wMap[j];
        }
      }
      // cumulative compaction: destEdge non-decreasing, destEdge[j] <= edge[j]
      destEdge[0] = 1;
      for (j = 0; j < B; j++) {
        var width = bands.edge[j + 1] - bands.edge[j];
        var keep = Math.round(width * (1 - Math.min(1, strength[j]) * weights[j]));
        if (keep < 0) keep = 0;
        var de = destEdge[j] + keep;
        if (de > bands.edge[j + 1]) de = bands.edge[j + 1];
        destEdge[j + 1] = de;
      }
      var folded = false;
      for (j = 0; j < B; j++) {
        if (destEdge[j + 1] < bands.edge[j + 1]) { folded = true; break; }
      }

      // Mask governs the starved bands' own bins: drop -> zero them; hide ->
      // fold into the louder neighbour's dest range, energy-weighted against
      // whatever the neighbour actually contributes there. This runs even when
      // nothing folds — with Gravity at 0, drop is what makes a starved band
      // go silent, and hide is what buries it.
      var starved = short ? starvedShort : starvedLong;
      var hiding = cur.mask === 'hide';
      if (!hiding) {
        for (j = 0; j < B; j++) {
          if (!starved[j]) continue;
          for (var b2 = bands.edge[j]; b2 < bands.edge[j + 1]; b2++) {
            zRe[0][b2] = 0; zIm[0][b2] = 0; zRe[1][b2] = 0; zIm[1][b2] = 0;
          }
        }
        if (!folded) return;
      } else {
        // Stage the hidden bins with their magnitudes; the blend weight needs
        // the neighbour's folded magnitude, which only exists after the walk.
        for (c = 0; c < 2; c++) hideStash[c].length = 0;
        for (j = 0; j < B; j++) {
          if (!starved[j]) continue;
          var p = loudestNeighbour(Eb, j, B);
          if (p < 0) { continue; }
          var plo = destEdge[p], phi = destEdge[p + 1], pw = phi - plo;
          if (pw <= 0) continue;
          var lo = bands.edge[j], hi = bands.edge[j + 1];
          for (var b = lo; b < hi; b++) {
            var d = plo + Math.round((b - lo) * (pw - 1) / (hi - lo - 1 || 1));
            if (d < plo) d = plo; if (d >= phi) d = phi - 1;
            for (var c = 0; c < 2; c++) {
              var mag = Math.sqrt(zRe[c][b] * zRe[c][b] + zIm[c][b] * zIm[c][b]);
              stashHide(c, d, zRe[c][b], zIm[c][b], mag);
            }
            zRe[0][b] = 0; zIm[0][b] = 0; zRe[1][b] = 0; zIm[1][b] = 0;
          }
        }
        if (!folded) {
          // dest ranges equal source ranges; the neighbour's bins are still
          // raw, so blend straight into them
          for (j = 0; j < 2; j++) {
            var s = hideStash[j];
            for (var i = 0; i < s.length; i += 4) {
              var d0 = s[i];
              var dm0 = Math.sqrt(zRe[j][d0] * zRe[j][d0] + zIm[j][d0] * zIm[j][d0]);
              var g0 = s[i + 3] / (s[i + 3] + dm0 + 1e-30);
              zRe[j][d0] += s[i + 1] * g0; zIm[j][d0] += s[i + 2] * g0;
            }
          }
          return;
        }
      }

      // fold every surviving band's bins down its dest range (hidden bands
      // contribute only through the stash)
      yRe.fill(0); yIm.fill(0); yEn.fill(0);
      for (j = 0; j < B; j++) {
        if (hiding && starved[j]) continue;
        var lo2 = bands.edge[j], hi2 = bands.edge[j + 1];
        var width2 = hi2 - lo2, dlo = destEdge[j], dhi = destEdge[j + 1], dw = dhi - dlo;
        for (var b3 = lo2; b3 < hi2; b3++) {
          var d2 = dlo + Math.round((b3 - lo2) * dw / (width2 - 1 || 1));
          if (d2 < dlo) d2 = dlo; if (d2 >= dhi) d2 = dhi - 1;
          if (d2 < 1 || d2 > K - 1) continue;
          for (var c2 = 0; c2 < 2; c2++) {
            yRe[d2] += zRe[c2][b3]; yIm[d2] += zIm[c2][b3];
            yEn[d2] += zRe[c2][b3] * zRe[c2][b3] + zIm[c2][b3] * zIm[c2][b3];
          }
        }
      }
      // blend the hidden bins against the neighbour's actual folded magnitude
      for (j = 0; j < 2; j++) {
        var s2 = hideStash[j];
        for (var i2 = 0; i2 < s2.length; i2 += 4) {
          var d1 = s2[i2];
          var dm1 = Math.sqrt(yRe[d1] * yRe[d1] + yIm[d1] * yIm[d1]);
          var g1 = s2[i2 + 3] / (s2[i2 + 3] + dm1 + 1e-30);
          yRe[d1] += s2[i2 + 1] * g1; yIm[d1] += s2[i2 + 2] * g1;
        }
      }
      if (cur.exactEnergy) {
        for (var d3 = 1; d3 < K; d3++) {
          var m2 = yRe[d3] * yRe[d3] + yIm[d3] * yIm[d3];
          if (m2 > 1e-30 && yEn[d3] > 1e-30) {
            var sc = Math.sqrt(yEn[d3] / m2);
            yRe[d3] *= sc; yIm[d3] *= sc;
          }
        }
      }
      for (var d4 = 1; d4 < K; d4++) {
        zRe[0][d4] = yRe[d4]; zIm[0][d4] = yIm[d4];
        zRe[1][d4] = yRe[d4]; zIm[1][d4] = yIm[d4];
      }
    }

    // Hide staging: (destBin, re, im, mag) per channel. The blend weight g is
    // applied after the fold walk, against the neighbour's folded magnitude.
    var hideStash = [[], []];
    function stashHide(c, d, vr, vi, mag) { hideStash[c].push(d, vr, vi, mag); }
    function loudestNeighbour(Eb, j, B) {
      var l = j > 0 ? Eb[j - 1] : -1, r = j < B - 1 ? Eb[j + 1] : -1;
      if (l < 0 && r < 0) return -1;
      return r >= l ? j + 1 : j - 1;
    }

    // ---------- quantize (per band, ATRAC-style scalefactor, both channels) ----------
    function quantize(bands, B, short) {
      var bits = short ? bitsS : bitsL;
      for (var j = 0; j < B; j++) {
        var nb = bits[j];
        if (nb <= 0) continue;
        var lo = bands.edge[j], hi = bands.edge[j + 1], peak = 0;
        for (var b = lo; b < hi; b++) {
          for (var c = 0; c < 2; c++) {
            var m = Math.abs(zRe[c][b]) + Math.abs(zIm[c][b]);
            if (m > peak) peak = m;
          }
        }
        if (peak <= 1e-30) continue;
        var sf = Math.ceil(Math.log2(peak + 1e-30));
        if (sf > 60) sf = 60;
        var step = Math.pow(2, sf) / (Math.pow(2, nb) - 1);
        for (b = lo; b < hi; b++) {
          for (c = 0; c < 2; c++) {
            zRe[c][b] = Math.round(zRe[c][b] / step) * step;
            zIm[c][b] = Math.round(zIm[c][b] / step) * step;
          }
        }
      }
    }

    // ---------- Intensity: top 6 bands, energy-conserving collapse ----------
    function applyIntensity(bands, B) {
      var nTop = 6;
      for (var j = Math.max(0, B - nTop); j < B; j++) {
        for (var b = bands.edge[j]; b < bands.edge[j + 1]; b++) {
          var el = zRe[0][b] * zRe[0][b] + zIm[0][b] * zIm[0][b];
          var er = zRe[1][b] * zRe[1][b] + zIm[1][b] * zIm[1][b];
          var tot = el + er;
          if (tot <= 1e-30) { zRe[0][b] = zIm[0][b] = zRe[1][b] = zIm[1][b] = 0; continue; }
          var mr = (zRe[0][b] + zRe[1][b]) / Math.SQRT2;
          var mi = (zIm[0][b] + zIm[1][b]) / Math.SQRT2;
          var m2 = mr * mr + mi * mi;
          var scale = Math.sqrt(tot / (m2 + 1e-30));
          var pan = el / (tot + 1e-30);
          var I = Math.min(1, Math.max(0, cur.intensity));
          var gL = scale * Math.sqrt((1 - I) + I * pan);
          var gR = scale * Math.sqrt((1 - I) + I * (1 - pan));
          zRe[0][b] = mr * gL; zIm[0][b] = mi * gL;
          zRe[1][b] = mr * gR; zIm[1][b] = mi * gR;
        }
      }
    }

    // ---------- Lock: per-band scalar phase loop ----------
    function applyLock(bands, B, K, hop, w, short) {
      var tau = 0.02 + 0.5 * (1 - Math.min(1, Math.max(0, cur.lock)));
      var alpha = 1 - Math.exp(-hop / (tau * fs));
      var pvSet = prevA[short ? 'short' : 'long'];
      var bits = short ? bitsS : bitsL;
      var corr = short ? corrS : corrL;
      for (var c = 0; c < 2; c++) {
        var zr = zRe[c], zi = zIm[c], pv = pvSet[c];
        for (var j = 0; j < B; j++) {
          if (bits[j] <= 0) continue;
          var sr = 0, si = 0, cnt = 0;
          for (var b = bands.edge[j]; b < bands.edge[j + 1]; b++) {
            var mag = Math.sqrt(zr[b] * zr[b] + zi[b] * zi[b]);
            if (mag < 1e-9) continue;
            var om = 2 * Math.PI * b * hop / w;
            var ang = Math.atan2(zi[b], zr[b]);
            if (!pv.ok[b]) { pv.re[b] = ang; pv.im[b] = ang; pv.ok[b] = 1; continue; }
            var err = ang - pv.re[b] - om;
            err = Math.atan2(Math.sin(err), Math.cos(err));
            sr += Math.sin(err) * mag; si += Math.cos(err) * mag; cnt++;
          }
          if (cnt > 0) {
            var bandErr = Math.atan2(sr, si);
            corr[j] += alpha * bandErr;
            if (corr[j] > Math.PI) corr[j] = Math.PI;
            if (corr[j] < -Math.PI) corr[j] = -Math.PI;
            var cr = Math.cos(-corr[j]), ci = Math.sin(-corr[j]);
            for (b = bands.edge[j]; b < bands.edge[j + 1]; b++) {
              var rr = zr[b] * cr - zi[b] * ci;
              var ri = zr[b] * ci + zi[b] * cr;
              zr[b] = rr; zi[b] = ri;
              if (pv.ok[b]) { pv.re[b] = Math.atan2(zi[b], zr[b]); }
            }
          }
        }
      }
    }

    // ---------- Tilt: per-group phase rotation (frequency shift) ----------
    function applyTilt(K, hop) {
      tiltPhase[0] += 2 * Math.PI * tiltNow[0] * hop / fs;
      tiltPhase[1] += 2 * Math.PI * tiltNow[1] * hop / fs;
      tiltPhase[2] += 2 * Math.PI * tiltNow[2] * hop / fs;
      if (tiltPhase[0] > 2 * Math.PI) tiltPhase[0] -= 2 * Math.PI;
      if (tiltPhase[1] > 2 * Math.PI) tiltPhase[1] -= 2 * Math.PI;
      if (tiltPhase[2] > 2 * Math.PI) tiltPhase[2] -= 2 * Math.PI;
      var dF = fs / (K === K_S ? W_S : W_L);
      var b1 = Math.max(2, Math.round(200 / dF));
      var b2 = Math.max(b1 + 1, Math.round(2000 / dF));
      if (b2 > K - 1) b2 = K - 1;
      var groups = [[1, Math.min(b1, K - 1)], [b1, b2], [b2, K - 1]];
      for (var g = 0; g < 3; g++) {
        if (Math.abs(tiltNow[g]) < 1e-9) continue;
        var th = tiltPhase[g], cr = Math.cos(th), ci = Math.sin(th);
        for (var c = 0; c < 2; c++) {
          var zr = zRe[c], zi = zIm[c];
          for (var b = groups[g][0]; b < groups[g][1]; b++) {
            var rr = zr[b] * cr - zi[b] * ci;
            var ri = zr[b] * ci + zi[b] * cr;
            zr[b] = rr; zi[b] = ri;
          }
        }
      }
    }

    return engine;
  }

  root.RDPipeline = {
    createEngine: createEngine, makeFFT: makeFFT,
    sineWindow: sineWindow, startWindow: startWindow, stopWindow: stopWindow,
    buildBands: buildBands, bandCount: bandCount,
    BARK_EDGES_HZ: BARK_EDGES_HZ, barkOf: barkOf, ath: ath,
    foldWeights: foldWeights, mulberry32: mulberry32, isBypass: isBypass
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.RDPipeline;
  }
})(typeof self !== 'undefined' ? self : globalThis);