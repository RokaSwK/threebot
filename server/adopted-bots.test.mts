import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  archiveAdoptedData, excludePattern, excludePatterns, gitRepo, mergeJsonFile, planAdoption, readAdopted, registerAdopted,
  stripManaged, undoAdoptionFiles, unregisterAdopted, withProjectAgents, writeExcludeBlock, type AdoptedBot,
} from './adopted-bots.mts';
import { createMainBotRegistry } from './main-bot.mts';
import { mergeManaged, renderAgentsMd, MANAGED_END } from './bot-template.mts';

async function tempDir(t: TestContext, prefix: string) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', XDG_CONFIG_HOME: path.join(tmpdir(), 'adopt-no-xdg') } });
/** A repo with its own tracked CLAUDE.md, AGENTS.md and .gitignore, committed and clean. */
async function repo(t: TestContext) {
  const dir = await tempDir(t, 'adopt-repo-');
  git(dir, 'init', '-q');
  await writeFile(path.join(dir, 'CLAUDE.md'), '# Repo rules for Claude\n');
  await writeFile(path.join(dir, 'AGENTS.md'), '# Repo rules\nRun the tests before you push.\n');
  await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n');
  await writeFile(path.join(dir, 'index.js'), 'console.log(1)\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
  return dir;
}
const status = (dir: string) => git(dir, 'status', '--porcelain', '--untracked-files=all', '--ignored=no');

function entryFor(dir: string, slug: string, extra: Partial<AdoptedBot> = {}): AdoptedBot {
  return { slug, path: dir, environmentId: 'local', projectId: `project-${slug}`, adoptedAt: '2026-01-01T00:00:00Z', git: null, files: [], createdDirs: [], codexTrust: false, ...extra };
}

test('discovery finds Bots registered outside BOTS_ROOT, with their data in .bot/ and their slug reserved', async (t) => {
  const botsRoot = await tempDir(t, 'adopt-bots-');
  const project = await tempDir(t, 'adopt-project-');
  await mkdir(path.join(botsRoot, 'plain', '.bot'), { recursive: true });
  await writeFile(path.join(botsRoot, 'plain', '.bot', 'bot.json'), JSON.stringify({ name: 'Plain', createdAt: '2026-01-01T00:00:00Z' }));
  // A BOTS_ROOT folder that collides with an adopted slug is not a second Bot.
  await mkdir(path.join(botsRoot, 'repo', '.bot'), { recursive: true });
  await writeFile(path.join(botsRoot, 'repo', '.bot', 'bot.json'), JSON.stringify({ name: 'Impostor' }));
  await mkdir(path.join(project, '.bot'), { recursive: true });
  await writeFile(path.join(project, '.bot', 'bot.json'), JSON.stringify({ name: 'Repo Bot', createdAt: '2026-01-02T00:00:00Z' }));
  await registerAdopted(botsRoot, entryFor(project, 'repo', { environmentId: 'local' }));
  const registry = createMainBotRegistry({ botsRoot });
  const bots = await registry.list();
  assert.deepEqual(bots.map((bot) => [bot.slug, bot.name, bot.adopted]), [['plain', 'Plain', false], ['repo', 'Repo Bot', true]]);
  const adopted = bots.find((bot) => bot.slug === 'repo')!;
  assert.equal(adopted.workspaceRoot, project);
  assert.equal(adopted.dataDir, path.join(project, '.bot'));
  assert.equal(adopted.environmentId, 'local');
  assert.equal(bots.find((bot) => bot.slug === 'plain')!.dataDir, path.join(botsRoot, 'plain'));

  // Saving writes the adopted Bot's own bot.json, without the fields discovery works out.
  await registry.save('repo', { label: 'Keeps the repo tidy', adopted: false, workspaceRoot: '/elsewhere', dataDir: '/x' });
  const saved = JSON.parse(await readFile(path.join(project, '.bot', 'bot.json'), 'utf8'));
  assert.equal(saved.label, 'Keeps the repo tidy');
  for (const key of ['adopted', 'workspaceRoot', 'dataDir', 'environmentId', 'slug']) assert.equal(key in saved, false, key);
  assert.equal(existsSync(path.join(botsRoot, 'repo', '.bot', 'bot.json')), true);
  assert.equal(JSON.parse(await readFile(path.join(botsRoot, 'repo', '.bot', 'bot.json'), 'utf8')).label, undefined);

  // Deleting never moves the user's project to the trash; release is the way out.
  await assert.rejects(registry.remove('repo'), /Turn it back into a plain project/);
  assert.equal(existsSync(project), true);
  await assert.rejects(registry.release('plain', async () => {}), /Only a Bot made from a project/);
  const after = await registry.release('repo', async () => { await unregisterAdopted(botsRoot, 'repo'); });
  assert.deepEqual(after.map((bot) => bot.slug), ['plain', 'repo']);
  // With the slug free again, the BOTS_ROOT folder is a Bot of its own.
  assert.equal(after.find((bot) => bot.slug === 'repo')!.name, 'Impostor');
  assert.deepEqual(await readAdopted(botsRoot), []);
});

test('the main Bot must hand over before it turns back into a plain project', async (t) => {
  const botsRoot = await tempDir(t, 'adopt-bots-');
  const project = await tempDir(t, 'adopt-project-');
  await mkdir(path.join(botsRoot, 'plain', '.bot'), { recursive: true });
  await writeFile(path.join(botsRoot, 'plain', '.bot', 'bot.json'), JSON.stringify({ name: 'Plain', createdAt: '2026-01-02T00:00:00Z' }));
  await mkdir(path.join(project, '.bot'), { recursive: true });
  await writeFile(path.join(project, '.bot', 'bot.json'), JSON.stringify({ name: 'Repo', createdAt: '2026-01-01T00:00:00Z' }));
  await registerAdopted(botsRoot, entryFor(project, 'repo'));
  const registry = createMainBotRegistry({ botsRoot });
  assert.equal((await registry.list()).find((bot) => bot.primary)!.slug, 'repo');
  await assert.rejects(registry.release('repo', async () => {}), /Choose another main Bot first/);
  await assert.rejects(registerAdopted(botsRoot, entryFor(project, 'other')), /already a Bot/);
});

test('adoption keeps a git repo clean, never touches tracked files, and undo restores it byte for byte', async (t) => {
  const dir = await repo(t);
  const botsRoot = await tempDir(t, 'adopt-bots-');
  // The user's own untracked Claude settings stay theirs: adoption only adds its keys.
  await mkdir(path.join(dir, '.claude'));
  // ...including a value adoption has to replace, which comes back on release.
  await writeFile(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, enableAllProjectMcpServers: false }));
  const before = { status: status(dir), exclude: await readFile(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), tracked: git(dir, 'ls-files', '-s'), head: git(dir, 'rev-parse', 'HEAD') };
  assert.match(before.status, /\.claude\/settings\.local\.json/);

  const repoInfo = (await gitRepo(dir))!;
  assert.equal(repoInfo.prefix, '');
  assert.equal(repoInfo.exclude, path.join(dir, '.git', 'info', 'exclude'));
  const { files, createdDirs } = await planAdoption(dir, repoInfo);
  assert.deepEqual(Object.fromEntries(files.map((f) => [f.path, f.mode])), {
    'CLAUDE.local.md': 'created', 'AGENTS.override.md': 'created', '.mcp.json': 'created',
    '.claude/settings.local.json': 'merged', '.codex/config.toml': 'created', '.pi/mcp.json': 'created',
  });
  assert.deepEqual(createdDirs, ['.codex', '.pi']);
  const entry = entryFor(dir, 'repo-bot', { git: repoInfo, files, createdDirs });
  await writeExcludeBlock(repoInfo.exclude, entry.slug, excludePatterns(entry));

  // What the gateway writes for an adopted Bot.
  await mkdir(path.join(dir, '.bot', 'memory'), { recursive: true });
  await mkdir(path.join(dir, '.bot', 'library'), { recursive: true });
  await writeFile(path.join(dir, '.bot', 'bot.json'), '{"name":"Repo Bot"}\n');
  await writeFile(path.join(dir, '.bot', 'memory', 'MEMORY.md'), '# memory\n- remember me\n');
  await writeFile(path.join(dir, '.bot', 'library', 'report.html'), '<p>report</p>\n');
  await writeFile(path.join(dir, 'CLAUDE.local.md'), 'bot\n');
  await writeFile(path.join(dir, 'AGENTS.override.md'), 'bot\n');
  await mergeJsonFile(path.join(dir, '.mcp.json'), { 'mcpServers.bot': { url: 'http://127.0.0.1/mcp/bot' } }, files.find((f) => f.path === '.mcp.json')!);
  const claude = files.find((f) => f.path === '.claude/settings.local.json')!;
  await mergeJsonFile(path.join(dir, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: true }, claude);
  assert.deepEqual(claude.keys, []);
  assert.deepEqual(claude.originals, { enableAllProjectMcpServers: false });
  await mergeJsonFile(path.join(dir, '.claude', 'settings.local.json'), { enableAllProjectMcpServers: true }, claude);
  assert.deepEqual(claude.originals, { enableAllProjectMcpServers: false }, 'a rewrite keeps the original, not its own value');
  assert.equal(JSON.parse(await readFile(path.join(dir, '.claude', 'settings.local.json'), 'utf8')).enableAllProjectMcpServers, true);
  await mkdir(path.join(dir, '.codex'));
  await writeFile(path.join(dir, '.codex', 'config.toml'), '[mcp_servers.bot]\n');
  await mergeJsonFile(path.join(dir, '.pi', 'mcp.json'), { 'mcpServers.bot': { url: 'x' } }, files.find((f) => f.path === '.pi/mcp.json')!);

  assert.equal(status(dir), '', 'git status stays clean while the folder is a Bot');
  assert.equal(git(dir, 'ls-files', '-s'), before.tracked);
  assert.equal(await readFile(path.join(dir, 'CLAUDE.md'), 'utf8'), '# Repo rules for Claude\n');
  assert.equal(await readFile(path.join(dir, 'AGENTS.md'), 'utf8'), '# Repo rules\nRun the tests before you push.\n');
  assert.equal(await readFile(path.join(dir, '.gitignore'), 'utf8'), 'node_modules/\n');

  await undoAdoptionFiles(entry);
  const archive = await archiveAdoptedData(botsRoot, entry, 1);
  assert.equal(archive, path.join(botsRoot, '.botapp', 'adopted-archive', 'repo-bot-1'));
  assert.equal(await readFile(path.join(archive!, 'memory', 'MEMORY.md'), 'utf8'), '# memory\n- remember me\n');
  assert.equal(await readFile(path.join(archive!, 'library', 'report.html'), 'utf8'), '<p>report</p>\n');
  assert.equal(JSON.parse(await readFile(path.join(archive!, 'adopted-from.json'), 'utf8')).path, dir);
  for (const gone of ['.bot', 'CLAUDE.local.md', 'AGENTS.override.md', '.mcp.json', '.codex', '.pi']) assert.equal(existsSync(path.join(dir, gone)), false, gone);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, '.claude', 'settings.local.json'), 'utf8')), { permissions: { allow: ['Bash(ls)'] }, enableAllProjectMcpServers: false });
  assert.equal(await readFile(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), before.exclude);
  assert.equal(status(dir), before.status);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), before.head);
});

