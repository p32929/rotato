/**
 * Runs all test-*.js files in this directory using Node's built-in test runner.
 * Usage: npm test  (or: node tests/run-tests.js)
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const testDir = __dirname;
const files = fs
  .readdirSync(testDir)
  .filter((f) => f.startsWith('test-') && f.endsWith('.js'))
  .map((f) => path.join(testDir, f));

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
