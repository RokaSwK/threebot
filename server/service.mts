// The gateway as a background service, like T3 Code's: a launchd agent on macOS and a systemd user
// unit on Linux. It runs `threebot serve` from the `current` runtime link (or a source checkout),
// so an update only swaps the link and restarts the service.
import { existsSync, realpathSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { run } from "./release.mts";

export const LAUNCHD_LABEL = "tools.threebot.gateway";
export const SYSTEMD_UNIT = "threebot.service";

const xml = (value: string) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The node to run: the PATH entry that is this same node (/opt/homebrew/bin/node), not the
 * versioned folder it resolves to, which disappears when Homebrew or nvm upgrades Node.
 */
export function stableNode(execPath: string = process.execPath, pathEnv: string = process.env.PATH ?? ""): string {
  const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
  const target = real(execPath);
  const names = process.platform === "win32" ? ["node.exe", "node"] : ["node", "node.exe"];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const nodeName of names) {
      const candidate = path.join(dir, nodeName);
      if (existsSync(candidate) && real(candidate) === target) return candidate;
    }
  }
  return execPath;
}

/** Everything a service needs to know: what to run, with which environment, and where logs go. */
export function serviceSpec({ node = stableNode(), cli, home, pathEnv = process.env.PATH ?? "", label = LAUNCHD_LABEL, unit = SYSTEMD_UNIT }: { node?: string; cli: string; home: string; pathEnv?: string; label?: string; unit?: string }) {
  // A service starts with a bare PATH; keep the user's, so `t3`, `tailscale` and `cloudflared` are found.
  const baseDirs = process.platform === "win32" ? [] : ["/usr/local/bin", "/usr/bin", "/bin"];
  const dirs = [...new Set([path.dirname(node), ...pathEnv.split(path.delimiter).filter(Boolean), ...baseDirs])];
  return { node, cli, home, label, unit, env: { PATH: dirs.join(path.delimiter), THREEBOT_HOME: home, THREEBOT_SERVICE: "1" }, log: path.join(home, "logs", "gateway.log") };
}

export type ServiceSpec = ReturnType<typeof serviceSpec>;
type ServiceOptions = { platform?: NodeJS.Platform; exec?: typeof run };

export function launchdPlist(spec: ServiceSpec): string {
  const env = Object.entries(spec.env).map(([k, v]) => `      <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${xml(spec.label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(spec.node)}</string>
      <string>${xml(spec.cli)}</string>
      <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>WorkingDirectory</key><string>${xml(spec.home)}</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>5</integer>
    <key>ProcessType</key><string>Interactive</string>
    <key>StandardOutPath</key><string>${xml(spec.log)}</string>
    <key>StandardErrorPath</key><string>${xml(spec.log)}</string>
  </dict>
</plist>
`;
}

const quoteUnit = (value: string) => /[\s"\\]/.test(value) ? `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
export function systemdUnit(spec: ServiceSpec): string {
  return `[Unit]
Description=Threebot
After=network-online.target

[Service]
ExecStart=${[spec.node, spec.cli, "serve"].map(quoteUnit).join(" ")}
WorkingDirectory=${quoteUnit(spec.home)}
${Object.entries(spec.env).map(([k, v]) => `Environment=${quoteUnit(`${k}=${v}`)}`).join("\n")}
Restart=always
RestartSec=5
StandardOutput=append:${spec.log}
StandardError=append:${spec.log}

[Install]
WantedBy=default.target
`;
}

export function serviceFile(spec: ServiceSpec, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "darwin") return path.join(homedir(), "Library", "LaunchAgents", `${spec.label}.plist`);
  if (platform === "linux") return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "systemd", "user", spec.unit);
  if (platform === "win32") return path.join(spec.home, ".service-installed");
  return null;
}

export const serviceSupported = (platform = process.platform) => platform === "darwin" || platform === "linux" || platform === "win32";
const domain = () => `gui/${userInfo().uid}`;

export const WINDOWS_TASK_NAME = "ThreebotGateway";

export function windowsTaskXml(spec: ServiceSpec): string {
  const env = Object.entries(spec.env).map(([k, v]) => `      <Variable name="${xml(k)}">${xml(v)}</Variable>`).join("\n");
  const args = [spec.cli, "serve"].map((a) => `"${String(a).replace(/"/g, "&quot;")}"`).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Threebot gateway</Description>
    <URI>\\Threebot\\Gateway</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>true</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(spec.node)}</Command>
      <Arguments>${xml(spec.cli)} serve</Arguments>
      <EnvironmentVariables>
${env}
      </EnvironmentVariables>
      <WorkingDirectory>${xml(spec.home)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export async function installService(spec: ServiceSpec, { platform = process.platform, exec = run }: ServiceOptions = {}): Promise<string> {
  if (!serviceSupported(platform)) throw new Error("Background services are supported on macOS and Linux.");
  const file = serviceFile(spec, platform)!;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.mkdir(path.dirname(spec.log), { recursive: true });
  if (platform === "darwin") {
    await exec("launchctl", ["bootout", `${domain()}/${spec.label}`]).catch(() => {});
    await fs.writeFile(file, launchdPlist(spec));
    await exec("launchctl", ["enable", `${domain()}/${spec.label}`]).catch(() => {});
    await exec("launchctl", ["bootstrap", domain(), file]);
  } else if (platform === "linux") {
    await fs.writeFile(file, systemdUnit(spec));
    await exec("systemctl", ["--user", "daemon-reload"]);
    await exec("systemctl", ["--user", "enable", "--now", spec.unit]);
  } else if (platform === "win32") {
    const xmlPath = path.join(path.dirname(file), "threebot-task.xml");
    await fs.writeFile(xmlPath, windowsTaskXml(spec));
    await exec("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]).catch(() => {});
    await exec("schtasks", ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", xmlPath, "/F"]);
    await fs.writeFile(file, "");
    await exec("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]).catch(() => {});
  }
  return file;
}

export async function uninstallService(spec: ServiceSpec, { platform = process.platform, exec = run }: ServiceOptions = {}): Promise<void> {
  const file = serviceFile(spec, platform);
  if (platform === "darwin") await exec("launchctl", ["bootout", `${domain()}/${spec.label}`]).catch(() => {});
  if (platform === "linux") await exec("systemctl", ["--user", "disable", "--now", spec.unit]).catch(() => {});
  if (platform === "win32") await exec("schtasks", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]).catch(() => {});
  if (file) await fs.rm(file, { force: true });
  if (platform === "linux") await exec("systemctl", ["--user", "daemon-reload"]).catch(() => {});
}

export async function restartService(spec: ServiceSpec, { platform = process.platform, exec = run }: ServiceOptions = {}): Promise<string> {
  if (platform === "darwin") return exec("launchctl", ["kickstart", "-k", `${domain()}/${spec.label}`]);
  if (platform === "linux") return exec("systemctl", ["--user", "restart", spec.unit]);
  if (platform === "win32") {
    await exec("schtasks", ["/End", "/TN", WINDOWS_TASK_NAME]).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    return exec("schtasks", ["/Run", "/TN", WINDOWS_TASK_NAME]);
  }
  throw new Error("Background services are not supported on this platform.");
}

export function serviceInstalled(spec: ServiceSpec, platform: NodeJS.Platform = process.platform): boolean {
  const file = serviceFile(spec, platform);
  return Boolean(file && existsSync(file));
}
