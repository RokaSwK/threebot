#!/usr/bin/env node
// Packs a release: threebot-<version>.tar.gz plus SHA256SUMS, the two assets the installer and
// `threebot update` download. Run after `npm run setup` so web/dist is built.
//   node scripts/pack-release.mts [--out release] [--version 1.2.3]
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const out = path.resolve(arg("out") ?? path.join(root, "release"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = arg("version") ?? pkg.version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Bad version: ${version}`);
if (!existsSync(path.join(root, "web", "dist", "index.html"))) throw new Error("web/dist is missing. Run `npm run setup` first.");

const name = `threebot-${version}`;
const stage = path.join(out, ".stage", name);
rmSync(path.join(out, ".stage"), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const file of ["LICENSE", "NOTICE", "README.md", ".env.example", "install.sh"]) cpSync(path.join(root, file), path.join(stage, file));
writeFileSync(path.join(stage, "package.json"), JSON.stringify({ ...pkg, version }, null, 2) + "\n");
// The server without its tests or anything installed or generated locally.
const skip = (src) => /node_modules|\.test\.mts$|\.t3-token$|\.env$/.test(src);
cpSync(path.join(root, "server"), path.join(stage, "server"), { recursive: true, filter: (src) => !skip(path.relative(root, src)) });
const serverPkg = JSON.parse(readFileSync(path.join(stage, "server", "package.json"), "utf8"));
writeFileSync(path.join(stage, "server", "package.json"), JSON.stringify({ ...serverPkg, version }, null, 2) + "\n");
cpSync(path.join(root, "web", "dist"), path.join(stage, "web", "dist"), { recursive: true });

const archive = `${name}.tar.gz`;
// COPYFILE_DISABLE keeps macOS from adding ._ metadata files.
const tar = spawnSync("tar", ["-czf", path.join(out, archive), "-C", path.join(out, ".stage"), name], { stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });
if (tar.status !== 0) process.exit(tar.status ?? 1);
rmSync(path.join(out, ".stage"), { recursive: true, force: true });

const sum = createHash("sha256").update(readFileSync(path.join(out, archive))).digest("hex");
writeFileSync(path.join(out, "SHA256SUMS"), `${sum}  ${archive}\n`);
console.log(`${path.join(out, archive)}\n${sum}`);
