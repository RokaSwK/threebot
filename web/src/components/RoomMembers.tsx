import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import { Avatar } from "./Avatar";
import { Modal, Pill } from "./ui";
import { openDialog, selectThread, useApp } from "../store";
import { botTextColor } from "../lib/character";
import type { MemberView, RoomView } from "../lib/rooms";

const RUNTIME_LABEL: Record<string, string> = {
  inherit: "Inherits the Bot's mode",
  "approval-required": "Approval required",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

function modelLabel(model: unknown): string {
  if (!model || model === "inherit") return "Inherits the Bot's model";
  if (typeof model === "string") return model;
  const value = (model as { model?: unknown }).model;
  return typeof value === "string" && value ? value : "A pinned model";
}

function statusLabel(member: MemberView): string {
  if (member.removed) return "Left the room";
  if (member.status === "pending") return "Not ready";
  if (member.status === "unavailable") return "Unavailable";
  return "Ready";
}

/**
 * Who is in the room, what each member runs with, and how to open its thread. The header's group
 * avatar opens this instead of sending the user to a settings form just to see the roster.
 */
export function RoomMembers({ room, onClose }: { room: RoomView; onClose: () => void }) {
  const bots = useApp((s) => s.bots);
  const current = useMemo(() => room.members, [room.members]);
  const former = useMemo(() => room.formerMembers ?? [], [room.formerMembers]);

  const openThread = (member: MemberView) => {
    const bot = bots[member.slug];
    if (!bot || !member.threadId) return;
    onClose();
    selectThread(bot, member.threadId);
  };

  const row = (member: MemberView) => (
    <div key={`${member.slug}:${member.removed ? "left" : "in"}`} className="flex items-start gap-2.5 rounded-xl px-2 py-2 hover:bg-hover">
      <Avatar shape={member.shape} color={member.color} picture={member.avatarImage} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="max-w-[60%] shrink-0 truncate text-[13px] font-medium" style={{ color: botTextColor(member.color) }}>{member.name}</span>
          {member.removed ? <span className="shrink-0 text-[11px] text-faint">left</span> : null}
          {member.label ? <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted">{member.label}</span> : null}
        </div>
        <p className="text-[11.5px] leading-[16px] text-muted break-words">
          {statusLabel(member)} · {modelLabel(member.model)} · {RUNTIME_LABEL[member.runtimeMode] ?? member.runtimeMode}
        </p>
      </div>
      {member.threadId && bots[member.slug] ? (
        <button
          type="button"
          onClick={() => openThread(member)}
          title={`Open ${member.name}'s thread in T3`}
          aria-label={`Open ${member.name}'s thread`}
          className="grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-hover hover:text-fg"
        >
          <ExternalLink size={14} />
        </button>
      ) : null}
    </div>
  );

  return (
    <Modal onClose={onClose} title={`Room · ${room.name}`} className="w-[460px] max-w-full">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 scroll-thin">
        <p className="rounded-xl bg-card px-3 py-2 text-[12.5px] leading-[18px] text-muted">
          {room.settings.mode === "roundtable"
            ? "Roundtable: they speak in this order, hear each other, and an @mention brings a member back in."
            : "Panel: each Bot answers on its own and never sees the others."}
        </p>
        <section>
          <h2 className="mb-1 px-2 text-[12px] font-medium tracking-wide text-muted uppercase">In the room · {current.length}</h2>
          <div className="space-y-0.5">{current.map(row)}</div>
        </section>
        {former.length > 0 && (
          <section>
            <h2 className="mb-1 px-2 text-[12px] font-medium tracking-wide text-muted uppercase">Left the room · {former.length}</h2>
            <p className="mb-1 px-2 text-[11.5px] text-faint">Their past messages stay here. They are not addressed or woken again.</p>
            <div className="space-y-0.5 opacity-75">{former.map(row)}</div>
          </section>
        )}
      </div>
      <div className="flex shrink-0 justify-end gap-2 border-t border-line p-3">
        <Pill variant="soft" onClick={onClose}>Close</Pill>
        <Pill onClick={() => { onClose(); openDialog({ kind: "room", id: room.id }); }}>Edit room</Pill>
      </div>
    </Modal>
  );
}
