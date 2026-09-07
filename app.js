// app.js — live page: builds the AudioWorklet from a Blob of
// pipeline.js + params.js + worklet-effect.js (no build step), plays a built-in
// loop through the single shared effect, and drives the UI + waterfall.
'use strict';

const $ = (id) => document.getElementById(id);
const status = (msg, bad) => {
  const el = $('status');
  el.textContent = msg;
  el.style.color = bad ? '#ff5b4a' : '#9be8c0';
};
const fail = (msg) => { status(msg, true); throw new Error(msg); };

// ---------- module loading ----------

// two blob modules: the effect (pipeline + params + effect) and the synth
// (synth + synth worklet). The AudioWorklet global scope has no
// importScripts, so each blob must carry its own dependencies.
async function loadWorkletSource() {
  const v = new URLSearchParams(location.search).get('v') || '1';
  const add = async (files) => {
    const texts = [];
    for (const f of files) {
      const r = await fetch(f + '?v=' + v);
      if (!r.ok) throw new Error(f + ': HTTP ' + r.status);
      texts.push(await r.text());
    }
    const url = URL.createObjectURL(new Blob(texts, { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
  };
  await add(['pipeline.js', 'params.js', 'worklet-effect.js']);
  await add(['synth.js', 'worklet-synth.js']);
}

// ---------- graph ----------
let ctx = null, effectNode = null, synthNode = null;
async function start() {
  if (ctx) return;
  // pin 48000: the engine is benched at 48k budgets, and a 96/192 kHz device
  // shrinks the quantum deadline below what it reliably meets (Chrome then
  // backs up the worklet input FIFO and delivery drifts). Chrome resamples
  // the hardware stream, so 44.1/48/96k devices are unaffected in practice.
  ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
  status('loading worklet modules...');
  await loadWorkletSource();
  effectNode = new AudioWorkletNode(ctx, 'redistribution-effect', {
    numberOfInputs: 4, numberOfOutputs: 1,
    outputChannelCount: [2]
  });
  effectNode.port.onmessage = onTaps;
  effectNode.connect(ctx.destination);
  effectNode.port.postMessage({ type: 'taps', on: true, every: 2 });
  synthNode = new AudioWorkletNode(ctx, 'redistribution-synth', {
    numberOfInputs: 0, numberOfOutputs: 1,
    outputChannelCount: [2]
  });
  synthNode.port.onmessage = onVoices;
  synthNode.connect(effectNode);     // shares the one engine with the loops
  sendAllParams();
  status('engine running at ' + ctx.sampleRate + ' Hz — pick a loop or play');
  $('start').disabled = true;
  $('loopsel').disabled = false;
  $('play').disabled = false;
}

// ---------- loop playback ----------
let srcNode = null;

async function playLoop(id) {
  stopLoop();
  const loop = RDLoops.render(id, ctx.sampleRate);
  const buf = ctx.createBuffer(2, loop.left.length, ctx.sampleRate);
  buf.copyToChannel(loop.left, 0);
  buf.copyToChannel(loop.right, 1);
  srcNode = ctx.createBufferSource();
  srcNode.buffer = buf;
  srcNode.loop = true;
  srcNode.connect(effectNode);
  srcNode.start();
  $('play').textContent = 'Stop';
}

function stopLoop() {
  if (srcNode) { try { srcNode.stop(); } catch (e) {} srcNode.disconnect(); srcNode = null; }
  $('play').textContent = 'Play';
}

// ---------- params ----------
// log_2 slider law (Budget): the slider position is an exponent, so equal
// moves are equal RATIOS of budget. Bits are a power-of-two domain (per-band
// scalefactors are 2^sf), and the audible action sits in the low end — a
// linear slider spent half its travel on 0.5..1, which all sounds alike,
// while the interesting 0.05..0.2 got 0.01 steps. t = 0 is a true zero
// (nothing coded); the exponent runs [log2Min, log2Max] across the travel.
function sliderToVal(meta, t) {
  t = parseFloat(t);
  if (!(t > 0)) return 0;
  return Math.pow(2, meta.log2Min + (meta.log2Max - meta.log2Min) * t);
}
function valToSlider(meta, v) {
  if (!(v > 0)) return 0;
  return (Math.log2(v) - meta.log2Min) / (meta.log2Max - meta.log2Min);
}

function currentParams() {
  const p = {};
  for (const el of document.querySelectorAll('[data-param]')) {
    const meta = RDParams.PARAMS.find((q) => q.key === el.dataset.param);
    p[el.dataset.param] = meta && meta.options ? el.value
      : meta && meta.kind === 'bool' ? el.checked
      : meta && meta.log2 ? sliderToVal(meta, el.value)
      : parseFloat(el.value);
  }
  return p;
}

let voiceCount = 0;
let synthLastWaveform = 'saw';

// synth -> main -> effect: the voice count rides through here (the main
// thread is the bus between worklets). Dense chords eat the bit budget via
// budgetScale, so the masking model degrades them unevenly — that unevenness
// is the point of the coupling.
function onVoices(e) {
  const m = e.data;
  if (m.type !== 'voices') return;
  const was = voiceCount;
  voiceCount = m.count;
  $('voices').textContent = voiceCount > 0
    ? voiceCount + ' voice' + (voiceCount > 1 ? 's' : '') : '';
  if (was === 0 && voiceCount > 0) {
    // playing the synth wants lower latency; suggest the short frame once
    // per activation. The user can put it back — this is a nudge, not a lock.
    const frame = document.querySelector('[data-param=frame]');
    if (frame && frame.value === 'long') frame.value = 'short';
  }
  sendAllParams();
}

function sendAllParams() {
  if (!effectNode) return;
  const p = currentParams();
  if (p.voiceWaveform !== undefined && synthNode &&
      p.voiceWaveform !== synthLastWaveform) {
    synthLastWaveform = p.voiceWaveform;
    synthNode.port.postMessage({ type: 'waveform', waveform: p.voiceWaveform });
  }
  delete p.voiceWaveform;              // the engine has no such param
  p.budget = p.budget * RDParams.budgetScale(voiceCount);
  effectNode.port.postMessage({ type: 'params', p });
}

function buildParamUI() {
  const named = $('params-named'), adv = $('params-adv');
  for (const meta of RDParams.PARAMS) {
    const row = document.createElement('label');
    row.className = 'prow';
    const name = document.createElement('span');
    name.textContent = meta.label;
    name.title = meta.hint;
    row.appendChild(name);
    let input;
    if (meta.options) {
      input = document.createElement('select');
      for (const o of meta.options) {
        const op = document.createElement('option');
        op.value = op.textContent = o;
        input.appendChild(op);
      }
      input.value = meta.def;
    } else if (meta.kind === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = meta.def;
    } else {
      input = document.createElement('input');
      input.type = 'range';
      if (meta.log2) {
        input.min = 0; input.max = 1; input.step = 0.001;
        input.value = valToSlider(meta, meta.def);
      } else {
        input.min = meta.min; input.max = meta.max; input.step = meta.step;
        input.value = meta.def;
      }
      const val = document.createElement('span');
      val.className = 'pval';
      const show = () => { val.textContent = meta.log2
        ? sliderToVal(meta, input.value).toFixed(3)
        : meta.unit === 's' && meta.log
        ? (+input.value).toFixed(2) + ' s'
        : input.value + (meta.unit ? ' ' + meta.unit : ''); };
      input.addEventListener('input', show); show();
      row.appendChild(val);
      row._val = val;
    }
    input.dataset.param = meta.key;
    input.id = 'p-' + meta.key;
    input.addEventListener('input', () => {
      if (row._val && input.type === 'range') {
        row._val.textContent = (meta.log2 ? sliderToVal(meta, input.value).toFixed(3)
          : (meta.log ? (+input.value).toFixed(2) : input.value)) +
          (meta.unit ? ' ' + meta.unit : '');
      }
      sendAllParams();
    });
    row.appendChild(input);
    (meta.advanced ? adv : named).appendChild(row);
  }
}

// ---------- taps -> waterfall ----------
const canvas = $('spec');
const g2d = canvas.getContext('2d');
const ROWS = canvas.height;

// palette LUT, same 5 stops as the offline PNG renderer (render.js)
const PALETTE = (() => {
  const stops = [
    [8, 6, 20], [64, 20, 96], [232, 90, 26], [252, 212, 60], [255, 252, 224]
  ];
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (stops.length - 1);
    const s0 = Math.min(Math.floor(t), stops.length - 2), f = t - s0;
    const a = stops[s0], b = stops[s0 + 1];
    lut[i * 3] = a[0] + (b[0] - a[0]) * f;
    lut[i * 3 + 1] = a[1] + (b[1] - a[1]) * f;
    lut[i * 3 + 2] = a[2] + (b[2] - a[2]) * f;
  }
  return lut;
})();
// row frequency edges (log axis, fmin .. Nyquist; row 0 = top = Nyquist) —
// same axis as the offline PNG renderer
const FMIN = 30;
const rowEdge = (fs) => {
  const e = new Float64Array(ROWS + 1);
  const r0 = Math.log(FMIN), r1 = Math.log(fs / 2);
  for (let r = 0; r <= ROWS; r++)
    e[r] = Math.exp(r1 + (r0 - r1) * r / ROWS);
  return e;
};
let rowEdges = null, rowFs = 0;

// bin -> canvas y for the overlay (log axis, as above)
function binY(bin, fs, w) {
  const f = bin * fs / w;
  const t = (Math.log(Math.max(f, FMIN)) - Math.log(FMIN)) /
    (Math.log(fs / 2) - Math.log(FMIN));
  return (1 - Math.max(0, Math.min(1, t))) * ROWS;
}

let refDb = -80;
let refDbSeeded = false;

function onTaps(e) {
  const m = e.data;
  if (m.type !== 'taps') return;
  const w = canvas.width;
  g2d.drawImage(canvas, -1, 0);
  g2d.fillStyle = '#080614';
  g2d.fillRect(w - 1, 0, 1, ROWS);

  if (m.bins && m.bins.length > 2) {
    if (rowFs !== m.fs) { rowEdges = rowEdge(m.fs); rowFs = m.fs; }
    // the bins are the engine's own post-warp spectrum (left channel) on the
    // frame's grid: transform size 2K, bin k at k*fs/2K. Paint per pixel row
    // by max-pooling the bins inside the row's frequency span — the same
    // construction as the offline PNG, so live and offline read the same.
    const K = m.bins.length;
    const df = m.fs / (2 * (K - 1));
    const FLOOR = 72;                    // display range in dB, as offline
    let peak = -Infinity;
    const col = g2d.createImageData(1, ROWS);
    for (let r = 0; r < ROWS; r++) {
      const fHi = rowEdges[r], fLo = rowEdges[r + 1];
      let k0 = Math.max(1, Math.ceil(fLo / df));
      let k1 = Math.min(K - 1, Math.floor(fHi / df));
      if (k1 < k0) k1 = k0;              // row narrower than a bin
      let mx = 0;
      for (let k = k0; k <= k1; k++) {
        const p = m.bins[k] * m.bins[k];
        if (p > mx) mx = p;
      }
      const db = 10 * Math.log10(mx + 1e-12);
      if (db > peak) peak = db;
      const v = Math.max(0, Math.min(1, (db - (refDb - FLOOR)) / FLOOR));
      const ci = (v * 255) | 0, o = r * 4;
      col.data[o] = PALETTE[ci * 3];
      col.data[o + 1] = PALETTE[ci * 3 + 1];
      col.data[o + 2] = PALETTE[ci * 3 + 2];
      col.data[o + 3] = 255;
    }
    // reference: fast attack, slow release — a kick must not wash the
    // history, and a quiet passage must not blackhole it. The first tap
    // seeds directly: ramping up from -80 paints a saturated startup bar.
    if (!refDbSeeded) { refDb = peak; refDbSeeded = true; }
    else refDb += (peak > refDb ? 0.5 : 0.02) * (peak - refDb);
    g2d.putImageData(col, w - 1, 0);

    // warp overlay: a blue tick at each folded band's original top edge —
    // the energy paints at its destination (the bins are already warped),
    // so the vertical gap between tick and energy is the fold distance.
    // One dim pixel per band: at one column per tap the ticks stack into
    // persistent lines anyway, and a brighter mark buries the energy.
    const B = m.edge.length - 1;
    g2d.fillStyle = 'rgba(110,170,255,0.3)';
    for (let b = 0; b < B; b++) {
      if (m.destEdge[b + 1] < m.edge[b + 1]) {
        const y = binY(m.edge[b + 1], m.fs, 2 * (K - 1));
        g2d.fillRect(w - 1, y, 1, 1);
      }
    }
  }

  $('latency').textContent = m.latencyMs.toFixed(0) + ' ms' +
    (m.short ? ' (short)' : '') + ' · ' + m.stats.frames + ' frames, ' +
    m.stats.switches + ' switches';
}

// ---------- keyboard + on-screen keys ----------
const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9,
  u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17 };
let octShift = 0;
const heldNotes = new Map();          // key (or pointer id) -> midi note

function noteOn(note, vel) {
  if (!synthNode) return;
  synthNode.port.postMessage({ type: 'note', note, on: true, vel });
  markKey(note, true);
}
function noteOff(note) {
  if (!synthNode) return;
  synthNode.port.postMessage({ type: 'note', note, on: false });
  markKey(note, false);
}
function markKey(note, on) {
  const el = document.querySelector('[data-note="' + note + '"]');
  if (el) el.classList.toggle('on', on);
}
function setOct(s) {
  octShift = Math.max(-2, Math.min(2, s));
  $('oct').textContent = 'C' + (4 + octShift) + ' base';
}

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.key === 'z') return setOct(octShift - 1);
  if (e.key === 'x') return setOct(octShift + 1);
  const off = KEYMAP[e.key.toLowerCase()];
  if (off === undefined || heldNotes.has(e.key.toLowerCase())) return;
  const note = 60 + off + 12 * octShift;
  heldNotes.set(e.key.toLowerCase(), note);
  noteOn(note);
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  const note = heldNotes.get(k);
  if (note === undefined) return;
  heldNotes.delete(k);
  noteOff(note);
});

