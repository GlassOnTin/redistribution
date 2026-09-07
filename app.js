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

// real implementation (the stub above exists only to document the shape)
async function loadWorkletSource() {
  const v = new URLSearchParams(location.search).get('v') || '1';
  const texts = [];
  for (const f of ['pipeline.js', 'params.js', 'worklet-effect.js']) {
    const r = await fetch(f + '?v=' + v);
    if (!r.ok) throw new Error(f + ': HTTP ' + r.status);
    texts.push(await r.text());
  }
  const blob = new Blob(texts, { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
}

// ---------- graph ----------
let ctx = null, effectNode = null;
async function start() {
  if (ctx) return;
  ctx = new AudioContext({ latencyHint: 'interactive' });
  status('loading worklet module...');
  await loadWorkletSource();
  effectNode = new AudioWorkletNode(ctx, 'redistribution-effect', {
    numberOfInputs: 4, numberOfOutputs: 1,
    outputChannelCount: [2]
  });
  effectNode.port.onmessage = onTaps;
  effectNode.connect(ctx.destination);
  effectNode.port.postMessage({ type: 'taps', on: true, every: 2 });
  sendAllParams();
  status('engine running at ' + ctx.sampleRate + ' Hz — pick a loop');
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

function sendAllParams() {
  if (!effectNode) return;
  effectNode.port.postMessage({ type: 'params', p: currentParams() });
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

function bandY(bin, fs, h) {
  // log-frequency row for a bin edge, low frequency at the bottom
  // (the engine's long frame is W=2048 -> bin = bin * fs / 4096)
  const f = bin * fs / 4096;
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
    const yTop = bandY(m.destEdge[b], m.fs, h);
    const yBot = bandY(m.destEdge[b + 1], m.fs, h);
    g2d.fillStyle = `rgb(${r},${g},${bl})`;
    g2d.fillRect(w - 1, Math.min(yTop, yBot), 1, Math.max(1, Math.abs(yBot - yTop)));
  }
  $('latency').textContent = m.latencyMs.toFixed(0) + ' ms' +
    (m.short ? ' (short)' : '') + ' · ' + m.stats.frames + ' frames, ' +
    m.stats.switches + ' switches';
}

// ---------- wire up ----------
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
  stopLoop();
});
if (window.__preModuleErrors && window.__preModuleErrors.length) {
  status('page errors before module load: ' + window.__preModuleErrors.join('; '), true);
} else {
  status('click Start (audio needs a user gesture)');
}