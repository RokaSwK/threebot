#!/usr/bin/env node
// The full gate: web tests, build, server tests, fixture and asset checks.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args, cwd = root) => { const { status } = spawnSync(command, args, { cwd, stdio: 'inherit' }); if (status !== 0) process.exit(status ?? 1); };
run('npm', ['test'], path.join(root, 'web'));
run('npm', ['run', 'build'], path.join(root, 'web'));
run('node', ['--test', ...readdirSync(path.join(root, 'server')).filter((name) => name.endsWith('.test.mjs'))], path.join(root, 'server'));
run('node', ['--test', 'scripts/fixture.test.mjs']);
run('node', ['--test', 'scripts/verify-assets.test.mjs']);
console.log('All checks passed.');
