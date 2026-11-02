#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultDist = fileURLToPath(new URL('../web/dist/', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const urlPath = (parts) => '/' + parts.map(encodeURIComponent).join('/');

/** Index and all generated assets, including lazy chunks. No timestamps or host paths. */
export async function createAssetManifest(dist = defaultDist) {
  const directory = path.resolve(dist);
  const files = [];
  async function inspect(parts) {
    const name = parts.length ? urlPath(parts) : 'build directory';
    let entry;
    try { entry = await lstat(path.join(directory, ...parts)); }
    catch { throw new Error(`Missing or unreadable ${name}`); }
    if (entry.isSymbolicLink()) throw new Error(`Symlink rejected: ${name}`);
    if (entry.isDirectory()) {
      let names;
      try { names = await readdir(path.join(directory, ...parts)); }
      catch { throw new Error(`Unreadable directory: ${name}`); }
      for (const child of names.sort()) await inspect([...parts, child]);
    } else if (entry.isFile()) {
      if (parts.join('/') === 'index.html' || parts[0] === 'assets') files.push(parts);
    } else throw new Error(`Not a regular file or directory: ${name}`);
  }
  await inspect([]);
  if (!files.some((parts) => parts.join('/') === 'index.html')) throw new Error('Build requires index.html');
  if (!files.some((parts) => parts[0] === 'assets' && parts.length > 1)) throw new Error('Build requires nonempty assets/');
  files.sort((a, b) => urlPath(a) < urlPath(b) ? -1 : urlPath(a) > urlPath(b) ? 1 : 0);
  const manifest = [];
  for (const parts of files) {
    const name = urlPath(parts);
    let handle;
    try {
      // Reject a file swapped to a symlink after the directory inspection too.
      handle = await open(path.join(directory, ...parts), constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!(await handle.stat()).isFile()) throw new Error();
      const bytes = await handle.readFile();
      if (name === '/index.html' && !bytes.length) throw new Error();
      manifest.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
    } catch { throw new Error(`Missing, empty or unreadable build file: ${name}`); }
    finally { await handle?.close(); }
  }
  return { files: manifest };
}

function parseOrigin(value) {
  let origin;
  try {
    if (typeof value !== 'string' || !/^https?:\/\/[^/?#\\]+\/?$/i.test(value)) throw new Error();
    origin = new URL(value);
  }
  catch { throw new Error('Origin must be an HTTP(S) origin without credentials, path, query or fragment'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Origin must be an HTTP(S) origin without credentials, path, query or fragment');
  }
  return origin;
}

/** Verify expected build files only; previous hashed assets may remain installed. */
export async function verifyAssets(dist, origin, { concurrency = 4, timeoutMs = 10_000 } = {}) {
  const base = parseOrigin(origin);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Concurrency must be between 1 and 16');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Timeout must be between 1 and 60000 milliseconds');
  const { files } = await createAssetManifest(dist);
  const stop = new AbortController();
  let next = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    while (!failure && next < files.length) {
      const file = files[next++];
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(timeoutMs)]);
      try {
        let response;
        try { response = await fetch(new URL(file.path, base), { redirect: 'manual', signal }); }
        catch { throw new Error(`Asset ${file.path}: ${signal.reason?.name === 'TimeoutError' ? 'request timed out' : 'request failed'}`); }
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error(`Asset ${file.path}: HTTP ${response.status}`);
        }
        const digest = createHash('sha256');
        let bytes = 0;
        try {
          for await (const chunk of response.body ?? []) {
            bytes += chunk.length;
            if (bytes > file.bytes) break;
            digest.update(chunk);
          }
        } catch { throw new Error(`Asset ${file.path}: ${signal.reason?.name === 'TimeoutError' ? 'request timed out' : 'response failed'}`); }
        if (bytes !== file.bytes) throw new Error(`Asset ${file.path}: byte length mismatch`);
        if (digest.digest('hex') !== file.sha256) throw new Error(`Asset ${file.path}: SHA-256 mismatch`);
      } catch (error) {
        if (!failure) { failure = error; stop.abort(); }
      }
    }
  }));
  if (failure) throw failure;
  return { files: files.length, bytes: files.reduce((total, file) => total + file.bytes, 0) };
}

async function main(args) {
  let dist = defaultDist;
  let origin;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') {
      console.log('Usage: node scripts/verify-assets.mjs [--dist DIRECTORY] [--origin http://host:port]\nWithout --origin: print the build SHA-256 manifest as JSON. With --origin: verify every expected file. Default build: web/dist relative to this project.');
      return;
    }
    if (!['--dist', '--origin'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: verify-assets.mjs [--dist DIRECTORY] [--origin HTTP(S)-ORIGIN]');
    if (args[i] === '--dist') dist = path.resolve(args[++i]);
    else origin = args[++i];
  }
  if (origin) {
    const result = await verifyAssets(dist, origin);
    console.log(`Verified ${result.files} build files (${result.bytes} bytes).`);
  } else console.log(JSON.stringify(await createAssetManifest(dist), null, 2));
}

const entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : 'Asset verification failed');
    process.exitCode = 1;
  });
}
