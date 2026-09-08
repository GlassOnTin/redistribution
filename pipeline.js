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

  // ---------- chord detection ----------
  // Pitch-class histogram from spectral peaks, weighted by the codec's
  // allocation (bits are its salience measure). Per-BIN mapping is wrong at
  // long-frame resolution — 23 Hz bins cannot place a semitone below ~500 Hz
  // — so the histogram is built from local maxima instead: each peak's
  // frequency is parabolic-interpolated (sub-bin), its weight is the local
  // mainlobe energy times the bit boost of its band, and the weight splits
  // fractionally between the two pitch classes it falls between. Resolution
  // is still the frame's: overlapping low mainlobes blur the fundamentals
  // and the detected shape wobbles (root mostly holds, quality wanders
  // between relatives). That imprecision is part of the pedal's character —
  // the engine's vote smooths the root, and a wobbling quality is a colour
  // change, not an error. Templates are scored as the SUM of their classes
  // (a clean triad scores 1.0; dom7 only wins when its 4th tone carries
  // weight). Quality is gated on margin (a lone tone ties every shape);
  // the root itself is always the argmax — the caller votes on it.
  var CHORD_TEMPLATES = [
    ['major', [0, 4, 7]],
    ['minor', [0, 3, 7]],
    ['dom7', [0, 4, 7, 10]]
  ];
  var CHORD_MARGIN = 0.08;

  function detectChord(mags, bits, edge, fs, W, B) {
    var hist = new Float64Array(12), tot = 0;
    var K = W >> 1, binHz = fs / W;
    var b = 0;
    for (var k = 2; k < K - 1; k++) {
      if (!(mags[k] > mags[k - 1] && mags[k] >= mags[k + 1])) continue;
      // parabolic interpolation in log magnitude: sub-bin peak position
      var la = Math.log(mags[k - 1] + 1e-12), lb = Math.log(mags[k] + 1e-12),
        lc = Math.log(mags[k + 1] + 1e-12);
      var den = la - 2 * lb + lc;
      var dp = den !== 0 ? 0.5 * (la - lc) / den : 0;
      if (dp > 1 || dp < -1) dp = 0;
      while (b < B - 1 && edge[b + 1] <= k) b++;
      var w = mags[k - 1] * mags[k - 1] + mags[k] * mags[k] +
        mags[k + 1] * mags[k + 1];
      if (bits) w *= 1 + bits[b] / MAX_BITS_PER_BAND;
      var x = 12 * Math.log2(((k + dp) * binHz) / 440) + 69;
      var x0 = Math.floor(x), frac = x - x0;
      hist[((x0 % 12) + 12) % 12] += w * (1 - frac);
      hist[(((x0 + 1) % 12) + 12) % 12] += w * frac;
      tot += w;
    }
    var out = { root: -1, quality: null, score: 0, margin: 0, hist: hist };
    if (!(tot > 0)) return out;
    for (var pc = 0; pc < 12; pc++) hist[pc] /= tot;
    var bestScore = -1, bestRoot = -1, bestQual = null, otherScore = -1;
    for (var r = 0; r < 12; r++) {
      for (var ti = 0; ti < CHORD_TEMPLATES.length; ti++) {
        var pcs = CHORD_TEMPLATES[ti][1], s = 0;
        for (var q = 0; q < pcs.length; q++) s += hist[(r + pcs[q]) % 12];
        if (s > bestScore) {
          if (r !== bestRoot) otherScore = bestScore;
          bestScore = s; bestRoot = r; bestQual = CHORD_TEMPLATES[ti][0];
        } else if (s > otherScore && r !== bestRoot) {
          otherScore = s;
        }
      }
    }
    out.root = bestRoot; out.score = bestScore;
    out.margin = bestScore - Math.max(0, otherScore);
    if (out.margin >= CHORD_MARGIN) out.quality = bestQual;
    return out;
  }

  // Signed interval in [-6, 5] semitones from a frequency to the nearest
  // tone of a chord (root 0-11 + quality name). The pitch class is rounded
  // to the semitone grid first — a fractional pc would give a fractional
  // interval and scatter the follow copy off-key. Returns null for a
  // qualityless chord (nothing to follow).
  function followInterval(f0, root, quality) {
    var pcs = null;
    for (var ti = 0; ti < CHORD_TEMPLATES.length; ti++)
      if (CHORD_TEMPLATES[ti][0] === quality) pcs = CHORD_TEMPLATES[ti][1];
    if (!pcs) return null;
    var x = Math.round(12 * Math.log2(f0 / 440) + 69) % 12;
    if (x < 0) x += 12;
    var n = 0, best = 99;
    for (var q = 0; q < pcs.length; q++) {
      var d = ((root + pcs[q] - x + 18) % 12) - 6;
      if (Math.abs(d) < best) { best = Math.abs(d); n = d; }
    }
    return n;
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
  // exact identity, so modification is skipped entirely. Tilt is NOT part of
  // this: it runs post-OLA at emission time as an independent stage, so a
  // neutral codec with a frequency tilt is still "bypass" for the transform
  // chain. Kept local so pipeline.js stays load-order independent of params.js.
  function isBypass(P) {
    return P.budget >= 0.999 && P.gravity <= 1e-6 && P.mask !== 'hide' &&
      P.intensity <= 1e-6 && P.lock <= 1e-6 && !(P.follow > 1e-6);
  }

  // ---------- the engine ----------
  function createEngine(fs, opts) {
    opts = opts || {};
    var rng = opts.rng || mulberry32(0x5eed11);
    var rngSeed = opts.rng ? null : 0x5eed11;   // reset() re-seeds the built-in

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
    var yRe = [new Float64Array(W_L), new Float64Array(W_L)];
    var yIm = [new Float64Array(W_L), new Float64Array(W_L)];
    var yEn = [new Float64Array(W_L), new Float64Array(W_L)];
    var destEdge = new Int32Array(BL + 1);

    var state = 'long';                 // long | shorts | start | stop
    var frameStart = 0;
    var shortsInGroup = 0;
    var switchLockout = 0, transientRun = 0, quietRun = 0;
    var prevTopE = null;

    var tiltPhase = [0, 0, 0], tiltNow = [0, 0, 0], tiltTarget = [0, 0, 0];

    // smoothed (frame-boundary applied) internal copies of continuous params
    var cur = { budget: 1, gravity: 0, memory: 2, hunt: 0.25, lock: 0.5,
      follow: 0, intensity: 0, level: -20, power: 0.7, curve: 'bark',
      mask: 'drop', frame: 'long', exactEnergy: false,
      dry: 0, wet: 1, inGain: 0, outGain: 0 };
    var frameMode = 'long';             // applied without smoothing

    var stats = { frames: 0, longs: 0, shorts: 0, switches: 0, nanResets: 0 };

    // held chord, decided by a sliding vote over the last CHORD_VOTE_N
    // frames (~0.4 s). Frame-level detection wobbles — overlapping low
    // mainlobes blur the fundamentals, and the argmax root hops between
    // relatives — so no single frame is trusted: a root is adopted when it
    // takes NEED of the last N votes. Quality is the mode among those
    // frames' gated qualities; if none cleared the margin gate the chord
    // reads qualityless. A frame of silence votes for nothing and lets the
    // held chord decay rather than snapping off.
    var chord = { root: -1, quality: null, confidence: 0 };
    var CHORD_VOTE_N = 9, CHORD_VOTE_NEED = 5;
    var voteRoots = new Int32Array(CHORD_VOTE_N).fill(-2);
    var voteQuals = new Array(CHORD_VOTE_N).fill(null);
    var votePos = 0, voteFill = 0;

    var chordMags = new Float32Array(K_L);   // per-bin L+R magnitude, reused

    function updateChord(mags, bands, B, short, bits) {
      var det = detectChord(mags, bits, bands.edge, fs, short ? W_S : W_L, B);
      voteRoots[votePos] = det.root;
      voteQuals[votePos] = det.quality;
      votePos = (votePos + 1) % CHORD_VOTE_N;
      if (voteFill < CHORD_VOTE_N) voteFill++;

      var counts = new Int32Array(13);          // 12 roots + silence slots
      var qualTally = {};                       // "root/quality" -> n
      for (var v = 0; v < CHORD_VOTE_N; v++) {
        var rv = voteRoots[v];
        if (rv < 0) continue;                   // empty slot or silence
        counts[rv]++;
        if (voteQuals[v]) {
          var key = rv + '/' + voteQuals[v];
          qualTally[key] = (qualTally[key] || 0) + 1;
        }
      }
      var bestRoot = -1, bestCount = 0;
      for (var r = 0; r < 12; r++) {
        if (counts[r] > bestCount) { bestCount = counts[r]; bestRoot = r; }
      }
      if (bestCount >= CHORD_VOTE_NEED) {
        var qBest = null, qN = 0;
        for (var key2 in qualTally) {
          if (key2.indexOf(bestRoot + '/') === 0 && qualTally[key2] > qN) {
            qN = qualTally[key2]; qBest = key2.split('/')[1];
          }
        }
        chord.root = bestRoot;
        chord.quality = qBest;
        chord.confidence = bestCount / voteFill;
      } else {
        chord.confidence *= 0.9;
        if (chord.confidence < 0.1) {
          chord.root = -1; chord.quality = null; chord.confidence = 0;
        }
      }
    }

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
      chord: chord,    // {root, quality, confidence} — the held chord readout
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
      chord.root = -1; chord.quality = null; chord.confidence = 0;
      fPhase = {};
      voteRoots.fill(-2); voteQuals.fill(null); votePos = 0; voteFill = 0;
      tiltPhase = [0, 0, 0]; tiltNow = [0, 0, 0];
      tiltS[0].fill(0); tiltS[1].fill(0);
      cur = { budget: 1, gravity: 0, memory: 2, hunt: 0.25, lock: 0.5,
        follow: 0, intensity: 0, level: -20, power: 0.7, curve: 'bark',
        mask: 'drop', frame: 'long', exactEnergy: false,
        dry: 0, wet: 1, inGain: 0, outGain: 0 };
      frameMode = String(P.frame || 'long');
      // the hunt dither's PRNG state is part of the engine state: without
      // re-seeding, a reset instance allocates differently from a fresh one
      if (rngSeed !== null) rng = mulberry32(rngSeed);
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
      cur.follow += a * ((+P.follow || 0) - cur.follow);
      cur.intensity += a * ((+P.intensity || 0) - cur.intensity);
      cur.level += a * ((+P.level !== undefined ? +P.level : -20) - cur.level);
      cur.power += a * ((+P.power || 0.7) - cur.power);
      cur.mask = P.mask === 'hide' ? 'hide' : 'drop';
      cur.curve = ['bark', 'power', 'linear'].indexOf(P.curve) >= 0 ? P.curve : 'bark';
      cur.followMode = P.followMode === 'frame' ? 'frame' : 'partial';
      cur.exactEnergy = !!P.exactEnergy;
      // Dry defaults to 0 and Wet to 1 (a crossfade): the engine's bypass is
      // an exact identity, so a parallel dry+wet at 1/1 would double. With
      // dry=0 the emitted stream is just the pipeline's output, untouched.
      cur.dry += a * (((P.dry === undefined ? 0 : +P.dry)) - cur.dry);
      cur.wet += a * (((P.wet === undefined ? 1 : +P.wet)) - cur.wet);
      cur.inGain += a * (((P.inGain === undefined ? 0 : +P.inGain)) - cur.inGain);
      cur.outGain += a * (((P.outGain === undefined ? 0 : +P.outGain)) - cur.outGain);
      var at = 0.25;
      tiltTarget[0] = +P.tiltLow || 0; tiltTarget[1] = +P.tiltMid || 0; tiltTarget[2] = +P.tiltHigh || 0;
      for (var g = 0; g < 3; g++) tiltNow[g] += at * (tiltTarget[g] - tiltNow[g]);
      var fm = String(P.frame || 'long');
      if (fm !== frameMode) { frameMode = fm; prevTopE = null; }
    }

    // ---------- main entry: process n samples, return produced ----------
    function process(inBufL, inBufR, outBufL, outBufR, n) {
      var i;
      var gIn = Math.pow(10, cur.inGain / 20);
      for (i = 0; i < n; i++) {
        inL[ring(inPos + i)] = (inBufL ? inBufL[i] : 0) * gIn;
        inR[ring(inPos + i)] = (inBufR ? inBufR[i] : 0) * gIn;
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
      // Tilt is post-OLA, applied to the emitted samples only (the ring's
      // samples are consumed once). Neutral tilt is the identity and the
      // filter bank is skipped entirely, so the bypass path is untouched.
      if (Math.abs(tiltNow[0]) > 1e-9 || Math.abs(tiltNow[1]) > 1e-9 || Math.abs(tiltNow[2]) > 1e-9) {
        applyTilt(outBufL, outBufR, give);
      }
      // Dry/Wet crossfade + output trim, at emission. readPos lags inPos by
      // the pipeline latency and the input ring is not cleared on read, so
      // inL/inR here still hold the matching input samples. Defaults (0, 1)
      // make this exact: the bypass identity survives the blend arithmetic.
      if (cur.dry !== 0 || cur.wet !== 1 || cur.outGain !== 0) {
        var gDry = cur.dry, gWet = cur.wet, gOut = Math.pow(10, cur.outGain / 20);
        for (i = 0; i < give; i++) {
          var o = ring(readPos + i - give);   // input aligned with emitted sample
          outBufL[i] = (gDry * inL[o] + gWet * outBufL[i]) * gOut;
          outBufR[i] = (gDry * inR[o] + gWet * outBufR[i]) * gOut;
        }
      }
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
        applyFollow(Eb, bands, B, K, short, hop);
        applyLock(bands, B, K, hop, w, short);
      } else {
        // the warp overlay reads destEdge even in a neutral preset: leave it
        // as the identity map, not the zero-filled initial array
        for (j = 0; j <= B; j++) destEdge[j] = bands.edge[j];
      }
      updateDetector(Eb, bands, B, short);
      // chord readout runs in both branches: a neutral preset still reports
      // what it hears, but from energy alone (stale bits would lie)
      for (k = 0; k < K; k++) {
        chordMags[k] = Math.sqrt(zRe[0][k] * zRe[0][k] + zIm[0][k] * zIm[0][k] +
          zRe[1][k] * zRe[1][k] + zIm[1][k] * zIm[1][k]);
      }
      updateChord(chordMags, bands, B, short, bypass ? null : (short ? bitsS : bitsL));

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
        // only the frame's own band count is valid: bandsE is sized for the
        // long grid, and a short frame's Eb (and edge map) are shorter —
        // consumers slice by B, never walk bandsE to its allocated length
        for (j = 0; j < B; j++) bandsE[j] = Eb[j];
        engine.onFrame({ short: short, start: start, block: w, stats: stats,
          B: B, edge: bands.edge });
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
      // band level on a dBFS-anchored scale: the raw FFT energy depends on
      // transform gain, so un-normalised it made the model's scale depend on
      // how concentrated the material is — a sine piles its power into one
      // bin and survives, while broadband program material spreads it thin
      // and starved every band into silence (drums rendered to 0.003 peak at
      // default settings). Normalise so a full-scale sine reads 0 dB, then
      // apply the 96 dB SPL convention a real coder assumes, so Level
      // (default -20 dB) reads as playback loudness against the ATH table.
      var refMag = (short ? W_S : W_L) / Math.PI;
      for (j = 0; j < B; j++) {
        var fLo = bands.edge[j] * dF, fHi = (bands.edge[j + 1] - 1) * dF;
        L[j] = 10 * Math.log10(Eb[j] / (refMag * refMag) + 1e-12) + 96 + cur.level;
        thr[j] = ath((fLo + fHi) / 2);
      }
      // spreading: a masker raises neighbours' thresholds. Upper slope
      // 10 dB/band, lower slope 20 dB/band, window +-4 bands. A band does
      // not mask itself: its own level must survive as demand, or a lone
      // tone's band computes demand (L - (L - 5.9))/6.02 < 1 and starves.
      var spread = new Float64Array(B);
      for (j = 0; j < B; j++) {
        var m = thr[j];
        for (i = Math.max(0, j - 4); i <= Math.min(B - 1, j + 4); i++) {
          if (i === j) continue;
          var d = j - i;
          var contrib = L[i] - (d >= 0 ? 10 * d : -20 * d) - 5.9;
          if (contrib > m) m = contrib;
        }
        spread[j] = m;
      }
      for (j = 0; j < B; j++) {
        thr[j] = Math.max(spread[j], thr[j]);
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
          var alpha = huntAlpha();
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
          var alpha2 = huntAlpha();
          sm[j] += alpha2 * (demand[j] - sm[j]);
        }
        assignBitsLong();
        for (j = 0; j < BL; j++) starvedLong[j] = bitsL[j] === 0 ? 1 : 0;
      }
    }

    function huntAlpha() {
      // hunt 0 -> 1-frame time constant (alpha 0.63), hunt 1 -> 64 frames
      // (~21 ms .. ~1.4 s at long hop). Per-frame smoothing: one frame is the
      // unit, so alpha = 1 - exp(-1/tau_frames) regardless of hop size.
      var f = Math.min(1, Math.max(0, cur.hunt));
      var tau = 1 + 63 * f * f;
      return 1 - Math.exp(-1 / tau);
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
      // distribute leftovers by fractional remainder; hunt dithers the order.
      // The pool is capped at the fractional parts: budget above total demand
      // leaves bits unspent — force-feeding surplus into the first bands made
      // the allocator insensitive to Budget above the demand ceiling.
      var order = [];
      for (j = 0; j < BL; j++) order.push(j);
      var fracSum = 0;
      for (j = 0; j < BL; j++) fracSum += t[j] - Math.floor(t[j]);
      var rem = total - assigned;
      if (rem > Math.floor(fracSum + 1e-9)) rem = Math.floor(fracSum + 1e-9);
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

      // fold every surviving band's bins down its dest range, per channel
      // (hidden bands contribute only through the stash)
      yRe[0].fill(0); yIm[0].fill(0); yEn[0].fill(0);
      yRe[1].fill(0); yIm[1].fill(0); yEn[1].fill(0);
      for (j = 0; j < B; j++) {
        if (hiding && starved[j]) continue;
        var lo2 = bands.edge[j], hi2 = bands.edge[j + 1];
        var width2 = hi2 - lo2, dlo = destEdge[j], dhi = destEdge[j + 1], dw = dhi - dlo;
        for (var b3 = lo2; b3 < hi2; b3++) {
          var d2 = dlo + Math.round((b3 - lo2) * dw / (width2 - 1 || 1));
          if (d2 < dlo) d2 = dlo; if (d2 >= dhi) d2 = dhi - 1;
          if (d2 < 1 || d2 > K - 1) continue;
          for (var c2 = 0; c2 < 2; c2++) {
            yRe[c2][d2] += zRe[c2][b3]; yIm[c2][d2] += zIm[c2][b3];
            yEn[c2][d2] += zRe[c2][b3] * zRe[c2][b3] + zIm[c2][b3] * zIm[c2][b3];
          }
        }
      }
      // blend the hidden bins against the neighbour's actual folded magnitude
      for (j = 0; j < 2; j++) {
        var s2 = hideStash[j];
        for (var i2 = 0; i2 < s2.length; i2 += 4) {
          var d1 = s2[i2];
          var dm1 = Math.sqrt(yRe[j][d1] * yRe[j][d1] + yIm[j][d1] * yIm[j][d1]);
          var g1 = s2[i2 + 3] / (s2[i2 + 3] + dm1 + 1e-30);
          yRe[j][d1] += s2[i2 + 1] * g1; yIm[j][d1] += s2[i2 + 2] * g1;
        }
      }
      for (var c3 = 0; c3 < 2; c3++) {
        if (cur.exactEnergy) {
          for (var d3 = 1; d3 < K; d3++) {
            var m2 = yRe[c3][d3] * yRe[c3][d3] + yIm[c3][d3] * yIm[c3][d3];
            if (m2 > 1e-30 && yEn[c3][d3] > 1e-30) {
              var sc = Math.sqrt(yEn[c3][d3] / m2);
              yRe[c3][d3] *= sc; yIm[c3][d3] *= sc;
            }
          }
        }
        for (var d4 = 1; d4 < K; d4++) {
          zRe[c3][d4] = yRe[c3][d4]; zIm[c3][d4] = yIm[c3][d4];
        }
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

    // ---------- Follow: retune the input into the held chord ----------
    // Two modes. 'partial': every prominent partial snaps to the nearest
    // chord tone, harmonic stacks moving together (per-note harmonizer).
    // 'frame': the dominant partial sets one interval and the whole frame
    // is transposed by it (chord-quantised pitch shift).
    //
    // Replace, not copy: an out-of-chord partial's bins are scaled by (1-g)
    // and the moved copy written at gain g — at follow=1 a clean move, below
    // it the original and pulled pitch sound together (chorus-like split,
    // named character). In-chord content (n=0) is skipped and stays
    // sample-exact. Moved copies rotate by a per-partial phase accumulator
    // (the source-to-destination frequency offset times the hop) so the
    // moved bins advance frame-to-frame like native bins — without it the
    // overlap-add cancels most of the moved energy (measured 5x loss).
    //
    // Named limitations: placement quantises to the frame's bin grid
    // (±11.7 Hz long); partials within 2 bins merge and move as one (a
    // semitone below ~500 Hz is under 2 bins at Frame=long and cannot be
    // resolved); a moved copy colliding with another partial sums against
    // it (Lock-family wobble); frame mode skips the phase accumulator
    // (whole-spectrum moves have per-partial phases a scalar cannot fix) —
    // its transposition smears more than partial mode. The detector reads
    // the FOLLOWED spectrum, so a strong pull reinforces the held chord.
    // Long frames only: short-frame bins (93.75 Hz) cannot place a semitone
    // below ~1.6 kHz — transients skip naturally under adaptive.
    var fSrcRe = [new Float64Array(K_L), new Float64Array(K_L)];
    var fSrcIm = [new Float64Array(K_L), new Float64Array(K_L)];
    // phase accumulator per moved partial, keyed by rounded MIDI note;
    // st.f is the frame it last advanced (stale entries reset on return)
    var fPhase = {};
    // ---------- Follow: retune the input into the held chord ----------
    // Two modes. 'partial': every prominent partial snaps to the nearest
    // chord tone, harmonic stacks moving together (per-note harmonizer).
    // 'frame': the dominant partial sets one interval and the whole frame
    // is transposed by it (chord-quantised pitch shift).
    //
    // Replace, not copy: an out-of-chord partial's bins are scaled by
    // (1-g) and the moved copy written at gain g — at follow=1 a clean
    // move, below it the original and pulled pitch sound together. In-chord
    // content (n=0) is skipped entirely and stays sample-exact.
    //
    // Named limitations: placement quantises to the frame grid (±11.7 Hz
    // long); partials closer than 5 bins (~117 Hz) merge and move as one;
    // a moved copy colliding with another partial's bins sums against it
    // (Lock-family wobble); the retuned input feeds the chord detector, so
    // a strong pull reinforces the held chord.
    function applyFollow(Eb, bands, B, K, short, hop) {
      if (short || cur.follow <= 1e-6) return;
      if (chord.root < 0 || !chord.quality) return;   // nothing to follow yet
      var binHz = fs / (2 * K);
      var k, c;

      // combined L+R magnitude
      var mag = function (kk) {
        return Math.sqrt(zRe[0][kk] * zRe[0][kk] + zIm[0][kk] * zIm[0][kk] +
                         zRe[1][kk] * zRe[1][kk] + zIm[1][kk] * zIm[1][kk]);
      };

      // --- peak picking -------------------------------------------------
      // Prominent partials: local maxima above 0.02 of the frame max
      // (measured on the arp loop: the 5 saw harmonics sit 6-30 dB above
      // this floor; noise-floor ripple does not cross it). Peaks within 2
      // bins of a stronger one are merged — that is main-lobe overlap, not
      // a neighbour (a radius of 5 absorbed real semitone neighbours in the
      // mid register: F#5's fundamental at 3.5 bins from a stronger E5 was
      // eaten and moved with it). Cap 12 strongest.
      var fmax = 0;
      for (k = 2; k < K; k++) {
        var m2 = zRe[0][k] * zRe[0][k] + zIm[0][k] * zIm[0][k] +
                 zRe[1][k] * zRe[1][k] + zIm[1][k] * zIm[1][k];
        if (m2 > fmax) fmax = m2;
      }
      if (fmax <= 0) return;
      var floor = 0.02 * fmax;
      var peaks = [];                     // {k, m2}
      for (k = 2; k < K - 1; k++) {
        var m = zRe[0][k] * zRe[0][k] + zIm[0][k] * zIm[0][k] +
                zRe[1][k] * zRe[1][k] + zIm[1][k] * zIm[1][k];
        if (m <= floor) continue;
        if (!(m > zRe[0][k-1] * zRe[0][k-1] + zIm[0][k-1] * zIm[0][k-1] +
                    zRe[1][k-1] * zRe[1][k-1] + zIm[1][k-1] * zIm[1][k-1])) continue;
        if (!(m >= zRe[0][k+1] * zRe[0][k+1] + zIm[0][k+1] * zIm[0][k+1] +
                    zRe[1][k+1] * zRe[1][k+1] + zIm[1][k+1] * zIm[1][k+1])) continue;
        // merge into a stronger peak within 5 bins
        var merged = false;
        for (var p = peaks.length - 1; p >= 0 && k - peaks[p].k <= 2; p--) {
          if (peaks[p].m2 >= m) { merged = true; break; }
          peaks.splice(p, 1);            // weaker neighbour: absorbed
        }
        if (merged) continue;
        peaks.push({ k: k, m2: m });
      }
      if (!peaks.length) return;
      if (peaks.length > 12) {
        peaks.sort(function (a, b) { return b.m2 - a.m2; });
        peaks.length = 12;
        peaks.sort(function (a, b) { return a.k - b.k; });
      }

      // sub-bin position per peak (log-parabolic, clamped)
      var pks = [];
      for (p = 0; p < peaks.length; p++) {
        var kp = peaks[p].k;
        var la = Math.log(mag(kp - 1) + 1e-12), lb = Math.log(mag(kp) + 1e-12),
          lc = Math.log(mag(kp + 1) + 1e-12);
        var den = la - 2 * lb + lc;
        var dp = den !== 0 ? 0.5 * (la - lc) / den : 0;
        if (dp > 1 || dp < -1) dp = 0;
        peaks[p].f0 = (kp + dp) * binHz;
        peaks[p].dp = dp;
        peaks[p].r = 1;
        peaks[p].n = 0;
      }

      // band-coding gate per peak: the codec starved it -> it is not content
      var bandOf = function (kk) {
        var j = 0;
        while (j < B - 1 && bands.edge[j + 1] <= kk) j++;
        return j;
      };
      var kept = [];
      for (p = 0; p < peaks.length; p++) {
        if (bitsL[bandOf(peaks[p].k)] <= 0) continue;
        kept.push(peaks[p]);
      }
      if (!kept.length) return;

      var g = cur.follow;
      var g1 = 1 - g;

      // move-list construction: each moved member is a 5-bin window about
      // its own peak, radially rescaled about the peak's sub-bin position
      // so the window's internal shape (skirt, side lobes) moves with it.
      // Peak picking keeps peaks >= 3 bins apart, so source windows never
      // overlap; destination writes may collide (additive sum, named wobble)
      var windows = [];                   // {pk, dp, r, all}
      if (cur.followMode === 'frame') {
        // --- frame mode: dominant partial sets the interval --------------
        var eTot = 0;
        for (var q = 0; q < B; q++) eTot += Eb[q];
        var dom = kept[0];
        for (p = 1; p < kept.length; p++) if (kept[p].m2 > dom.m2) dom = kept[p];
        var jb = bandOf(dom.k);
        if (!(Eb[jb] > 0.25 * eTot)) return;
        var nf = followInterval(dom.f0, chord.root, chord.quality);
        if (nf === null) return;
        dom.n = nf;
        dom.r = Math.pow(2, nf / 12);
        if (nf !== 0) windows.push({ pk: dom.k, dp: dom.dp, r: dom.r, all: true });
        // n=0: no move; the bloom below fires from the untouched dominant
      } else {
        // --- partial mode: per-note harmonize, stacks coherent -----------
        // a peak joins the group of a lower peak when it is within 0.6 bin
        // of an integer multiple (2..10) of it; members inherit the head's
        // r and move radially about their own pkf, so k*f stays k*(f*r)
        for (p = 0; p < kept.length; p++) {
          var pk = kept[p];
          var ni = null;
          for (var q2 = 0; q2 < p; q2++) {
            var head = kept[q2];
            var ratio = pk.f0 / head.f0;
            var ki = Math.round(ratio);
            if (ki >= 2 && ki <= 10 &&
                Math.abs(ratio - ki) * head.f0 < 0.6 * binHz) {
              ni = head.n; break;
            }
          }
          if (ni === null)
            ni = followInterval(pk.f0, chord.root, chord.quality);
          pk.n = ni === null ? 0 : ni;
          pk.r = Math.pow(2, pk.n / 12);
        }
        for (p = 0; p < kept.length; p++)
          if (kept[p].n !== 0)
            windows.push({ pk: kept[p].k, dp: kept[p].dp, r: kept[p].r, all: false });
      }

      // --- apply the moves: snapshot ALL sources, scale, then write -----
      // (destination writes can land inside another window)
      var w2, wi, win;
      for (w2 = 0; w2 < windows.length; w2++) {
        win = windows[w2];
        var lo = win.all ? 1 : win.pk - 2;
        if (lo < 1) lo = 1;
        var hi = win.all ? K : win.pk + 3;
        if (hi > K) hi = K;
        win.lo = lo; win.hi = hi;
        for (k = lo; k < hi; k++) for (c = 0; c < 2; c++) {
          fSrcRe[c][k] = zRe[c][k]; fSrcIm[c][k] = zIm[c][k];
        }
      }
      for (w2 = 0; w2 < windows.length; w2++) {
        win = windows[w2];
        for (k = win.lo; k < win.hi; k++) for (c = 0; c < 2; c++) {
          zRe[c][k] *= g1; zIm[c][k] *= g1;
        }
      }
      for (w2 = 0; w2 < windows.length; w2++) {
        win = windows[w2];
        var pkf = (win.pk + win.dp) * win.r;
        // per-partial phase accumulator: the moved copy represents a partial
        // that changed frequency from f_src to f_src*r, so its phase advances
        // by 2*pi*f_src*(1-r) per hop relative to a native bin at the
        // destination. Rotate each frame's copy by the accumulated angle or
        // the overlap-add of consecutive frames cancels it (measured: 5x
        // energy loss without this). Frame-mode whole-spectrum windows skip
        // it: their bins each have their own phase error, a scalar cannot.
        var rotRe = 1, rotIm = 0;
        if (!win.all) {
          var fSrc = (win.pk + win.dp) * binHz;
          var key = Math.round(69 + 12 * Math.log2(fSrc / 440));
          var st = fPhase[key];
          var fr = stats.frames;
          if (!st || fr - st.fr > 4) st = fPhase[key] = { p: 0, fr: fr };
          st.fr = fr;
          st.p += 2 * Math.PI * fSrc * (1 - win.r) * hop / fs;
          if (st.p > Math.PI) st.p -= 2 * Math.PI;
          else if (st.p < -Math.PI) st.p += 2 * Math.PI;
          rotRe = Math.cos(st.p); rotIm = Math.sin(st.p);
        }
        for (k = win.lo; k < win.hi; k++) {
          var d2 = Math.round(pkf + (k - win.pk) * win.r);
          if (d2 < 1) d2 = 1; else if (d2 > K - 1) d2 = K - 1;
          for (c = 0; c < 2; c++) {
            var sr = fSrcRe[c][k], si = fSrcIm[c][k];
            zRe[c][d2] += (sr * rotRe + si * rotIm) * g;
            zIm[c][d2] += (si * rotRe - sr * rotIm) * g;
          }
        }
      }

      // --- bloom: the dominant partial re-drawn at 2f and 3f -------------
      // Partial mode blooms when the dominant itself moved (a moved stack's
      // own harmonics are checked against the target first). Frame mode
      // blooms only at n=0: at n!=0 the whole-spectrum move already carried
      // every harmonic along, and blooming again would double them.
      var domPeak = kept[0];
      for (p = 1; p < kept.length; p++) if (kept[p].m2 > domPeak.m2) domPeak = kept[p];
      var bloom = domPeak.n !== 0 && cur.followMode === 'partial';
      var fromLive = false;
      if (cur.followMode === 'frame') { bloom = domPeak.n === 0; fromLive = true; }
      if (bloom) {
        var base = domPeak.f0 * domPeak.r;
        // occupied map: where every kept peak's energy now lives (moved
        // peaks at their pulled position, in-chord peaks where they are)
        var occ = [];
        for (p = 0; p < kept.length; p++) {
          occ.push(kept[p].n !== 0
            ? Math.round(kept[p].f0 * kept[p].r / binHz) : kept[p].k);
        }
        for (var h = 2; h <= 3; h++) {
          var cen = Math.round(base * h / binHz);
          var stack = false;
          for (p = 0; p < occ.length; p++) {
            if (occ[p] >= cen - 3 && occ[p] <= cen + 3) { stack = true; break; }
          }
          if (stack) continue;
          var gh = g / h;
          for (wi = -2; wi <= 2; wi++) {
            var ks = domPeak.k + wi;
            var d3 = cen + wi;
            if (d3 < 1) d3 = 1; else if (d3 > K - 1) d3 = K - 1;
            for (c = 0; c < 2; c++) {
              var sr = fromLive ? zRe[c][ks] : fSrcRe[c][ks];
              var si = fromLive ? zIm[c][ks] : fSrcIm[c][ks];
              zRe[c][d3] += sr * gh;
              zIm[c][d3] += si * gh;
            }
          }
        }
      }
    }

    // ---------- Lock: per-band scalar phase loop ----------
    function applyLock(bands, B, K, hop, w, short) {
      // lock 0 = loop off. The tau curve below has its SLOWEST setting at 0,
      // so without this gate the loop would still integrate at ~0.5 s and
      // crawl each band's correction toward its fractional-bin drift.
      if (Math.abs(cur.lock) < 1e-4) return;
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
            // Rotate by +corr: pv holds this frame's corrected angle, so the
            // next frame's error reads (drift - corr) — negative feedback, corr
            // settles at the band's fractional-bin drift. The -corr form was
            // positive feedback ((1+alpha)·corr) and ran every band to the ±pi
            // rail, leaving it inverted.
            var cr = Math.cos(corr[j]), ci = Math.sin(corr[j]);
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

    // ---------- Tilt: post-OLA per-group DSB shift ----------
    // The earlier per-frame bin rotation could not shift: a constant per-frame
    // phase offset is invisible within a frame, and its inter-frame staircase
    // collapses any shift near a multiple of fs/hop (46.875 Hz). The shift now
    // runs on the finalised output samples: an LR4 3-way split (2x Butterworth
    // LP at 200 Hz, 2x HP at 2000 Hz, mid by complementary subtraction) with
    // each group ring-modulated by cos(2*Pi*s*t). A tone f becomes sidebands
    // at f+-s and no carrier — the down-shifted image is the planned phaser
    // character, not a bug.
    var tiltFilt = null;
    function initTilt() {
      // RBJ biquads, normalised. Two cascaded Butterworth sections each side
      // make the LR4 edges; the mid band is the complementary remainder, so
      // lp + bp + hp == x exactly and a neutral tilt is an identity.
      function rbj(type, f0, Q) {
        var w0 = 2 * Math.PI * f0 / fs, cw = Math.cos(w0), sn = Math.sin(w0);
        var al = sn / (2 * Q), a0 = 1 + al;
        var b0, b1, b2;
        if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
        else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
        return [b0 / a0, b1 / a0, b2 / a0, -2 * cw / a0, (1 - al) / a0];
      }
      tiltFilt = { lp: rbj('lp', 200, Math.SQRT1_2), hp: rbj('hp', 2000, Math.SQRT1_2) };
    }
    initTilt();
    // per-channel biquad state, direct form I: [x1, x2, y1, y2] for each of
    // the two LP sections and two HP sections. tiltPhase is the shared
    // ring-mod phase state declared with the other engine state above.
    var tiltS = [ [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] ];
    function biquad(x, c, s, o) {
      var y = c[0] * x + c[1] * s[o] + c[2] * s[o + 1] - c[3] * s[o + 2] - c[4] * s[o + 3];
      s[o + 1] = s[o]; s[o] = x; s[o + 3] = s[o + 2]; s[o + 2] = y;
      return y;
    }
    function applyTilt(bufL, bufR, n) {
      var clp = tiltFilt.lp, chp = tiltFilt.hp;
      var w0 = 2 * Math.PI * tiltNow[0] / fs, w1 = 2 * Math.PI * tiltNow[1] / fs, w2 = 2 * Math.PI * tiltNow[2] / fs;
      var p0 = tiltPhase[0], p1 = tiltPhase[1], p2 = tiltPhase[2];
      var TwoPi = 2 * Math.PI;
      // One oscillator shared by both channels: the phase advances once per
      // sample INDEX, not once per sample-channel. Advancing inside a
      // per-channel loop doubles the shift rate (the ch=1 pass adds another
      // n·w to the saved phase before the next call's ch=0 pass).
      for (var i = 0; i < n; i++) {
        var c0 = Math.cos(p0), c1 = Math.cos(p1), c2 = Math.cos(p2);
        for (var ch = 0; ch < 2; ch++) {
          var buf = ch === 0 ? bufL : bufR;
          var s = tiltS[ch];
          var x = buf[i];
          var lp = biquad(biquad(x, clp, s, 0), clp, s, 4);
          var hp = biquad(biquad(x, chp, s, 8), chp, s, 12);
          var bp = x - lp - hp;
          buf[i] = lp * c0 + bp * c1 + hp * c2;
        }
        p0 += w0; if (p0 > TwoPi) p0 -= TwoPi;
        p1 += w1; if (p1 > TwoPi) p1 -= TwoPi;
        p2 += w2; if (p2 > TwoPi) p2 -= TwoPi;
      }
      tiltPhase[0] = p0; tiltPhase[1] = p1; tiltPhase[2] = p2;
    }

    return engine;
  }

  root.RDPipeline = {
    createEngine: createEngine, makeFFT: makeFFT,
    sineWindow: sineWindow, startWindow: startWindow, stopWindow: stopWindow,
    buildBands: buildBands, bandCount: bandCount,
    BARK_EDGES_HZ: BARK_EDGES_HZ, barkOf: barkOf, ath: ath,
    foldWeights: foldWeights, mulberry32: mulberry32, isBypass: isBypass,
    detectChord: detectChord, followInterval: followInterval,
    CHORD_TEMPLATES: CHORD_TEMPLATES
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.RDPipeline;
  }
})(typeof self !== 'undefined' ? self : globalThis);