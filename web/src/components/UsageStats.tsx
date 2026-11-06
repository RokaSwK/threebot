// Settings → Usage stats, and the one-time question that asks for them. Off until the user says yes.
import { useEffect, useState } from "react";
import { api, type TelemetryStatus } from "../lib/api";
import { toast, useApp } from "../store";
import { Group, Row } from "./SettingsParts";
import { Modal, Pill, Spinner, Switch } from "./ui";

export const PRIVACY_URL = "https://github.com/RokaSwK/threebot/blob/main/PRIVACY.md";
const SUMMARY = "Once a day, a random install ID, the Threebot, T3 Code and Node versions, your OS, how many Bots and routines you have (in ranges), which features are on, and how many tokens your Bots used per model. Never messages, names, titles, files, Vault items, apps, emails or addresses.";

function blockedText(blockedBy: TelemetryStatus["blockedBy"]) {
  return blockedBy === "DO_NOT_TRACK" ? "Off because DO_NOT_TRACK is set on the computer running Threebot." : "Off because THREEBOT_TELEMETRY=0 is set on the computer running Threebot.";
}

/** The exact JSON of the next ping, gathered on request. */
function NextPing() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "ready"; json: string } | { kind: "error" }>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    api.telemetryPreview().then((value) => { if (live) setState({ kind: "ready", json: JSON.stringify(value, null, 2) }); }).catch(() => { if (live) setState({ kind: "error" }); });
    return () => { live = false; };
  }, []);
  if (state.kind === "loading") return <div role="status" className="grid h-20 place-items-center"><Spinner /></div>;
  if (state.kind === "error") return <p role="alert" className="text-[12.5px] text-danger">Couldn't build the preview.</p>;
  return <pre aria-label="Next usage stats ping" className="scroll-thin max-h-72 overflow-auto rounded-xl border border-line bg-app p-3 font-mono text-[11.5px] leading-[1.5]">{state.json}</pre>;
}

export function UsageStatsPane() {
  const [status, setStatus] = useState<TelemetryStatus | null>(null);
  const [error, setError] = useState(false);
  const [showing, setShowing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.telemetry().then(setStatus, () => setError(true)); }, []);
  const act = async (change: () => Promise<TelemetryStatus>) => {
    setBusy(true);
    try { setStatus(await change()); setShowing(false); } catch (e) { toast(e instanceof Error ? e.message : "Couldn't save"); } finally { setBusy(false); }
  };
  if (error) return <p role="alert" className="text-[13px] text-danger">Couldn't load usage stats settings.</p>;
  if (!status) return <div role="status" className="grid h-32 place-items-center"><Spinner /></div>;
  const lastSent = status.lastSentAt ? new Date(status.lastSentAt).toLocaleString() : "Never";
  return <>
    <p className="mb-4 text-[13px] text-muted">Anonymous stats help decide what to build and which versions still need support. They're off unless you turn them on. <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">What's collected</a></p>
    <Group>
      <Row title="Share anonymous usage stats" desc={status.blockedBy ? blockedText(status.blockedBy) : SUMMARY}>
        <Switch checked={status.enabled} onChange={(on) => { if (!busy && !status.blockedBy) void act(() => api.setTelemetry(on)); }} label="Share anonymous usage stats" />
      </Row>
      <Row title="Last sent" desc={status.enabled && !status.endpoint ? "This version has no collector set up yet, so nothing is sent." : status.lastError && status.enabled ? `Last try didn't go through. It tries again tomorrow.` : undefined}><span className="text-[13px] text-muted">{lastSent}</span></Row>
      <Row title="Install ID" desc={<span className="font-mono">{status.installId}</span>}>
        <Pill variant="soft" disabled={busy} onClick={() => void act(api.resetTelemetryId)}>Reset</Pill>
      </Row>
    </Group>
    <Group title="Next ping">
      <div className="p-4">
        {showing ? <NextPing /> : <Pill variant="soft" onClick={() => setShowing(true)}>See what's sent</Pill>}
      </div>
    </Group>
  </>;
}

/** Asked once, for new installs and for installs updating from a version without stats. Closing it counts as no. */
export function UsageStatsPrompt() {
  const dialog = useApp((s) => s.dialog);
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState(false);
  const [showing, setShowing] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true;
    api.telemetry().then((s) => { if (live && !s.asked && !s.blockedBy) setOpen(true); }).catch(() => { /* Ask next time. */ });
    return () => { live = false; };
  }, []);
  if (!open || dialog) return null;
  const done = async (choice: boolean) => {
    if (saving) return;
    setSaving(true);
    try { await api.setTelemetry(choice); setOpen(false); }
    catch { toast("Couldn't save your choice. You'll be asked again."); setOpen(false); }
  };
  return <Modal onClose={() => void done(false)} title="Share anonymous usage stats?" className="w-[min(520px,94vw)]">
    <div className="px-5 pb-5">
      <p className="text-[13.5px] text-muted">{SUMMARY}</p>
      <p className="mt-2 text-[13px] text-muted">You can change this any time in Settings → Usage stats. <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Privacy details</a></p>
      <label className="mt-4 flex cursor-pointer items-center gap-2.5 text-[13.5px]">
        <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} className="size-4 accent-accent" />
        Share anonymous usage stats
      </label>
      <div className="mt-4">{showing ? <NextPing /> : <button type="button" className="text-[13px] text-muted underline underline-offset-2 hover:text-fg" onClick={() => setShowing(true)}>See what's sent</button>}</div>
      <div className="mt-5 flex justify-end"><Pill disabled={saving} onClick={() => void done(share)}>Done</Pill></div>
    </div>
  </Modal>;
}
