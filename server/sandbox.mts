// Optional OS-level / container sandboxing helpers for running Bot workspaces
// without access to ~/.threebot/.vault-key or vault.enc.
import path from "node:path";

export type SandboxMode = "none" | "user" | "docker";

export type SandboxConfig = {
  mode: SandboxMode;
  user: string | null;
  image: string;
  network: string;
};

export function sandboxConfig(env: Readonly<Record<string, string | undefined>> = process.env): SandboxConfig {
  const raw = (env.THREEBOT_SANDBOX_MODE ?? "none").trim().toLowerCase();
  const mode: SandboxMode = raw === "docker" || raw === "user" ? raw : "none";
  return {
    mode,
    user: env.THREEBOT_SANDBOX_USER?.trim() || null,
    image: env.THREEBOT_SANDBOX_IMAGE?.trim() || "node:22-slim",
    network: env.THREEBOT_SANDBOX_NETWORK?.trim() || "host",
  };
}

export function buildSandboxCommand({
  config,
  workspaceDir,
  command,
  args = [],
  env = {},
}: {
  config: SandboxConfig;
  workspaceDir: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}): { command: string; args: string[]; env: Record<string, string> } {
  const resolved = path.resolve(workspaceDir);
  if (config.mode === "docker") {
    const dockerArgs = [
      "run",
      "--rm",
      "--init",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--network",
      config.network,
      "-v",
      `${resolved}:/workspace`,
      "-w",
      "/workspace",
    ];
    if (config.user) dockerArgs.push("--user", config.user);
    for (const [k, v] of Object.entries(env)) {
      dockerArgs.push("-e", `${k}=${v}`);
    }
    dockerArgs.push(config.image, command, ...args);
    return { command: "docker", args: dockerArgs, env: {} };
  }
  if (config.mode === "user" && config.user) {
    return {
      command: "runuser",
      args: ["-u", config.user, "--", command, ...args],
      env,
    };
  }
  return { command, args, env };
}
