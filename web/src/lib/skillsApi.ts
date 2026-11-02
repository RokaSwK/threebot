import { isRecord, providerRecords } from "./providerData";
import { workspaceClient } from "./workspaceTransport";
export type ProviderSkill = { key: string; provider: string; name: string; title: string; description: string; enabled: boolean; invocable: boolean; scope: string; cwd: string | null };
/** Use only an exact workspace snapshot when present; never another Bot's snapshot. */
export function parseSkills(value: unknown, cwd: string | null): ProviderSkill[] {
  return providerRecords(value).flatMap((provider) => {
    if (typeof provider.instanceId !== "string" || typeof provider.displayName !== "string") return [];
    const providerName = provider.displayName;
    const snapshot = cwd && Array.isArray(provider.workspaceSnapshots) ? provider.workspaceSnapshots.find((snapshot) => isRecord(snapshot) && snapshot.cwd === cwd) : null;
    const skills = isRecord(snapshot) ? snapshot.skills : provider.skills;
    if (!Array.isArray(skills)) return [];
    return skills.flatMap((skill): ProviderSkill[] => {
      if (!isRecord(skill) || typeof skill.name !== "string" || typeof skill.enabled !== "boolean") return [];
      return [{ key: `${provider.instanceId}:${skill.name}`, provider: providerName, name: skill.name, title: typeof skill.displayName === "string" ? skill.displayName : skill.name, description: typeof skill.description === "string" ? skill.description : typeof skill.shortDescription === "string" ? skill.shortDescription : "", enabled: skill.enabled, invocable: skill.userInvocable !== false, scope: typeof skill.scope === "string" ? skill.scope : "Provider", cwd: isRecord(snapshot) ? cwd : null }];
    });
  });
}

/** Refreshes discovery only; model rediscovery is explicitly disabled. */
export async function refreshWorkspaceSkills(instanceId: string, cwd: string, threadId: string | null = null) {
  return workspaceClient(threadId).call<unknown>("server.refreshProviders", { instanceId, cwd, refreshModels: false, workspaceSnapshotsOnDemand: true });
}
