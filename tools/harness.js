// harness.js — tiny zero-dependency test framework, in the solfuse register:
// analytic ground truth where possible, never golden numbers.
'use strict';
var t = {
  pass: 0, fail: 0, checks: 0, only: null,
  test: function (name, fn) {
    if (t.only && name.indexOf(t.only) < 0) return;
    try { fn(); t.pass++; console.log(' ok  ' + name); }
    catch (e) { t.fail++; console.log(' FAIL ' + name + ' :: ' + (e && e.message)); }
  },
  ok: function (cond, msg) {
    t.checks++;
    if (!cond) throw new Error('check failed: ' + msg);
  },
  near: function (got, want, tol, msg) {
    t.checks++;
    var d = Math.abs(got - want);
    if (!(d <= tol)) {
      throw new Error('near failed: ' + msg + ' got ' + got + ' want ' + want + ' (|d|=' + d + ' > ' + tol + ')');
    }
  }
};
// --only filter
var ai = process.argv.indexOf('--only');
if (ai > 0) t.only = process.argv[ai + 1];
module.exports = t;