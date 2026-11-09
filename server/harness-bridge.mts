// Install the optional Antigravity host bridge. This writes only Antigravity's own global MCP
// file (~/.gemini/config/mcp_config.json); it never touches T3 Code or another harness.
import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type HarnessBridgeOptions = {
  home?: string;
  bridgePath: string;
  now?: Date;
};

export type HarnessBridgeStatus = {
  configPath: string;
  bridgePath: string;
  configExists: boolean;
  bridgeExists: boolean;
  installed: boolean;
  otherServers: string[];
};

type McpConfig = { mcpServers?: Record<string, unknown>; [key: string]: unknown };

function geminiHome(home: string | undefined, env: NodeJS.ProcessEnv): string {
  return env.GEMINI_HOME ?? path.join(home ?? homedir(), ".gemini");
}

export function antigravityConfigPath({ home, env = process.env }: { home?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return path.join(geminiHome(home, env), "config", "mcp_config.json");
}

async function readConfig(file: string): Promise<McpConfig> {
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mcpServers: {} };
    throw error;
  }
  if (!raw.trim()) return { mcpServers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error(`${file} is not valid JSON; fix it before installing the bridge.`), { status: 1 });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error(`${file} must contain a JSON object.`), { status: 1 });
  }
  const config = parsed as McpConfig;
  if (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers))) {
    throw Object.assign(new Error(`${file}: mcpServers must be an object.`), { status: 1 });
  }
  return { ...config, mcpServers: config.mcpServers ?? {} };
}

async function writeConfig(file: string, config: McpConfig, now: Date): Promise<string | null> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = `${file}.bak-threebot-${now.toISOString().replace(/[:.]/gu, "-")}`;
    await fs.copyFile(file, backup);
  }
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600).catch(() => {});
  return backup;
}

export async function antigravityBridgeStatus(options: HarnessBridgeOptions): Promise<HarnessBridgeStatus> {
  const configPath = antigravityConfigPath({ home: options.home });
  const config = await readConfig(configPath);
  const servers = Object.keys(config.mcpServers ?? {});
  return {
    configPath,
    bridgePath: options.bridgePath,
    configExists: existsSync(configPath),
    bridgeExists: existsSync(options.bridgePath),
    installed: servers.includes("threebot"),
    otherServers: servers.filter((name) => name !== "threebot"),
  };
}

export async function installAntigravityBridge(options: HarnessBridgeOptions): Promise<{ changed: boolean; status: HarnessBridgeStatus; backup: string | null }> {
  const now = options.now ?? new Date();
  const configPath = antigravityConfigPath({ home: options.home });
  const config = await readConfig(configPath);
  const servers = { ...(config.mcpServers ?? {}) };
  const nextServer = { command: "node", args: [options.bridgePath] };
  const changed = JSON.stringify(servers.threebot) !== JSON.stringify(nextServer);
  if (!changed) return { changed: false, status: await antigravityBridgeStatus(options), backup: null };
  servers.threebot = nextServer;
  const backup = await writeConfig(configPath, { ...config, mcpServers: servers }, now);
  return { changed: true, status: await antigravityBridgeStatus(options), backup };
}

export async function uninstallAntigravityBridge(options: HarnessBridgeOptions): Promise<{ changed: boolean; status: HarnessBridgeStatus; backup: string | null }> {
  const now = options.now ?? new Date();
  const configPath = antigravityConfigPath({ home: options.home });
  const config = await readConfig(configPath);
  const servers = { ...(config.mcpServers ?? {}) };
  if (!Object.hasOwn(servers, "threebot")) return { changed: false, status: await antigravityBridgeStatus(options), backup: null };
  delete servers.threebot;
  const backup = await writeConfig(configPath, { ...config, mcpServers: servers }, now);
  return { changed: true, status: await antigravityBridgeStatus(options), backup };
}
