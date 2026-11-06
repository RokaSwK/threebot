import assert from 'node:assert/strict';
import { mkdtemp, chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { executorConfiguration, executorCredential, executorMcpDefinition, publicExecutorConfiguration } from './executor-config.mts';

const legacy = { EXECUTOR_URL: 'http://127.0.0.1:4400/', EXECUTOR_PUBLIC_URL: 'https://backup.example/', EXECUTOR_ORG: 'legacy', EXECUTOR_TOKEN: 'fake-backup-token' };
const cloud = { ...legacy, EXECUTOR_BACKEND: 'cloud', EXECUTOR_CLOUD_ORG: 'workspace', EXECUTOR_CLOUD_TOKEN: 'fake-cloud-token' };

test('legacy environment retains its API/public/MCP identity and explicit Cloud keeps the complete backup', () => {
  const old = executorConfiguration(legacy);
  assert.equal(old.active, 'self-hosted');
  assert.equal(old.profile.apiUrl, 'http://127.0.0.1:4400');
  assert.equal(old.profile.publicUrl, 'https://backup.example');
  assert.deepEqual(executorMcpDefinition(old.profile), { type: 'http', url: 'http://127.0.0.1:4400/org/legacy/mcp', headers: { Authorization: 'Bearer fake-backup-token' } });
  const selected = executorConfiguration(cloud);
  assert.equal(selected.profile.apiUrl, 'https://app.executor.sh');
  assert.equal(selected.profile.publicUrl, 'https://app.executor.sh');
  assert.deepEqual(selected.profiles['self-hosted'], old.profile);
  assert.deepEqual(executorMcpDefinition(selected.profile), { type: 'http', url: 'https://mcp.executor.sh/org/workspace/mcp', headers: { Authorization: 'Bearer fake-cloud-token', 'X-Executor-Organization': 'workspace' } });
  assert.deepEqual(publicExecutorConfiguration(selected), { backend: 'cloud', configured: true, url: 'https://app.executor.sh', organization: 'workspace', hasToken: true, backupAvailable: true });
  assert.doesNotMatch(JSON.stringify(publicExecutorConfiguration(selected)), /fake-cloud-token|fake-backup-token|127\.0\.0\.1/);
});

test('Cloud with no credential remains selected and never uses the backup token', () => {
  const selected = executorConfiguration({ ...cloud, EXECUTOR_CLOUD_TOKEN: '' });
  assert.equal(selected.active, 'cloud');
  assert.equal(selected.profile.kind, 'cloud');
  assert.equal(executorCredential(selected.profile), '');
  assert.equal(executorMcpDefinition(selected.profile), null);
  assert.equal(executorCredential(selected.profiles['self-hosted']), 'fake-backup-token');
  assert.deepEqual(publicExecutorConfiguration(selected), { backend: 'cloud', configured: true, url: 'https://app.executor.sh', organization: 'workspace', hasToken: false, backupAvailable: true });
});

test('the bare Cloud MCP endpoint is explicitly organization-bound and skipped apps remain metadata', () => {
  const config = executorConfiguration({ ...cloud, EXECUTOR_CLOUD_MCP_URL: 'https://mcp.executor.sh/mcp?elicitation_mode=native', EXECUTOR_SKIPPED_APPS: ' gmail, calendar , ' });
  assert.equal(executorMcpDefinition(config.profile).url, 'https://mcp.executor.sh/mcp?elicitation_mode=native');
  assert.equal(executorMcpDefinition(config.profile).headers['X-Executor-Organization'], 'workspace');
  assert.deepEqual(config.profile.skippedApps, ['gmail', 'calendar']);
});

test('invalid backend, missing organization and cross-organization MCP routes fail without credential leakage', () => {
  for (const input of [
    { ...cloud, EXECUTOR_BACKEND: 'automatic' },
    { ...cloud, EXECUTOR_CLOUD_ORG: '' },
    { ...cloud, EXECUTOR_CLOUD_MCP_URL: 'https://mcp.executor.sh/org/other/mcp' },
    { ...cloud, EXECUTOR_CLOUD_API_URL: 'http://cloud.example' },
    { ...cloud, EXECUTOR_CLOUD_PUBLIC_URL: 'https://private-user:private-token@cloud.example' },
    { ...cloud, EXECUTOR_CLOUD_TOKEN_FILE: '/private/token' },
  ]) assert.throws(() => executorConfiguration(input), (error) => { assert.doesNotMatch(error.message, /fake-cloud-token|fake-backup-token|private-user|private-token|\/private\/token/); return true; });
});

test('private credential files materialize exact trimmed tokens without exposing their path', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'executor-config-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'credential'); await writeFile(file, '  fake-file-token\n', { mode: 0o600 });
  const config = executorConfiguration({ ...cloud, EXECUTOR_CLOUD_TOKEN: '', EXECUTOR_CLOUD_TOKEN_FILE: file });
  assert.equal(executorCredential(config.profile), 'fake-file-token');
  assert.equal(executorMcpDefinition(config.profile).headers.Authorization, 'Bearer fake-file-token');
  assert.doesNotMatch(JSON.stringify(publicExecutorConfiguration(config)), /fake-file-token|credential|executor-config-/);
});

test('unreadable, empty, nonprivate and symlinked credential files fail closed without selecting backup', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'executor-config-invalid-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const good = path.join(dir, 'good'); await writeFile(good, 'fake-private-token', { mode: 0o600 });
  const empty = path.join(dir, 'empty'); await writeFile(empty, '', { mode: 0o600 });
  const wide = path.join(dir, 'wide'); await writeFile(wide, 'fake-wide-token', { mode: 0o600 }); await chmod(wide, 0o644);
  const link = path.join(dir, 'link'); await symlink(good, link);
  const directory = path.join(dir, 'directory'); await mkdir(directory);
  const large = path.join(dir, 'large'); await writeFile(large, 'x'.repeat(16_385), { mode: 0o600 });
  for (const file of [empty, wide, link, directory, large, path.join(dir, 'missing')]) {
    const config = executorConfiguration({ ...cloud, EXECUTOR_CLOUD_TOKEN: '', EXECUTOR_CLOUD_TOKEN_FILE: file });
    assert.equal(config.profile.kind, 'cloud');
    assert.throws(() => executorCredential(config.profile), (error) => {
      assert.equal(error.status, 503); assert.equal(error.code, 'ExecutorCredentialUnavailable');
      assert.doesNotMatch(error.message, /fake-|executor-config-invalid-|ENOENT|ELOOP/); return true;
    });
    assert.equal(executorCredential(config.profiles['self-hosted']), 'fake-backup-token');
  }
});

test('an unused broken Cloud credential file does not interfere with the selected backup', () => {
  const config = executorConfiguration({ ...cloud, EXECUTOR_BACKEND: 'self-hosted', EXECUTOR_CLOUD_TOKEN: '', EXECUTOR_CLOUD_TOKEN_FILE: '/unread/missing/cloud-secret' });
  assert.equal(executorMcpDefinition(config.profile).headers.Authorization, 'Bearer fake-backup-token');
  assert.doesNotMatch(JSON.stringify(publicExecutorConfiguration(config)), /cloud-secret|fake-backup-token/);
});
