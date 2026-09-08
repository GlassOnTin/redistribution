// test-composer.js — the Melody gate. composer.js is main-thread: it eats
// the effect's taps and emits synth note events. The pins here run the real
// state machine on synthetic taps, then one engine-fed run through the
// worklet shim (real taps payload, real pad loop) for the end-to-end rung.
'use strict';
var t = require('./harness.js');
var RDComposer = require('../composer.js');
var RDParams = require('../params.js');
var RDLoops = require('../loops.js');
var fs = require('fs');
var vm = require('vm');
var path = require('path');

var FS = 48000;
var TAPSTRIDE = 2048;                  // ~2 long-frame hops at 48k
var B = 24;                            // band count for synthetic taps

function makeTap(start, chord, e, over) {
  over = over || {};
  var bandsE = new Float32Array(B);
  for (var j = 0; j < B; j++) bandsE[j] = e;
  return {
    type: 'taps', short: false, start: start,
    bandsE: over.bandsE || bandsE,
    edge: new Int32Array(B + 1), destEdge: new Int32Array(B + 1),
    chord: chord, centroid: over.centroid !== undefined ? over.centroid : B / 2,
    starvedN: over.starvedN || 0,
    fs: FS, stats: { frames: 1, switches: 0 }, latencyMs: 0
  };
}

// feed n taps through a fresh composer, return {events, composer}
function run(n, chord, e, over, seed) {
  var c = RDComposer.create({ seed: seed || 0x50a7 });
  c.setParams({ melody: true, density: 0.5, hunt: 0.25 });
  var events = [];
  for (var i = 0; i < n; i++) {
    var tap = makeTap(i * TAPSTRIDE, chord, e, over);
    var evs = c.step(tap, FS);
    for (var k = 0; k < evs.length; k++) events.push(evs[k]);
  }
  return { events: events, composer: c };
}

var ons = function (events) {
  return events.filter(function (ev) { return ev.on; });
};