test('a project inside a repo excludes its own paths; tracked files are refused or skipped, never written', async (t) => {
  const dir = await repo(t);
  const sub = path.join(dir, 'packages', 'app');
  await mkdir(sub, { recursive: true });
  await writeFile(path.join(sub, '.mcp.json'), '{"mcpServers":{}}\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'mcp');
  const info = (await gitRepo(sub))!;
  assert.equal(info.prefix, 'packages/app');
  const { files } = await planAdoption(sub, info);
  assert.equal(files.find((f) => f.path === '.mcp.json')!.mode, 'skipped');
  const patterns = excludePatterns(entryFor(sub, 'app', { git: info, files }));
  assert.ok(patterns.includes('/packages/app/.bot/'));
  assert.ok(patterns.includes('/packages/app/CLAUDE.local.md'));
  assert.ok(!patterns.some((p) => p.endsWith('.mcp.json')), 'a tracked file is not hidden from git');

  await writeFile(path.join(dir, 'CLAUDE.local.md'), 'tracked by this repo\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'local');
  await assert.rejects(planAdoption(dir, (await gitRepo(dir))!), /tracks CLAUDE\.local\.md/);
  await mkdir(path.join(sub, '.bot'));
  await assert.rejects(planAdoption(sub, info), /already has a \.bot folder/);
});

test('a folder outside git needs no exclude lines', async (t) => {
  const dir = await tempDir(t, 'adopt-plain-');
  assert.equal(await gitRepo(dir), null);
  const { files } = await planAdoption(dir, null);
  assert.deepEqual(excludePatterns(entryFor(dir, 'plain', { files })), []);
});

test('exclude patterns are anchored and escape what git would read as a pattern', () => {
  assert.equal(excludePattern('', '.bot/'), '/.bot/');
  assert.equal(excludePattern('my [app]', 'CLAUDE.local.md'), '/my \\[app\\]/CLAUDE.local.md');
  assert.equal(excludePattern('#x*?!', 'a'), '/\\#x\\*\\?\\!/a');
});

test('the exclude block is replaced in place and removed without touching other lines', async (t) => {
  const dir = await tempDir(t, 'adopt-exclude-');
  const file = path.join(dir, 'exclude');
  await writeFile(file, '# git ls-files --others --exclude-from=.git/info/exclude\n*.swp');
  await writeExcludeBlock(file, 'a', ['/.bot/']);
  await writeExcludeBlock(file, 'a', ['/.bot/', '/CLAUDE.local.md']);
  const text = await readFile(file, 'utf8');
  assert.equal(text.match(/threebot:a:start/g)!.length, 1);
  assert.match(text, /\*\.swp\n# threebot:a:start[^\n]*\n\/\.bot\/\n\/CLAUDE\.local\.md\n# threebot:a:end\n$/);
  const { removeExcludeBlock } = await import('./adopted-bots.mts');
  await removeExcludeBlock(file, 'a');
  assert.equal(await readFile(file, 'utf8'), '# git ls-files --others --exclude-from=.git/info/exclude\n*.swp\n');
});

test("merged instruction files give back the user's text exactly, and Codex's override carries the repo's AGENTS.md", () => {
  const block = renderAgentsMd({ bot: { name: 'Repo Bot', slug: 'repo-bot', adopted: true, workspaceRoot: '/work/repo' }, settings: {}, botsRoot: '/bots' });
  for (const own of ['', 'my notes\n', '# Mine\n\nline\n']) assert.equal(stripManaged(mergeManaged(own, block)), own || '');
  assert.equal(stripManaged(mergeManaged('', block)), '');
  const override = withProjectAgents(block, '# Repo rules\nRun the tests before you push.');
  assert.match(override, /## This project's own instructions[\s\S]*Run the tests before you push\.\n<!-- bot:managed:end -->/);
  assert.ok(override.endsWith(`${MANAGED_END}\n`));
  assert.equal(withProjectAgents(block, ''), block);
});

test('an adopted Bot is told where its folder, memory, library and the other Bots are', () => {
  const text = renderAgentsMd({ bot: { name: 'Repo Bot', slug: 'repo-bot', adopted: true, workspaceRoot: '/work/repo' }, settings: { userName: 'Sam' }, botsRoot: '/bots' });
  assert.match(text, /Your folder is Sam's project at \/work\/repo/);
  assert.match(text, /`\.bot\/memory\/MEMORY\.md`/);
  assert.match(text, /`\.bot\/memory\/log\.md`/);
  assert.match(text, /under `\.bot\/library\/`/);
  assert.match(text, /never add them to `\.gitignore`/);
  assert.match(text, /`\/bots\/\.botapp\/adopted\.json`/);
  assert.doesNotMatch(text, /\/bots\/repo-bot/);
  const plain = renderAgentsMd({ bot: { name: 'Plain', slug: 'plain' }, settings: {}, botsRoot: '/bots' });
  assert.match(plain, /Your folder is this project \(\/bots\/plain\)/);
  assert.match(plain, /Your memory is `memory\/MEMORY\.md`/);
  assert.match(plain, /The other Bots live next to you: each folder in `\/bots`/);
});
