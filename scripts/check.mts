#!/usr/bin/env node
// The full gate: web tests and build (which type-checks web), the server and scripts type-check,
// server tests, fixture and asset checks. Any non-zero exit fails it (tsrs exits 2 on type errors).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// No single test takes more than a few seconds, so one that runs for 2 minutes is hung: fail it.
const TEST_TIMEOUT = '--test-timeout=120000';
const run = (command: string, args: string[], cwd = root) => { const { status } = spawnSync(command, args, { cwd, stdio: 'inherit' }); if (status !== 0) process.exit(status ?? 1); };
run('npm', ['test'], path.join(root, 'web'));
run('npm', ['run', 'build'], path.join(root, 'web'));
run('npm', ['run', 'typecheck'], path.join(root, 'server'));
// Guard: stable tsc (7.0) too. tsrs follows TypeScript 7.1, which infers destructured parameters with a
// `= {}` default differently (https://github.com/microsoft/TypeScript/issues/64431) and so misses some
// errors 7.0 reports. Remove this line once that is fixed upstream and tsrs picks it up.
run('npm', ['run', 'typecheck:stable'], path.join(root, 'server'));
run('node', ['--test', TEST_TIMEOUT, ...readdirSync(path.join(root, 'server')).filter((name) => name.endsWith('.test.mts'))], path.join(root, 'server'));
run('node', ['--test', TEST_TIMEOUT, 'scripts/fixture.test.mts']);
run('node', ['--test', TEST_TIMEOUT, 'scripts/verify-assets.test.mts']);
console.log('All checks passed.');
