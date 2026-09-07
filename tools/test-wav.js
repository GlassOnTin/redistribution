// test-wav.js — round-trip gate for wav.js: 16-bit write-read via a 24-bit
// path is not supported (write is 32f only), so pin: 32f round-trip exact,
// 16-bit read correct from a hand-built header, 24-bit read sign-extension,
// per-channel de-interleave, and error paths.
'use strict';
var t = require('./harness.js');
var W = require('../wav.js');

t.test('32f write/read round-trips sample-exact', function () {
  var l = new Float32Array(7), r = new Float32Array(7);
  for (var i = 0; i < 7; i++) { l[i] = Math.sin(i * 0.1) * 0.5 - 0.25; r[i] = -l[i] * 2; }
  var buf = W.writeWav([l, r], 48000);
  var w = W.readWav(buf);
  t.near(w.sampleRate, 48000, 0.5, 'sample rate');
  t.near(w.channels, 2, 0.5, 'channels');
  var w1 = 0;
  for (i = 0; i < 7; i++) {
    w1 = Math.max(w1, Math.abs(w.data[0][i] - l[i]), Math.abs(w.data[1][i] - r[i]));
  }
  t.ok(w1 < 1e-9, 'samples exact (worst ' + w1.toExponential(2) + ')');
});

t.test('mono write accepts a bare Float32Array', function () {
  var m = new Float32Array([0.5, -0.5, 0.25]);
  var w = W.readWav(W.writeWav(m, 44100));
  t.near(w.channels, 1, 0.5, 'one channel');
  t.near(w.data[0][1], -0.5, 1e-9, 'sample value');
  t.near(w.sampleRate, 44100, 0.5, 'rate');
});

t.test('16-bit PCM read de-interleaves and scales', function () {
  // hand-built minimal 16-bit stereo WAV: sample -1, 0, +32767/-32768
  var dv = new DataView(new ArrayBuffer(52));
  function str(o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
  str(0, 'RIFF'); dv.setUint32(4, 44, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 2, true); dv.setUint32(24, 48000, true); dv.setUint32(28, 192000, true);
  dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, 8, true);
  dv.setInt16(44, 16384, true); dv.setInt16(46, -16384, true);
  dv.setInt16(48, 0, true); dv.setInt16(50, 32767, true);
  var w = W.readWav(dv.buffer);
  t.near(w.bits, 16, 0.5, 'bit depth');
  t.near(w.data[0][0], 0.5, 0.001, 'ch0 sample 16384/32768');
  t.near(w.data[1][0], -0.5, 0.001, 'ch1 sample -16384/32768');
  t.near(w.data[1][1], 32767 / 32768, 0.001, 'ch1 sample 32767');
});

t.test('24-bit read sign-extends the negative range', function () {
  var dv = new DataView(new ArrayBuffer(47));
  function str(o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
  str(0, 'RIFF'); dv.setUint32(4, 39, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, 48000, true); dv.setUint32(28, 144000, true);
  dv.setUint16(32, 3, true); dv.setUint16(34, 24, true);
  str(36, 'data'); dv.setUint32(40, 3, true);
  // -1 in 24-bit little-endian: FF FF FF
  dv.setUint8(44, 0xff); dv.setUint8(45, 0xff); dv.setUint8(46, 0xff);
  var w = W.readWav(dv.buffer);
  t.near(w.data[0][0], -1 / 8388608, 1e-6, '-1 sign-extended (' + w.data[0][0].toExponential(2) + ')');
});

t.test('malformed inputs throw', function () {
  var threw = 0;
  try { W.readWav(new Uint8Array(20)); } catch (e) { threw++; }
  try {
    var dv = new DataView(new ArrayBuffer(60));
    W.readWav(dv.buffer);
  } catch (e) { threw++; }
  t.near(threw, 2, 0.5, 'short file and headerless buffer both throw');
});

console.log(t.pass + '/' + (t.pass + t.fail) + ' tests pass, ' + t.checks + ' checks');
process.exit(t.fail > 0 ? 1 : 0);
