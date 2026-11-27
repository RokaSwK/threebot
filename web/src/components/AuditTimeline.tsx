import { useEffect, useState } from "react";
import { Download, KeyRound, ShieldCheck } from "lucide-react";
import { api, type AuditEntry } from "../lib/api";
import { exportBotBundle } from "../lib/botTemplates";
import { toast } from "../store";
import type { Bot } from "../lib/types";

export function AuditTimeline({ bot }: { bot: Bot }) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [rotating, setRotating] = useState(false);

  const load = () => {
    setLoading(true);
    void api.audit(bot.slug, 20)
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [bot.slug]);

  const rotateToken = async () => {
    setRotating(true);
    try {
      await api.revokeMcpToken(bot.slug);
      toast("Rotated MCP token for " + bot.name);
      load();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't rotate token");
    } finally {
      setRotating(false);
    }
  };

  const exportBot = () => {
    const bundle = exportBotBundle(bot);
    const blob = new Blob([JSON.stringify(bundle, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${bot.slug}.threebot.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="mb-5">
      <div className="mb-1.5 flex items-center gap-2 px-1 text-[12.5px] text-muted">
        <ShieldCheck size={13} />
        <span>Activity &amp; Security</span>
        <span className="ml-auto flex items-center gap-1.5">
          <button type="button" onClick={exportBot} className="rounded-lg px-2 py-1 text-[11.5px] text-muted hover:bg-hover hover:text-fg" title="Export Bot template (no secrets)">
            <Download size={12} className="inline mr-1" />Export
          </button>
          <button type="button" onClick={() => void rotateToken()} disabled={rotating} className="rounded-lg px-2 py-1 text-[11.5px] text-muted hover:bg-hover hover:text-fg disabled:opacity-50" title="Revoke and reissue this Bot's MCP token">
            <KeyRound size={12} className="inline mr-1" />{rotating ? "Rotating…" : "Rotate token"}
          </button>
        </span>
      </div>
      <div className="overflow-hidden rounded-2xl bg-card">
        {loading ? (
          <div className="px-3.5 py-3 text-[12.5px] text-muted">Loading audit log…</div>
        ) : entries.length === 0 ? (
          <div className="px-3.5 py-3 text-[12.5px] text-muted">No recorded tool or Vault actions yet.</div>
        ) : (
          <div className="divide-y divide-line">
            {entries.slice(0, 8).map((entry) => (
              <div key={entry.id} className="flex items-center gap-2 px-3.5 py-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate font-mono text-fg" title={entry.target ?? entry.action}>
                  {entry.action}{entry.target ? ` · ${entry.target}` : ""}
                </span>
                <span className="shrink-0 text-[11px] text-muted">
                  {new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