// on-screen keys: 2 octaves from C4 + top C, same note numbers as QWERTY
function buildKeys() {
  const box = $('keys');
  const WHITE = [0, 2, 4, 5, 7, 9, 11];
  const BLACK = { 1: 0.72, 3: 1.72, 6: 3.22, 8: 4.22, 10: 5.22 };
  const whites = [];
  for (let o = 0; o < 2; o++)
    for (const s of WHITE) whites.push(60 + o * 12 + s);
  whites.push(84);
  const blackAt = (note) => {
    const o = Math.floor((note - 60) / 12), s = (note - 60) % 12;
    const wi = o * 7 + WHITE.indexOf(s - 1) + 1;   // white key it hugs
    return (wi - BLACK[s]) / whites.length;
  };
  for (const note of whites) {
    const el = document.createElement('div');
    el.className = 'wkey';
    el.dataset.note = note;
    const press = (ev) => {
      ev.preventDefault();
      heldNotes.set('ptr' + ev.pointerId, note);
      noteOn(note);
    };
    const lift = (ev) => {
      if (heldNotes.get('ptr' + ev.pointerId) !== note) return;
      heldNotes.delete('ptr' + ev.pointerId);
      noteOff(note);
    };
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', lift);
    el.addEventListener('pointercancel', lift);
    el.addEventListener('pointerleave', lift);
    box.appendChild(el);
  }
  for (let o = 0; o < 2; o++)
    for (const s of Object.keys(BLACK)) {
      const note = 60 + o * 12 + +s;
      const el = document.createElement('div');
      el.className = 'bkey';
      el.dataset.note = note;
      el.style.left = (blackAt(note) * 100) + '%';
    const press = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      heldNotes.set('ptr' + ev.pointerId, note);
      noteOn(note);
    };
    const lift = (ev) => {
      if (heldNotes.get('ptr' + ev.pointerId) !== note) return;
      heldNotes.delete('ptr' + ev.pointerId);
      noteOff(note);
    };
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', lift);
    el.addEventListener('pointercancel', lift);
    el.addEventListener('pointerleave', lift);
    box.appendChild(el);
  }
}

