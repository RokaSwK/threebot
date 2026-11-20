#!/usr/bin/env node
// The full gate: web tests and build (which type-checks the app, service worker and build config), the
// web tests, server and scripts type-checks, server tests, fixture checks, the usage-stats collector, and asset and release-notes checks. Any non-zero exit
// fails it (tsrs exits 2 on type errors).
//
// Every type check is tsrs, which follows TypeScript 7.1. Known blind spot: 7.1 infers destructured
// parameters with a `= {}` default differently (https://github.com/microsoft/TypeScript/issues/64431),
// so it misses some errors that 7.0's tsc reports there. Annotate such parameters' types explicitly.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
// No single test takes more than a few seconds, so one that runs for 2 minutes is hung: fail it.
const TEST_TIMEOUT = '--test-timeout=120000';
const windows = process.platform === 'win32';
// Windows installs npm as a .cmd shim, which only cmd.exe can start (spawnSync can't run it directly).
const run = (command: string, args: string[], cwd = root) => {
  const shim = windows && command === 'npm';
  const { status } = shim
    ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', ['npm.cmd', ...args].join(' ')], { cwd, stdio: 'inherit', windowsVerbatimArguments: true })
    : spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
};
// CI runs the gate in parts on parallel jobs; with no part given, everything runs here in order.
//   node scripts/check.mts [web-tests[:<index>/<total>] | fixture | rest]
const [part = 'all', shard] = (process.argv[2] ?? 'all').split(':');
if (!['all', 'web-tests', 'fixture', 'rest'].includes(part) || (shard && !/^\d+\/\d+$/.test(shard))) {
  console.error(`Unknown part ${process.argv[2]}. Use web-tests[:i/n], fixture or rest.`);
  process.exit(2);
}
const runs = (name: string) => part === 'all' || part === name;

if (runs('web-tests')) {
  const files = readdirSync(path.join(root, 'web', 'tests')).filter((name) => name.endsWith('.test.mts')).map((name) => `tests/${name}`);
  run('node', ['--test', '--test-concurrency=1', TEST_TIMEOUT, ...(shard ? [`--test-shard=${shard}`] : []), ...files], path.join(root, 'web'));
}
if (runs('rest')) {
  run('npm', ['run', 'build'], path.join(root, 'web'));
  run('npm', ['run', 'typecheck:tests'], path.join(root, 'web'));
  run('npm', ['run', 'typecheck'], path.join(root, 'server'));
  run('node', ['--test', TEST_TIMEOUT, ...readdirSync(path.join(root, 'server')).filter((name) => name.endsWith('.test.mts'))], path.join(root, 'server'));
}
if (runs('fixture')) run('node', ['--test', TEST_TIMEOUT, 'scripts/fixture.test.mts']);
if (runs('rest')) {
  // The usage-stats collector (telemetry/), a Cloudflare Worker: its type check and tests. The npm
  // shim for tsrs is a shell script on Windows, so run the entry file with this same Node instead.
  run('node', [path.join(root, 'server', 'node_modules', 'tsrs', 'bin', 'tsrs'), '-p', 'telemetry/tsconfig.json']);
  run('node', ['--test', TEST_TIMEOUT, 'telemetry/test/worker.test.ts']);
  run('node', ['--test', TEST_TIMEOUT, 'scripts/verify-assets.test.mts', 'scripts/release-notes.test.mts']);
}
console.log(part === 'all' ? 'All checks passed.' : `Checks passed: ${process.argv[2]}.`);
