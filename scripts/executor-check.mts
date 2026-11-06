#!/usr/bin/env node
import { executorConfiguration } from '../server/executor-config.mts';
import { checkExecutor, ExecutorProbeError } from '../server/executor-probe.mts';

async function main(args) {
  let appId;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') {
      console.log('Usage: node scripts/executor-check.mts [--app APP_ID]\nUses the selected Executor environment/private token-file configuration. Checks read-only HTTP metadata and a dedicated MCP management search.');
      return;
    }
    if (args[index] !== '--app' || appId !== undefined || !/^app_[A-Za-z0-9_-]{1,200}$/.test(args[index + 1] ?? '')) throw new Error();
    appId = args[++index];
  }
  let configuration;
  try { configuration = executorConfiguration(); } catch { throw new Error(); }
  console.log(JSON.stringify(await checkExecutor(configuration, { appId })));
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof ExecutorProbeError ? error.message : 'Executor verification configuration or arguments are invalid');
  process.exitCode = 1;
});
