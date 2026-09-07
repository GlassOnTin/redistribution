#!/usr/bin/env node
// render.js — offline CLI render: a built-in loop (--synth <id>) or a WAV file
// (--in <file.wav>) through the pipeline, producing a WAV and a spectrogram
// PNG of the output. Also the gravity param-sweep grid that closes M1.
//
//   node tools/render.js --synth drums --p budget=0.6 --p gravity=0.8 --outdir out/
//   node tools/render.js --in clip.wav --outdir out/
//   node tools/render.js --synth sweep --sweep-gravity 0,0.3,0.6,1.0 --outdir sweep/
//
// The spectrogram is an independent STFT of the engine's output (sine window,
// hop 512, log-frequency rows, max-pooled per pixel) — it does not reuse the
// engine's band taps, so a bug in the taps cannot make the picture lie. A
// sidecar .json records fs/hop/fmin/floor so the PNG is readable without
// guessing the mapping.
'use strict';
var fs = require('fs');
var path = require('path');
var RD = require('../params.js');
var P = require('../pipeline.js');
var Loops = require('../loops.js');
var Wav = require('../wav.js');
var Png = require('./png.js');

// ---------- args ----------
var args = process.argv.slice(2);
function argValue(name) {
  var i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
function hasFlag(name) { return args.indexOf(name) >= 0; }

var srcLoop = argValue('--synth');
var inFile = argValue('--in');
var outdir = argValue('--outdir') || 'out';
var seconds = argValue('--seconds') ? parseFloat(argValue('--seconds')) : null;
var sweepGravity = argValue('--sweep-gravity');
var vox = argValue('--vox') ? parseInt(argValue('--vox'), 10) : 1;

// --p key=value overrides (repeatable)
var overrides = {};
for (var i = 0; i < args.length - 1; i++) {
  if (args[i] === '--p') {
    var kv = args[i + 1].split('=');
    overrides[kv[0]] = kv[1];
  }
}

if (!srcLoop && !inFile && !sweepGravity) {
  console.error('nothing to do: pass --synth <id>, --in <file.wav> and/or --sweep-gravity');
  process.exit(2);
}

// ---------- one render ----------
// returns {left, right, fs, frames}
function renderOne(over) {
  over = over || {};
  var o = {};
  for (var k0 in overrides) o[k0] = overrides[k0];
  for (k0 in over) o[k0] = over[k0];
  var fsr = 48000;
  var inL, inR, name;
  if (inFile) {
    var w = Wav.readWav(fs.readFileSync(inFile));
    fsr = w.sampleRate;
    inL = w.data[0]; inR = w.data[1] || w.data[0];
    name = path.basename(inFile).replace(/\.wav$/i, '');
  } else {
    var id = srcLoop || 'drums';
    var l = Loops.render(id, fsr);
    inL = l.left; inR = l.right;
    name = id;
  }
  var N = seconds ? Math.min(Math.floor(seconds * fsr), inL.length) : inL.length;
  var eng = P.createEngine(fsr, { defaults: RD.DEFAULTS });
  for (var k in o) {
    var v = o[k];
    eng.params[k] = (v === 'true') ? true : (v === 'false') ? false :
      (RD.PARAMS.some(function (p) { return p.key === k && p.options; }) ? v : parseFloat(v));
  }
  var scale = RD.budgetScale(vox);
  if (scale !== 1 && o.budget === undefined) eng.params.budget = RD.DEFAULTS.budget * scale;

  var CH = 1024;
  var aL = new Float32Array(CH), aR = new Float32Array(CH);
  var oL = new Float32Array(CH), oR = new Float32Array(CH);
  var outL = new Float32Array(N), outR = new Float32Array(N);
  var pos = 0, got = 0, flushed = 0;
  while (pos < N || got < N) {
    var n;
    if (pos < N) {
      n = Math.min(CH, N - pos);
      for (var j = 0; j < n; j++) { aL[j] = inL[pos + j]; aR[j] = inR[pos + j]; }
      pos += n;
    } else {
      n = CH; aL.fill(0); aR.fill(0);   // flush tail: the engine's latency
      if (++flushed > 4096) break;      // hard stop against a wedged scheduler
    }
    var give = eng.process(aL, aR, oL, oR, n);
    for (j = 0; j < give && got < N; j++) { outL[got + j] = oL[j]; outR[got + j] = oR[j]; }
    got += give;
  }
  return { left: outL, right: outR, fs: fsr, name: name, frames: eng.stats.frames,
    longs: eng.stats.longs, shorts: eng.stats.shorts, switches: eng.stats.switches };
}

// ---------- spectrogram (independent STFT) ----------
var SPEC = { fft: 2048, hop: 512, fmin: 30, floorDb: 72, height: 512 };

function spectrumPalette(v) {
  // 4-stop ramp: near-black -> violet -> red-orange -> yellow-white
  var stops = [
    [8, 6, 20], [64, 20, 96], [232, 90, 26], [252, 212, 60], [255, 252, 224]
  ];
  var t = v * (stops.length - 1);
  var s0 = Math.min(Math.floor(t), stops.length - 2), f = t - s0;
  var a = stops[s0], b = stops[s0 + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function spectrogram(sig, fsr) {
  var W = SPEC.fft, K = W >> 1, H = SPEC.hop;
  var framesN = Math.max(1, Math.floor((sig.length - W) / H) + 1);
  var win = new Float64Array(W);
  // Nuttall: sidelobes ~ -93 dB, so a loud trace does not paint the whole
  // axis through leakage (the sine window decays only ~12 dB/octave). This
  // STFT is display-only — the engine's own TDAC window is untouched.
  for (var n = 0; n < W; n++) {
    var t = 2 * Math.PI * n / W;
    win[n] = 0.355768 - 0.487396 * Math.cos(t) + 0.144232 * Math.cos(2 * t) - 0.012604 * Math.cos(3 * t);
  }
  var fft = P.makeFFT(W);
  var re = new Float64Array(W), im = new Float64Array(W);
  var img = new Uint8Array(framesN * SPEC.height * 4);

  // pixel-row -> frequency edges (log axis, fmin .. fs/2)
  var fLo = new Float64Array(SPEC.height), fHi = new Float64Array(SPEC.height);
  var r0 = Math.log(SPEC.fmin), r1 = Math.log(fsr / 2);
  for (var row = 0; row < SPEC.height; row++) {
    var fA = Math.exp(r0 + (r1 - r0) * (SPEC.height - 1 - row) / SPEC.height);
    var fB = Math.exp(r0 + (r1 - r0) * (SPEC.height - row) / SPEC.height);
    fLo[row] = fA; fHi[row] = Math.max(fB, fA * 1.001);
  }

  // pass 1: per-pixel dB (max-pooled over each row's frequency span)
  var db = new Float32Array(framesN * SPEC.height);
  var maxDb = -Infinity;
  var f = 0, row, n;
  for (f = 0; f < framesN; f++) {
    var off = f * H;
    for (n = 0; n < W; n++) { re[n] = sig[off + n] * win[n]; im[n] = 0; }
    fft.forward(re, im);
    for (row = 0; row < SPEC.height; row++) {
      var b0 = Math.max(1, Math.floor(fLo[row] / fsr * W));
      var b1 = Math.min(W >> 1, Math.ceil(fHi[row] / fsr * W));
      var mx = 0;
      for (var k = b0; k <= b1; k++) {
        var m = re[k] * re[k] + im[k] * im[k];
        if (m > mx) mx = m;
      }
      var d = 10 * Math.log10(mx + 1e-12);        // power -> dB
      db[f * SPEC.height + row] = d;
      if (d > maxDb) maxDb = d;
    }
  }
  // pass 2: map against a per-image floor (the absolute noise level varies
  // wildly with Budget; a fixed floor saturates the picture)
  var floor = maxDb - SPEC.floorDb;
  for (f = 0; f < framesN; f++) {
    for (row = 0; row < SPEC.height; row++) {
      var v = Math.max(0, Math.min(1, (db[f * SPEC.height + row] - floor) / SPEC.floorDb));
      var c = spectrumPalette(v);
      var o = (f * SPEC.height + row) * 4;   // row 0 = Nyquist -> top: low freq at bottom
      img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; img[o + 3] = 255;
    }
  }
  return { rgba: img, width: framesN, height: SPEC.height, maxDb: maxDb, floorDb: floor };
}

// ---------- sweep grid ----------
function sweepGrid() {
  var gravities = sweepGravity.split(',').map(parseFloat);
  var specs = [], widths = [];
  for (var gi = 0; gi < gravities.length; gi++) {
    var g = gravities[gi];
    var r = renderOne({ gravity: g });
    var stem = path.join(outdir, 'sweep-g' + g.toFixed(2).replace('.', ''));
    fs.writeFileSync(stem + '.wav', Buffer.from(Wav.writeWav([r.left, r.right], r.fs)));
    var spec = spectrogram(monoOf(r), r.fs);
    fs.writeFileSync(stem + '.png', Buffer.from(Png.writePNG(spec.rgba, spec.width, spec.height)));
    fs.writeFileSync(stem + '.json', JSON.stringify(specMeta(r, spec, { gravity: g }), null, 2));
    console.log('gravity ' + g + ': ' + spec.width + 'x' + spec.height + ' -> ' + stem + '.{wav,png}');
    specs.push(spec);
    widths.push(spec.width);
  }
  // vertical stack of equal-height spectrograms, 2 px separator
  var w = Math.max.apply(null, widths), hTot = specs.length * (SPEC.height + 2);
  var grid = new Uint8Array(w * hTot * 4);
  for (var s = 0; s < specs.length; s++) {
    for (var y = 0; y < SPEC.height; y++) {
      for (var x = 0; x < specs[s].width; x++) {
        var so = (y * specs[s].width + x) * 4;
        var doo = ((s * (SPEC.height + 2) + y) * w + x) * 4;
        grid[doo] = specs[s].rgba[so]; grid[doo + 1] = specs[s].rgba[so + 1];
        grid[doo + 2] = specs[s].rgba[so + 2]; grid[doo + 3] = 255;
      }
    }
  }
  var gridPath = path.join(outdir, 'sweep-grid.png');
  fs.writeFileSync(gridPath, Buffer.from(Png.writePNG(grid, w, hTot)));
  console.log('grid: ' + w + 'x' + hTot + ' -> ' + gridPath);
}

// ---------- single render ----------
function single() {
  var r = renderOne(overrides);
  fs.mkdirSync(outdir, { recursive: true });
  var stem = path.join(outdir, r.name + (Object.keys(overrides).length ? '-p' : ''));
  fs.writeFileSync(stem + '.wav', Buffer.from(Wav.writeWav([r.left, r.right], r.fs)));
  var spec = spectrogram(monoOf(r), r.fs);
  fs.writeFileSync(stem + '.png', Buffer.from(Png.writePNG(spec.rgba, spec.width, spec.height)));
  fs.writeFileSync(stem + '.json', JSON.stringify(specMeta(r, spec, overrides), null, 2));
  console.log(r.name + ': ' + r.frames + ' frames (' + r.longs + ' long / ' + r.shorts +
    ' short / ' + r.switches + ' switches) -> ' + stem + '.{wav,png,json}');
}

function monoOf(r) {
  var n = r.left.length, m = new Float32Array(n);
  for (var i = 0; i < n; i++) m[i] = 0.5 * (r.left[i] + r.right[i]);
  return m;
}

function specMeta(r, spec, paramsUsed) {
  return {
    fs: r.fs, fft: SPEC.fft, hop: SPEC.hop, window: 'nuttall',
    fmin: SPEC.fmin, fmax: r.fs / 2, yAxis: 'log-frequency, bottom = fmin',
    floorDb: spec.floorDb, maxDb: spec.maxDb, palette: 'black->violet->orange->yellow (4 stops)',
    source: 'engine output, mono mix',
    frames: r.frames, longs: r.longs, shorts: r.shorts, switches: r.switches,
    params: paramsUsed
  };
}

fs.mkdirSync(outdir, { recursive: true });
if (sweepGravity) sweepGrid(); else single();