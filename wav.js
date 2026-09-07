// wav.js — minimal RIFF/WAVE reader and writer. Dual-loaded (node require /
// importScripts / browser script tag); no DOM, no dependencies.
//
// read: parses fmt (PCM 16/24 or IEEE float 32), returns { sampleRate,
// channels, bits, data: [Float32Array ch0, ch1, ...] } — interleaved data
// unpacked to per-channel arrays, samples normalised to [-1, 1).
// write: always 32-bit IEEE float, mono or stereo.
(function (root) {
  'use strict';

  function readWav(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    function u32(o) { return u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24) >>> 0; }
    function u16(o) { return u8[o] | (u8[o + 1] << 8); }
    function tag(o) { return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]); }
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');

    var o = 12, fmt = null, data = null;
    while (o + 8 <= u8.length) {
      var id = tag(o), size = u32(o + 4);
      if (id === 'fmt ') {
        fmt = {
          format: u16(o + 8), channels: u16(o + 10), sampleRate: u32(o + 12),
          bits: u16(o + 22)
        };
      } else if (id === 'data') {
        data = { off: o + 8, size: Math.min(size, u8.length - o - 8) };
        break; // LIST chunks after data would need a second pass; not expected here
      }
      o += 8 + size + (size & 1);
    }
    if (!fmt || !data) throw new Error('missing fmt or data chunk');
    var fmtOk = fmt.format === 1 || fmt.format === 3;
    if (!fmtOk) throw new Error('unsupported WAV format ' + fmt.format + ' (want PCM=1 or float=3)');
    if (fmt.bits !== 16 && fmt.bits !== 24 && fmt.bits !== 32) {
      throw new Error('unsupported bit depth ' + fmt.bits);
    }

    var ch = fmt.channels, bytes = fmt.bits >> 3;
    var frames = Math.floor(data.size / (ch * bytes));
    var out = [];
    for (var c = 0; c < ch; c++) out.push(new Float32Array(frames));
    var dv = new DataView(u8.buffer, u8.byteOffset + data.off, data.size);
    for (var f = 0; f < frames; f++) {
      for (c = 0; c < ch; c++) {
        var p = (f * ch + c) * bytes;
        var v;
        if (fmt.bits === 16) v = dv.getInt16(p, true) / 32768;
        else if (fmt.bits === 24) {
          var b0 = u8[data.off + (f * ch + c) * 3],
              b1 = u8[data.off + (f * ch + c) * 3 + 1],
              b2 = u8[data.off + (f * ch + c) * 3 + 2];
          var s = (b2 << 16) | (b1 << 8) | b0;
          if (s & 0x800000) s -= 0x1000000; // sign-extend
          v = s / 8388608;
        } else v = dv.getFloat32(p, true);
        out[c][f] = v;
      }
    }
    return { sampleRate: fmt.sampleRate, channels: ch, bits: fmt.bits, data: out };
  }

  function writeWav(channels, sampleRate) {
    // channels: Float32Array | Float32Array[]; mono -> single array
    var chans = Array.isArray(channels) ? channels : [channels];
    var n = chans[0].length, ch = chans.length;
    var bytes = 4, dataSize = n * ch * bytes;
    var buf = new ArrayBuffer(44 + dataSize);
    var dv = new DataView(buf);
    function str(o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 3, true);
    dv.setUint16(22, ch, true); dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * ch * bytes, true);
    dv.setUint16(32, ch * bytes, true); dv.setUint16(34, 32, true);
    str(36, 'data'); dv.setUint32(40, dataSize, true);
    var o = 44;
    for (var f = 0; f < n; f++) {
      for (var c = 0; c < ch; c++) { dv.setFloat32(o, chans[c][f], true); o += 4; }
    }
    return buf;
  }

  var mod = { readWav: readWav, writeWav: writeWav };
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.RDWav = mod;
})(typeof self !== 'undefined' ? self : globalThis);