$('savepng').addEventListener('click', () => {
  canvas.toBlob((blob) => {
    if (!blob) return status('PNG export failed', true);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'redistribution-' + new Date().toISOString()
      .replace(/[:.]/g, '-') + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
});

// ---------- wire up ----------
buildKeys();
setOct(0);
buildParamUI();
$('start').addEventListener('click', () => start().catch((e) => status(String(e), true)));
$('play').addEventListener('click', () => {
  if (!ctx) return;
  if (srcNode) stopLoop();
  else playLoop($('loopsel').value).catch((e) => status(String(e), true));
});
$('loopsel').addEventListener('change', () => { if (srcNode) playLoop($('loopsel').value); });
$('panic').addEventListener('click', () => {
  if (effectNode) effectNode.port.postMessage({ type: 'reset' });
  if (synthNode) synthNode.port.postMessage({ type: 'alloff' });
  for (const k of heldNotes.keys()) {
    const note = heldNotes.get(k);
    if (typeof note === 'number') { noteOff(note); markKey(note, false); }
  }
  heldNotes.clear();
  stopLoop();
});
if (window.__preModuleErrors && window.__preModuleErrors.length) {
  status('page errors before module load: ' + window.__preModuleErrors.join('; '), true);
} else {
  status('click Start (audio needs a user gesture)');
}