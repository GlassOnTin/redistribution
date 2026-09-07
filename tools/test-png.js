// test-png.js — the png.js gate: signature, IHDR fields, and write->read
// round-trips on a gradient. png.js is the byte-identical copy shared with
// astrogate and solfuse (RGB, filter-0 writer; reader also accepts RGBA), so
// this is a sanity net, not a full spec test.
'use strict';
var t = require('./harness.js');
var P = require('./png.js');
var zlib = require('zlib');

t.test('writePNG emits a legal signature and IHDR', function () {
  var w = 4, h = 3;
  var rgba = new Uint8Array(w * h * 4);
  for (var i = 0; i < w * h; i++) {
    rgba[i * 4] = i * 17; rgba[i * 4 + 1] = i * 7; rgba[i * 4 + 2] = 255 - i * 17; rgba[i * 4 + 3] = 255;
  }
  var buf = P.writePNG(rgba, w, h);
  var sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  var sigOk = sig.every(function (v, k) { return buf[k] === v; });
  t.ok(sigOk, 'PNG signature bytes');
  t.near(buf.readUInt32BE(8), 13, 0.5, 'IHDR length is 13');
  var id = buf.toString('ascii', 12, 16);
  t.ok(id === 'IHDR', 'first chunk is IHDR (' + id + ')');
  t.near(buf.readUInt32BE(16), w, 0.5, 'IHDR width');
  t.near(buf.readUint32BE ? buf.readUInt32BE(20) : buf.readUInt32BE(20), h, 0.5, 'IHDR height');
  t.near(buf[24], 8, 0.5, '8-bit depth');
  t.near(buf[25], 2, 0.5, 'colour type RGB');
  t.ok(buf.toString('ascii', buf.length - 8, buf.length - 4) === 'IEND', 'IEND terminates');
});

t.test('write/read round-trips a gradient pixel-exact', function () {
  var w = 8, h = 5;
  var rgba = new Uint8Array(w * h * 4);
  for (var i = 0; i < w * h; i++) {
    rgba[i * 4] = (i * 31 + 7) & 0xff;
    rgba[i * 4 + 1] = (i * 13) & 0xff;
    rgba[i * 4 + 2] = (255 - i * 9) & 0xff;
    rgba[i * 4 + 3] = 255; // alpha is dropped by the RGB writer
  }
  var r = P.readPNG(P.writePNG(rgba, w, h));
  t.near(r.width, w, 0.5, 'width round-trip');
  t.near(r.height, h, 0.5, 'height round-trip');
  var w1 = 0;
  for (i = 0; i < w * h; i++) {
    var dd = Math.max(Math.abs(r.rgba[i * 4] - rgba[i * 4]),
                      Math.abs(r.rgba[i * 4 + 1] - rgba[i * 4 + 1]),
                      Math.abs(r.rgba[i * 4 + 2] - rgba[i * 4 + 2]));
    if (dd > w1) w1 = dd;
  }
  t.ok(w1 === 0, 'RGB pixels identical (worst ' + w1 + ')');
  t.near(r.rgba[3], 255, 0.5, 'reader widens RGB to opaque RGBA');
});

t.test('reader un-filters an RGBA PNG with Paeth filters', function () {
  // hand-built 2x2 RGBA PNG, filter type 4 (Paeth) rows, all-zero deltas:
  // raw scanline = [4, r, g, b, a, r, g, b, a]
  // row 0: filter 4, deltas 0 over pixels (10,20,30,255) (10,20,30,255);
  // row 1: filter 4, deltas 0 -> Paeth predicts from row 0
  var raw = Buffer.from([4, 10, 20, 30, 255, 10, 20, 30, 255,
                         4, 0, 0, 0, 0, 0, 0, 0, 0]);
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  var crc32 = require('zlib').crc32 ? null : null;
  function chunk(type, data) {
    var b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0); b.write(type, 4, 'ascii');
    data.copy(b, 8);
    // crc over type+data (crc32 table from png.js itself would be circular;
    // compute here so the test stays self-contained)
    var T = [], n, k, c;
    for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; T[n] = c; }
    var body = b.subarray(4, 8 + data.length); c = -1;
    for (var i = 0; i < body.length; i++) c = T[(c ^ body[i]) & 0xff] ^ (c >>> 8);
    b.writeUInt32BE((c ^ -1) >>> 0, 8 + data.length);
    return b;
  }
  var buf = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  var r = P.readPNG(buf);
  t.near(r.width, 2, 0.5, 'width');
  // the raw bytes are filter deltas: row0 pixel0 predicts from nothing, so its
  // decoded values equal its deltas; row0 pixel1 adds Paeth(left); row1's
  // all-zero deltas decode to a pure Paeth prediction from row 0
  t.near(r.rgba[0], 10, 0.5, 'row0 pixel0 r (no predictors)');
  t.near(r.rgba[4], 20, 0.5, 'row0 pixel1 r = delta 10 + Paeth(left) 10');
  t.near(r.rgba[7], 254, 0.5, 'row0 pixel1 a = delta 255 + 255 (wrapped)');
  t.near(r.rgba[8], 10, 0.5, 'row1 pixel0 r predicted from above');
  t.near(r.rgba[11], 255, 0.5, 'row1 alpha predicted from above');
});

console.log(t.pass + '/' + (t.pass + t.fail) + ' tests pass, ' + t.checks + ' checks');
process.exit(t.fail > 0 ? 1 : 0);
