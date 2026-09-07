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
function currentParams() {
  const p = {};
  for (const el of document.querySelectorAll('[data-param]')) {
    const meta = RDParams.PARAMS.find((q) => q.key === el.dataset.param);
    p[el.dataset.param] = meta && meta.options ? el.value
      : meta && meta.kind === 'bool' ? el.checked : parseFloat(el.value);
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
      input.min = meta.min; input.max = meta.max; input.step = meta.step;
      input.value = meta.def;
      const val = document.createElement('span');
      val.className = 'pval';
      const show = () => { val.textContent = meta.unit === 's' && meta.log
        ? (+input.value).toFixed(2) + ' s'
        : input.value + (meta.unit ? ' ' + meta.unit : ''); };
      input.addEventListener('input', show); show();
      row.appendChild(val);
      row._val = val;
    }
    input.dataset.param = meta.key;
    input.addEventListener('input', () => {
      if (row._val && input.type === 'range') {
        row._val.textContent = (meta.log ? (+input.value).toFixed(2) : input.value) +
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

function bandY(bin, fs, h, w) {
  // log-frequency row for a bin edge, low frequency at the bottom. Bins are
  // DFT bins of the frame's transform (size 2W), which differs per grid.
  const f = bin * fs / (2 * w);
  const fmin = 30, fmax = fs / 2;
  const t = (Math.log(Math.max(f, fmin)) - Math.log(fmin)) / (Math.log(fmax) - Math.log(fmin));
  return h - t * h;                          // canvas y (0 = top)
}

const palette = [
  [8, 6, 20], [64, 20, 96], [232, 90, 26], [252, 212, 60], [255, 252, 224]
];
function specColour(v) {
  const t = Math.max(0, Math.min(1, v)) * (palette.length - 1);
  const s0 = Math.min(Math.floor(t), palette.length - 2), f = t - s0;
  const a = palette[s0], b = palette[s0 + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f].map(Math.round);
}

let refDb = -100;    // slow adaptive reference, updated per tap

function onTaps(e) {
  const m = e.data;
  if (m.type !== 'taps') return;
  const h = canvas.height, w = canvas.width;
  // scroll left by 1 column, draw the new one at the right edge
  g2d.drawImage(canvas, -1, 0);
  g2d.fillStyle = '#080614';
  g2d.fillRect(w - 1, 0, 1, h);

  // bandsE is linear band power (the allocation path logs it itself); convert
  // here. Slow peak tracker sets the display reference.
  let peak = -Infinity;
  const db = new Float64Array(m.bandsE.length);
  for (let b = 0; b < m.bandsE.length; b++) {
    db[b] = 10 * Math.log10(m.bandsE[b] + 1e-12);
    if (db[b] > peak) peak = db[b];
  }
  refDb += 0.05 * (peak - refDb);

  const B = m.edge.length - 1;
  const floor = 60;
  for (let b = 0; b < B; b++) {
    const v = Math.max(0, Math.min(1, (db[b] - (refDb - floor)) / floor));
    const [r, g, bl] = specColour(v);
    const yTop = bandY(m.destEdge[b], m.fs, h, m.W);
    const yBot = bandY(m.destEdge[b + 1], m.fs, h, m.W);
    g2d.fillStyle = `rgb(${r},${g},${bl})`;
    g2d.fillRect(w - 1, Math.min(yTop, yBot), 1, Math.max(1, Math.abs(yBot - yTop)));
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