// worklet shim (same construction as test-worklet.js): real taps payload
function makeWorklet() {
  var registered = {}, posted = [];
  var sandbox = {
    console: console, Math: Math, Float32Array: Float32Array, Int32Array: Int32Array,
    Float64Array: Float64Array, isFinite: isFinite
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.sampleRate = FS;
  sandbox.AudioWorkletProcessor = function () {
    this.port = { onmessage: null, postMessage: function (m) { posted.push(m); } };
  };
  sandbox.registerProcessor = function (name, cls) { registered[name] = cls; };
  vm.createContext(sandbox);
  for (var f of ['params.js', 'pipeline.js', 'worklet-effect.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'),
      sandbox, { filename: f });
  var node = new registered['redistribution-effect']();
  node.__posted = posted;
  return node;
}

t.test('melody off: silence', function () {
  var c = RDComposer.create({ seed: 7 });
  var events = [];
  for (var i = 0; i < 60; i++)
    events = events.concat(c.step(
      makeTap(i * TAPSTRIDE, { root: 9, quality: 'minor', confidence: 0.8 }, 0.5), FS));
  t.ok(ons(events).length === 0, 'no noteOns while melody off');
});

t.test('same seed emits the identical stream, different seed does not', function () {
  var a = run(200, { root: 9, quality: 'minor', confidence: 0.8 }, 0.5);
  var b = run(200, { root: 9, quality: 'minor', confidence: 0.8 }, 0.5);
  var c = run(200, { root: 9, quality: 'minor', confidence: 0.8 }, 0.5, null, 12345);
  t.ok(a.events.length > 50, 'emits at density 0.5 (' + a.events.length + ' events)');
  t.ok(a.events.length === b.events.length, 'same event count');
  var worst = 0;
  for (var i = 0; i < a.events.length; i++) {
    if (a.events[i].note !== b.events[i].note ||
        a.events[i].on !== b.events[i].on ||
        a.events[i].vel !== b.events[i].vel) worst++;
  }
  t.ok(worst === 0, 'same seed identical (' + worst + ' diffs)');
  var differ = c.events.length !== a.events.length;
  for (i = 0; i < Math.min(a.events.length, c.events.length) && !differ; i++) {
    if (c.events[i].note !== a.events[i].note || c.events[i].on !== a.events[i].on)
      differ = true;
  }
  t.ok(differ, 'different seed differs');
});

t.test('density sets the step rate', function () {
  // 10 s of taps: density 0 -> 0.42 s steps (~23 ons), density 1 -> 0.08 s (~125)
  function count(density) {
    var c = RDComposer.create({ seed: 0x50a7 });
    c.setParams({ melody: true, density: density, hunt: 0 });
    var n = 0;
    var taps = Math.ceil(10 * FS / TAPSTRIDE);
    for (var i = 0; i < taps; i++) {
      var evs = c.step(makeTap(i * TAPSTRIDE,
        { root: 0, quality: 'major', confidence: 0.9 }, 0.5), FS);
      for (var k = 0; k < evs.length; k++) if (evs[k].on) n++;
    }
    return n;
  }
  var slow = count(0), fast = count(1);
  t.ok(slow > 0 && slow < 40, 'density 0 is sparse (' + slow + ' ons in 10 s)');
  t.ok(fast > slow * 2, 'density 1 much denser (' + fast + ' vs ' + slow + ')');
});

t.test('notes stay inside the held chord', function () {
  // A minor: pcs {9, 0, 4}; hunt 0 keeps the walk near the centre but the
  // pin is the pitch-class set, not the contour
  var r = run(300, { root: 9, quality: 'minor', confidence: 0.8 }, 0.5, null, 0);
  t.ok(ons(r.events).length > 20, 'plenty of notes');
  var bad = ons(r.events).filter(function (ev) {
    var pc = ((ev.note % 12) + 12) % 12;
    return pc !== 9 && pc !== 0 && pc !== 4;
  });
  t.ok(bad.length === 0, 'all ' + ons(r.events).length +
    ' notes in {A,C,E} (' + bad.length + ' off)');
});

t.test('chordless taps: the voice rests (release-only events)', function () {
  var r = run(200, null, 0.5);
  t.ok(ons(r.events).length === 0, 'no noteOns without a chord');
});

t.test('centroid climb drags the median note up the register', function () {
  var c = RDComposer.create({ seed: 3 });
  c.setParams({ melody: true, density: 0.5, hunt: 0.2 });
  var notes = [];
  var N = 1500;                          // ~250 steps at density 0.5
  for (var i = 0; i < N; i++) {
    var frac = i / N;
    var tap = makeTap(i * TAPSTRIDE, { root: 0, quality: 'major', confidence: 0.9 },
      0.5, { centroid: (0.15 + 0.7 * frac) * B });
    var evs = c.step(tap, FS);
    for (var k = 0; k < evs.length; k++) if (evs[k].on) notes.push(evs[k].note);
  }
  var med = function (arr) {
    var s = arr.slice().sort(function (a, b) { return a - b; });
    return s[Math.floor(s.length / 2)];
  };
  var lo = med(notes.slice(0, 80)), hi = med(notes.slice(-80));
  t.ok(notes.length > 40, 'notes emitted (' + notes.length + ')');
  t.ok(hi > lo + 10, 'median climbs with centroid (' + lo + ' -> ' + hi + ' midi)');
  var range = [Math.min.apply(null, notes), Math.max.apply(null, notes)];
  t.ok(range[0] >= 36 && range[1] <= 96,
    'notes inside register clamp + wander (' + range.join('..') + ')');
});

t.test('band-energy spike fires the onset gate (velocity jump)', function () {
  var c = RDComposer.create({ seed: 11 });
  c.setParams({ melody: true, density: 0.2, hunt: 0 });   // no velocity dither
  var steady = [], spiked = [];
  var i;
  // 100 quiet taps to settle, then measure the last few steady steps
  for (i = 0; i < 120; i++)
    for (var ev of c.step(makeTap(i * TAPSTRIDE,
      { root: 0, quality: 'major', confidence: 0.9 }, 0.1), FS))
      if (ev.on) steady.push(ev.vel);
  // spike: 10x band energy on one tap, then measure the next fired step
  var spikeTap = makeTap(120 * TAPSTRIDE,
    { root: 0, quality: 'major', confidence: 0.9 }, 0.1);
  var big = new Float32Array(B);
  for (i = 0; i < B; i++) big[i] = 1.0;
  spikeTap.bandsE = big;
  c.step(spikeTap, FS);
  for (i = 121; i < 140; i++)
    for (var ev2 of c.step(makeTap(i * TAPSTRIDE,
      { root: 0, quality: 'major', confidence: 0.9 }, 0.1), FS))
      if (ev2.on) spiked.push(ev2.vel);
  t.ok(steady.length > 3, 'steady steps fired (' + steady.length + ')');
  var smin = Math.min.apply(null, steady), smax = Math.max.apply(null, spiked);
  t.ok(smax > smin + 0.1, 'onset step louder (' + smin.toFixed(3) +
    ' steady vs ' + smax.toFixed(3) + ' post-spike)');
});

t.test('budget starvation suppresses non-onset notes', function () {
  var c = RDComposer.create({ seed: 5 });
  c.setParams({ melody: true, density: 0.5, hunt: 0 });
  var i, fired = 0, suppressed = 0;
  // starved + quiet (no flux): every step must be a rest
  for (i = 0; i < 120; i++) {
    var evs = c.step(makeTap(i * TAPSTRIDE,
      { root: 0, quality: 'major', confidence: 0.9 }, 0.5,
      { starvedN: B }), FS);
    if (ons(evs).length) fired++;
  }
  // same feed, nothing starved: notes fire
  for (i = 0; i < 120; i++) {
    var evs2 = c.step(makeTap(10000 * TAPSTRIDE + i * TAPSTRIDE,
      { root: 0, quality: 'major', confidence: 0.9 }, 0.5), FS);
    if (ons(evs2).length) suppressed++;
  }
  t.ok(fired === 0, 'fully starved: no noteOns (' + fired + ')');
  t.ok(suppressed > 10, 'unstarved control fires (' + suppressed + ')');
});

t.test('mono discipline: never more than one held note', function () {
  var r = run(400, { root: 2, quality: 'dom7', confidence: 0.7 }, 0.5, null, 99);
  var held = 0, violations = 0;
  for (var ev of r.events) {
    if (ev.on) { held++; if (held > 1) violations++; }
    else held = Math.max(0, held - 1);
  }
  t.ok(r.events.length > 60, 'event stream present (' + r.events.length + ')');
  t.ok(violations === 0, 'no overlapping holds (' + violations + ' violations)');
});

t.test('short-frame taps advance the clock (no freeze under Frame=short)', function () {
  // regression: the synth-activation nudge puts the engine into short
  // frames; before the clock fix the composer skipped short taps entirely
  // and the held note never released. Long taps settle the register, then
  // only short taps arrive — the line must keep stepping.
  var c = RDComposer.create({ seed: 21 });
  c.setParams({ melody: true, density: 0.6, hunt: 0.25 });
  var i, longOns = 0, shortOns = 0;
  for (i = 0; i < 120; i++) {
    var evs = c.step(makeTap(i * TAPSTRIDE,
      { root: 9, quality: 'minor', confidence: 0.8 }, 0.5), FS);
    if (ons(evs).length) longOns++;
  }
  t.ok(longOns > 5, 'long taps step (' + longOns + ')');
  for (i = 120; i < 300; i++) {
    var tap = makeTap(i * TAPSTRIDE,
      { root: 9, quality: 'minor', confidence: 0.8 }, 0.5);
    tap.short = true;
    var evs2 = c.step(tap, FS);
    if (ons(evs2).length) shortOns++;
  }
  t.ok(shortOns > 5, 'short taps keep stepping (' + shortOns + ' ons)');
});

t.test('short-only stream from t=0 rests instead of emitting sub-audio notes', function () {
  var c = RDComposer.create({ seed: 4 });
  c.setParams({ melody: true, density: 0.6, hunt: 0.25 });
  var low = 0, onsTotal = 0;
  for (var i = 0; i < 200; i++) {
    var tap = makeTap(i * TAPSTRIDE, { root: 9, quality: 'minor', confidence: 0.8 }, 0.5);
    tap.short = true;
    for (var ev of c.step(tap, FS)) {
      if (ev.on) { onsTotal++; if (ev.note < 36) low++; }
    }
  }
  t.ok(onsTotal === 0, 'no notes without a long-grid register read (' + onsTotal + ')');
});

t.test('reset() releases the held note and clears state', function () {
  var c = RDComposer.create({ seed: 1 });
  c.setParams({ melody: true, density: 0.5, hunt: 0 });
  for (var i = 0; i < 40; i++)
    c.step(makeTap(i * TAPSTRIDE, { root: 0, quality: 'major', confidence: 0.9 }, 0.5), FS);
  var tail = c.reset();
  t.ok(tail.length >= 1 && tail[tail.length - 1].on === false,
    'trailing noteOff emitted (' + tail.length + ' events)');
  t.ok(c.step(makeTap(40 * TAPSTRIDE,
    { root: 0, quality: 'major', confidence: 0.9 }, 0.5), FS).every(function (ev) {
      return !ev.on;
    }), 'post-reset steps start silent');
});

t.test('engine-fed pad run: real taps drive real notes', function () {
  var loop = RDLoops.render('pad', FS);
  var node = makeWorklet();
  node.port.onmessage({ data: { type: 'taps', on: true, every: 1 } });
  var n = 128;
  var inL = new Float32Array(n), inR = new Float32Array(n);
  var oL = new Float32Array(n), oR = new Float32Array(n);
  var pos = 0, quanta = 0;
  while (quanta < Math.floor(6 * FS / n)) {   // 6 s of pad
    for (var j = 0; j < n; j++) {
      inL[j] = pos < loop.left.length ? loop.left[pos + j] : 0;
      inR[j] = pos < loop.right.length ? loop.right[pos + j] : 0;
    }
    pos += n; quanta++;
    node.process([[inL, inR]], [[oL, oR]]);
  }
  var taps = node.__posted.filter(function (m) { return m.type === 'taps'; });
  t.ok(taps.length > 100, 'taps collected (' + taps.length + ')');

  var c = RDComposer.create({ seed: 0x50a7 });
  c.setParams({ melody: true, density: 0.6, hunt: 0.25 });
  var events = [], chordsHeld = 0;
  for (var m of taps) {
    if (m.chord && m.chord.quality) chordsHeld++;
    events = events.concat(c.step(m, FS));
  }
  t.ok(chordsHeld > 20, 'the engine holds a chord over the pad (' +
    chordsHeld + '/' + taps.length + ' taps)');
  t.ok(ons(events).length > 10, 'composer sings over the pad (' +
    ons(events).length + ' notes)');
  var held = 0, violations = 0;
  for (var ev of events) {
    if (ev.on) { held++; if (held > 1) violations++; }
    else held = Math.max(0, held - 1);
  }
  t.ok(violations === 0, 'mono discipline holds end-to-end');
});

console.log(t.pass + '/' + (t.pass + t.fail) + ' tests pass, ' + t.checks + ' checks');
process.exit(t.fail > 0 ? 1 : 0);