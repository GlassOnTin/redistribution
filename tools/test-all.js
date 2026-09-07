#!/usr/bin/env node
// test-all.js — run every gate as a child process; non-zero exit on any
// failure. Gates are independent executables so they can also run alone
// (--only filter inside each).
'use strict';
var cp = require('child_process');
var path = require('path');
var fs = require('fs');

var tests = fs.readdirSync(__dirname)
  .filter(function (f) { return /^test-.*\.js$/.test(f) && f !== 'test-all.js'; })
  .sort();

var failed = 0;
for (var i = 0; i < tests.length; i++) {
  var r = cp.spawnSync(process.execPath, [path.join(__dirname, tests[i])], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed === 0
  ? 'ALL ' + tests.length + ' GATES GREEN'
  : failed + '/' + tests.length + ' GATES FAILED');
process.exit(failed > 0 ? 1 : 0);