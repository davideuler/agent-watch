#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const tests = [
  ['score smoke', 'node', ['scripts/smoke-test.js']],
  ['frontend smoke', 'node', ['scripts/frontend-smoke-test.js']],
];

let failed = false;
for (const [label, command, args] of tests) {
  console.log(`\n## ${label}`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}

if (failed) process.exit(1);
