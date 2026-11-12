import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Check, ChevronDown, Copy, Ellipsis, Folder, FolderInput, FolderPlus, MessageSquare, Pencil, Pin, PinOff, RefreshCw, Trash2, Users } from "lucide-react";
import { Avatar, GroupAvatar } from "./Avatar";
import { HoldButton, Menu, Modal, Pill, Spinner, Switch, type MenuItem, type MenuPoint } from "./ui";
import { createRoom, loadRooms, openDialog, recreateRoomThreads, removeRoom, saveRoom, saveSettings, selectRoom, showRoom, toast, useApp } from "../store";
import { DEFAULT_ROOM_SETTINGS, fetchRoom, type RoomSettings, type RoomSummary, type RoomView } from "../lib/rooms";
import { ModelPicker } from "./ModelPicker";
import { copyText } from "../lib/t3";

const COLLAPSED_KEY = "threebot.rooms.collapsed";

/** A broken or absent value is not worth crashing the sidebar over. */
function readCollapsed(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, boolean> : {};
  } catch { return {}; }
}

/** The room row menu, shared by the normal sidebar and the compact one. */
function useRoomMenu() {
  const settings = useApp((s) => s.settings);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [deleting, setDeleting] = useState<RoomSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const openRoomMenu = (point: MenuPoint, room: RoomSummary) => {
    point.preventDefault();
    const sections = settings?.sections ?? [];
    const fail = (error: unknown) => toast(error instanceof Error ? error.message : "Couldn't update the room");
    const move = (section: string | null) => { void saveRoom(room.id, { section }).catch(fail); };
    setMenu({ x: point.clientX, y: point.clientY, items: [
      { label: "Open", icon: <MessageSquare size={14} />, onSelect: () => selectRoom(room.id) },
      { label: "Edit room", icon: <Pencil size={14} />, onSelect: () => openDialog({ kind: "room", id: room.id }) },
      { label: room.pinned ? "Unpin" : "Pin to top", icon: room.pinned ? <PinOff size={14} /> : <Pin size={14} />, onSelect: () => { void saveRoom(room.id, { pinned: !room.pinned }).catch(fail); } },
      {
        label: "Move to",
        icon: <Folder size={14} />,
        items: [
          ...sections.map((name) => ({ label: name, icon: room.section === name ? <Check size={14} /> : <FolderInput size={14} />, onSelect: () => move(name) })),
          { label: "No section", icon: <FolderInput size={14} />, disabled: !room.section, onSelect: () => move(null) },
          {
            label: "New section…",
            icon: <FolderPlus size={14} />,
            onSelect: () => {
              const name = prompt("Section name")?.trim();
              if (!name) return;
              void (async () => {
                if (!sections.includes(name)) await saveSettings({ sections: [...sections, name] });
                await saveRoom(room.id, { section: name });
              })().catch(fail);
            },
          },
        ],
      },
      { label: "Copy link", icon: <Copy size={14} />, onSelect: () => { void copyText(`${location.origin}/?room=${room.id}`).then(() => toast("Copied room link"), () => toast("Couldn't copy the link")); } },
      "divider",
      { label: "Delete room", icon: <Trash2 size={14} />, danger: true, onSelect: () => setDeleting(room) },
    ] });
  };

  const destroy = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    try {
      await removeRoom(deleting.id);
      toast("Room deleted");
      setDeleting(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't delete the room");
    } finally { setBusy(false); }
  };

  const nodes = (
    <>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {deleting && (
        <Modal onClose={() => { if (!busy) setDeleting(null); }} className="w-[340px]">
          <div className="p-5 text-[16px]">Delete “{deleting.name}”?</div>
          <p className="px-5 pb-2 text-[13px] text-muted">The room goes away. The threads of its Bots stay in T3.</p>
          <div className="flex justify-end gap-3 p-4">
            <Pill variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>Cancel</Pill>
            <Pill variant="danger" disabled={busy} onClick={() => void destroy()}>{busy && <Spinner />} Delete</Pill>
          </div>
        </Modal>
      )}
    </>
  );

  return { openRoomMenu, nodes };
}

/** The sidebar section: pinned rooms first, then the same sections the Bots use. */
export function RoomsSection({ large = false }: { large?: boolean }) {
  const rooms = useApp((s) => s.rooms);
  const settings = useApp((s) => s.settings);
  const selectedRoom = useApp((s) => s.selectedRoom);
  const page = useApp((s) => s.page);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const { openRoomMenu, nodes: roomMenu } = useRoomMenu();

  useEffect(() => {
    void loadRooms().catch(() => {});
  }, []);
  // Folding is a view preference: it survives a reload like the sidebar width does.
  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed)); } catch { /* private mode */ }
  }, [collapsed]);

  const { pinned, groups, empty, total } = useMemo(() => {
    const all = Object.values(rooms).sort((a, b) => (b.lastTurnAt ?? "").localeCompare(a.lastTurnAt ?? "") || a.name.localeCompare(b.name));
    const pinnedRooms = all.filter((room) => room.pinned);
    const rest = all.filter((room) => !room.pinned);
    const order = [...(settings?.sections ?? [])];
    for (const room of rest) if (room.section && !order.includes(room.section)) order.push(room.section);
    const grouped = order
      .map((name) => ({ name, rooms: rest.filter((room) => room.section === name) }))
      .filter((group) => group.rooms.length > 0);
    const unassigned = rest.filter((room) => !room.section || !order.includes(room.section));
    if (unassigned.length) grouped.push({ name: grouped.length ? "Unassigned" : "", rooms: unassigned });
    return { pinned: pinnedRooms, groups: grouped, empty: all.length === 0, total: all.length };
  }, [rooms, settings?.sections]);

  const selected = (room: RoomSummary) => page === "room" && selectedRoom === room.id;
  const fold = (key: string) => setCollapsed((current) => ({ ...current, [key]: !current[key] }));

  return (
    <div className="room-list mb-2">
      <div className="bot-section-title group flex h-7 items-center px-2.5 text-[12.5px] text-muted hover:text-fg">
        <button
          type="button"
          onClick={() => fold("rooms")}
          aria-expanded={!collapsed.rooms}
          aria-label={`Rooms, ${total} room${total === 1 ? "" : "s"}`}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <Users size={12} />
          <span className="flex-1">Rooms</span>
          {collapsed.rooms && <span className="section-count">{total}</span>}
          <ChevronDown size={12} className={clsx("section-chevron opacity-0 transition group-hover:opacity-100", collapsed.rooms && "-rotate-90")} />
        </button>
      </div>
      {!collapsed.rooms && (
        <>
          {pinned.map((room) => <RoomRow key={room.id} room={room} selected={selected(room)} large={large} onMenu={openRoomMenu} />)}
          {groups.map((group) => {
            const key = `section:${group.name}`;
            return (
              <div key={group.name || "_"} className="mb-1">
                {group.name && (
                  <button
                    type="button"
                    onClick={() => fold(key)}
                    aria-expanded={!collapsed[key]}
                    aria-label={`${group.name}, ${group.rooms.length} room${group.rooms.length === 1 ? "" : "s"}`}
                    className="group flex h-7 w-full items-center gap-1 px-2.5 text-[12px] text-muted hover:text-fg"
                  >
                    <span className="min-w-0 flex-1 truncate text-left">{group.name}</span>
                    {collapsed[key] && <span className="section-count">{group.rooms.length}</span>}
                    <ChevronDown size={12} className={clsx("section-chevron opacity-0 transition group-hover:opacity-100", collapsed[key] && "-rotate-90")} />
                  </button>
                )}
                {!collapsed[key] && group.rooms.map((room) => <RoomRow key={room.id} room={room} selected={selected(room)} large={large} onMenu={openRoomMenu} />)}
              </div>
            );
          })}
          {empty && <p className="section-empty px-2.5 py-2 text-[13px] text-muted">No rooms yet</p>}
        </>
      )}
      {roomMenu}
    </div>
  );
}

function RoomRow({ room, selected, large, onMenu }: { room: RoomSummary; selected: boolean; large: boolean; onMenu: (point: MenuPoint, room: RoomSummary) => void }) {
  return (
    <div className="relative">
      <HoldButton
        onMenu={(point) => onMenu(point, room)}
        onClick={() => selectRoom(room.id)}
        aria-current={selected ? "page" : undefined}
        aria-label={`Open room ${room.name}`}
        className={clsx("bot-row flex w-full items-center gap-3 rounded-[10px] px-2 py-[9px] text-left transition-colors", selected ? "bg-active" : "hover:bg-hover")}
      >
        <GroupAvatar members={room.members} size={large ? 44 : 36} />
        <span className="min-w-0 flex-1 pr-7">
          <span className="bot-row-name block truncate text-[13.5px] leading-5 text-fg">{room.name}</span>
          <span className="bot-row-preview flex min-w-0 items-center gap-1.5 text-[12.5px] leading-[18px] text-muted">
            <span className="min-w-0 truncate">{room.running ? "A turn is running…" : `${room.members.length} bots · Panel`}</span>
          </span>
        </span>
      </HoldButton>
      <button aria-label={`Options for ${room.name}`} title={`Options for ${room.name}`} onClick={(event) => onMenu(event, room)} className="absolute top-1/2 right-1 grid size-7 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-hover"><Ellipsis size={16} /></button>
    </div>
  );
}

/** The compact sidebar's room avatars, after the Bot avatars. */
export function RoomsCompact() {
  const rooms = useApp((s) => s.rooms);
  const selectedRoom = useApp((s) => s.selectedRoom);
  const page = useApp((s) => s.page);
  const { openRoomMenu, nodes: roomMenu } = useRoomMenu();

  useEffect(() => {
    void loadRooms().catch(() => {});
  }, []);

  const list = Object.values(rooms);
  if (!list.length) return null;
  return (
    <div className="flex w-full flex-col items-center gap-2 border-t border-line pt-3 pb-1">
      {list.map((room) => (
        <HoldButton
          key={room.id}
          type="button"
          onMenu={(point) => openRoomMenu(point, room)}
          onClick={() => selectRoom(room.id)}
          title={room.name}
          aria-label={`Open room ${room.name}`}
          aria-current={page === "room" && selectedRoom === room.id ? "page" : undefined}
          className={clsx("grid size-[54px] place-items-center rounded-[14px]", page === "room" && selectedRoom === room.id ? "bg-active" : "hover:bg-hover")}
        >
          <GroupAvatar members={room.members} size={36} />
        </HoldButton>
      ))}
      {roomMenu}
    </div>
  );
}

/** Create or edit a room. Errors from the API stay in the dialog until the next attempt. */
export function RoomDialog({ roomId }: { roomId?: string }) {
  const close = () => openDialog(null);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!roomId) return;
    let alive = true;
    fetchRoom(roomId)
      .then((loaded) => { if (alive) setRoom(loaded); })
      .catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : "Couldn't load the room"); });
    return () => { alive = false; };
  }, [roomId]);

  if (roomId && !room) {
    return (
      <Modal onClose={close} title="Room" className="w-[520px] max-w-full">
        <div className="grid min-h-32 place-items-center p-5">
          {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : <Spinner size={18} />}
        </div>
      </Modal>
    );
  }

  return <RoomForm initial={room} onClose={close} />;
}

function RoomForm({ initial, onClose }: { initial: RoomView | null; onClose: () => void }) {
  const bots = useApp((s) => s.bots);
  const providers = useApp((s) => s.providers);
  const editing = !!initial;

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [guidance, setGuidance] = useState(initial?.guidance ?? "");
  const [pinned, setPinned] = useState(initial?.pinned ?? false);
  const [sectionChoice, setSectionChoice] = useState(initial?.section ?? "");
  const [newSection, setNewSection] = useState("");
  const appSettings = useApp((s) => s.settings);
  const [members, setMembers] = useState<string[]>(initial?.members.map((member) => member.slug) ?? []);
  const [settings, setSettings] = useState<RoomSettings>({ ...DEFAULT_ROOM_SETTINGS, ...(initial?.settings ?? {}), lead: initial?.settings?.lead ?? initial?.members[0]?.slug ?? "" });
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState("");

  const update = (patch: Partial<RoomSettings>) => setSettings((current) => ({ ...current, ...patch }));
  const candidates = useMemo(() => {
    const known = Object.values(bots).sort((a, b) => a.name.localeCompare(b.name));
    // A member whose Bot was deleted stays in the room as unavailable; it must remain removable here.
    const missing = (initial?.members ?? []).filter((member) => !bots[member.slug]).map((member) => ({
      slug: member.slug, name: member.name, label: "No longer a Bot", shape: member.shape, color: member.color, avatarImage: member.avatarImage,
    }));
    return [...known, ...missing];
  }, [bots, initial]);

  const toggleMember = (slug: string) => {
    if (members.includes(slug)) {
      const next = members.filter((member) => member !== slug);
      setMembers(next);
      if (settings.lead === slug) update({ lead: next[0] ?? "" });
      return;
    }
    if (members.length >= 8) return;
    setMembers([...members, slug]);
    if (!settings.lead) update({ lead: slug });
  };

  const save = async () => {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) { setError("Give the room a name."); return; }
    if (members.length < 2 || members.length > 8) { setError("A room has 2 to 8 Bots."); return; }
    if (guidance.length > 2000) { setError("Guidance is limited to 2,000 characters."); return; }
    const clean: RoomSettings = {
      ...settings,
      lead: members.includes(settings.lead) ? settings.lead : members[0]!,
      maxWaves: clamp(settings.maxWaves, 1, 5),
      maxReplies: clamp(settings.maxReplies, 1, 20),
      memberTimeoutMin: clamp(settings.memberTimeoutMin, 1, 60),
      turnDeadlineMin: clamp(settings.turnDeadlineMin, 1, 120),
    };
    const section = (sectionChoice === "__new" ? newSection.trim() : sectionChoice).trim();
    setBusy(true);
    setError("");
    try {
      const body = { name: trimmed, description: description.trim(), guidance: guidance.trim(), members, settings: clean, pinned, section: section || null };
      if (!initial) {
        const created = await createRoom(body);
        // A section typed here is new for the whole app: register it before the dialog goes away.
        if (section && !sectionOptions.includes(section)) await saveSettings({ sections: [...sectionOptions, section] }).catch(() => toast("Room created, but the section couldn't be saved"));
        toast("Room created");
        // One update: close the dialog and open the room. Two updates popped back into the dialog.
        showRoom(created.id);
      } else {
        await saveRoom(initial.id, body);
        if (section && !sectionOptions.includes(section)) await saveSettings({ sections: [...sectionOptions, section] }).catch(() => toast("Room saved, but the section couldn't be saved"));
        toast("Room saved");
        onClose();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save the room");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!initial || busy) return;
    setBusy(true);
    setError("");
    try {
      await removeRoom(initial.id);
      toast("Room deleted");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't delete the room");
      setBusy(false);
    }
  };

  const recreate = async () => {
    if (!initial || busy) return;
    setBusy(true);
    setError("");
    try {
      await recreateRoomThreads(initial.id);
      toast("Room restarted with fresh threads");
      setConfirmReset(false);
      setBusy(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't recreate the threads");
      setBusy(false);
    }
  };

  // The name the "when you mention nobody" summary uses; it follows the members you tick.
  const leadName = candidates.find((candidate) => candidate.slug === settings.lead)?.name ?? "the lead";
  // Sections come from the app settings (a Bot can create one from the sidebar) plus this room's.
  const sectionOptions = useMemo(() => {
    const names = [...(appSettings?.sections ?? [])];
    if (initial?.section && !names.includes(initial.section)) names.push(initial.section);
    return names;
  }, [appSettings?.sections, initial?.section]);
  // Pinning a model needs a starting point: the first provider T3 reports, or inherit when none is ready.
  const firstModel = (): RoomSettings["model"] => {
    const provider = providers[0];
    const model = provider?.models[0];
    return provider && model ? { instanceId: provider.instanceId, model: model.slug } : "inherit";
  };

  return (
    <Modal onClose={() => { if (!busy) onClose(); }} title={editing ? `Room · ${initial.name}` : "New Room"} className="w-[520px] max-w-full">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <div className="rounded-xl bg-card px-3 py-2.5 text-[12.5px] leading-[18px] text-muted">
          <p className="mb-1 font-medium text-fg">How a room works</p>
          <p>You write once and the Bots you address answer here, each in its own thread. A message can start one model turn per addressed member.</p>
        </div>

        <Field label="Name" hint="Shown in the sidebar.">
          <input autoFocus={!editing} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} aria-label="Room name" className="h-10 w-full rounded-xl border border-line bg-elevated px-3 text-[14px] outline-none focus:border-line-strong" />
        </Field>

        <Field label="Members" hint="Two to eight Bots. Each one gets a thread titled with the room's name.">
          <div role="group" aria-label="Room members" className="grid max-h-[200px] gap-1 overflow-y-auto rounded-xl border border-line p-1 scroll-thin">
            {candidates.map((bot) => {
              const checked = members.includes(bot.slug);
              return (
                <label key={bot.slug} className={clsx("flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px]", checked ? "bg-active" : "hover:bg-hover")}>
                  <Avatar shape={bot.shape} color={bot.color} picture={bot.avatarImage} size={24} />
                  <span className="min-w-0 flex-1 truncate">{bot.name}{bot.label && <span className="ml-1 text-[12px] text-muted">{bot.label}</span>}</span>
                  <input type="checkbox" checked={checked} disabled={busy || (!checked && members.length >= 8)} onChange={() => toggleMember(bot.slug)} className="size-4 shrink-0 accent-[var(--fg)]" />
                </label>
              );
            })}
            {candidates.length === 0 && <p className="px-2 py-2 text-[13px] text-muted">Create a Bot before making a room.</p>}
          </div>
          <span className={clsx("text-right text-[11px]", members.length >= 2 && members.length <= 8 ? "text-faint" : "text-danger")}>{members.length}/8 · 2 to 8 Bots</span>
        </Field>

        <div>
          <span className="text-[13px] font-medium">When you mention nobody</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {([["lead", "Only the lead"], ["everyone", "Everyone"], ["mentions", "Nobody"]] as [RoomSettings["defaultResponder"], string][]).map(([value, title]) => (
              <Choice key={value} selected={settings.defaultResponder === value} disabled={busy} onSelect={() => update({ defaultResponder: value })}>{title}</Choice>
            ))}
          </div>
          <p className="mt-1.5 text-[12px] text-muted">
            {settings.defaultResponder === "lead" ? `${leadName} answers.` : settings.defaultResponder === "everyone" ? "Every member answers." : "Nobody answers until you @mention a member."}{" "}
            <span className="text-faint">@Name wakes that Bot only; @all wakes every member.</span>
          </p>
        </div>

        {settings.defaultResponder === "lead" && (
          <Field label="Lead" hint="The member that answers when nobody is mentioned.">
            <Select label="Lead" value={settings.lead} disabled={busy || members.length === 0} onChange={(value) => update({ lead: value })} options={members.map((slug) => [slug, candidates.find((candidate) => candidate.slug === slug)?.name ?? slug] as [string, string])} placeholder="Choose a lead" />
          </Field>
        )}

        <Field label="House rules" hint="Optional. Added to every member's prompt, e.g. “Two sentences, no code.”">
          <textarea value={guidance} disabled={busy} maxLength={2000} rows={3} onChange={(e) => setGuidance(e.target.value)} aria-label="Room guidance" className="scroll-thin w-full resize-y rounded-xl border border-line bg-elevated px-3 py-2 text-[14px] outline-none focus:border-line-strong" />
          <span className="text-right text-[11px] text-faint">{guidance.length}/2000</span>
        </Field>

        <button type="button" onClick={() => setAdvanced((value) => !value)} aria-expanded={advanced} className="flex w-full items-center justify-between rounded-xl border border-line bg-elevated px-3 py-2 text-[13px] hover:bg-hover">
          <span>Advanced</span>
          <ChevronDown size={16} className={clsx("transition-transform", advanced && "rotate-180")} />
        </button>

        {advanced && (
          <div className="space-y-4 rounded-xl border border-line p-3">
            <Field label="Description" hint="One line about the room. The members see it in their prompt.">
              <input value={description} disabled={busy} onChange={(e) => setDescription(e.target.value)} aria-label="Room description" className="h-9 w-full rounded-xl border border-line bg-elevated px-2 text-[13px] outline-none focus:border-line-strong" />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Runtime mode" hint="Inherit uses each Bot's own approval setting.">
                <Select label="Runtime mode" value={settings.runtimeMode} disabled={busy} onChange={(value) => update({ runtimeMode: value as RoomSettings["runtimeMode"] })} options={[["inherit", "Inherit each Bot"], ["approval-required", "Approval required"], ["auto-accept-edits", "Auto-accept edits"], ["auto", "Auto"], ["full-access", "Full access"]]} />
              </Field>
              <Field label="Mention policy" hint="Leading only counts members named at the start.">
                <Select label="Mention policy" value={settings.mentionPolicy} disabled={busy} onChange={(value) => update({ mentionPolicy: value as RoomSettings["mentionPolicy"] })} options={[["anywhere", "Anywhere"], ["leading", "Leading only"]]} />
              </Field>
            </div>
            {settings.runtimeMode === "full-access" && <p className="text-[12px] text-danger">Full access acts without approval in a shared conversation.</p>}

            <Field label="Model" hint="Inherit uses each Bot's own model. Pin one to use it for the whole room.">
              <div className="flex items-center justify-between gap-2 rounded-xl border border-line px-2 py-1.5">
                <span className="text-[12.5px] text-muted">Inherit each Bot's model</span>
                <Switch checked={settings.model === "inherit"} disabled={busy} onChange={(on) => update({ model: on ? "inherit" : firstModel() })} label="Inherit each Bot's model" />
              </div>
              {settings.model !== "inherit" && (
                <div className="rounded-xl bg-card p-1.5">
                  <ModelPicker value={settings.model} onChange={(selection) => update({ model: selection })} />
                </div>
              )}
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Reply limit" hint="Total spoken replies one message can produce. A pass doesn't count (1–20).">
                <NumberInput label="Reply limit" value={settings.maxReplies} min={1} max={20} disabled={busy} onChange={(value) => update({ maxReplies: value })} />
              </Field>
              <Field label="Wait per member" hint="Minutes to wait for one member before moving on (1–60).">
                <NumberInput label="Wait per member" value={settings.memberTimeoutMin} min={1} max={60} disabled={busy} onChange={(value) => update({ memberTimeoutMin: value })} />
              </Field>
              <Field label="Stop after" hint="Minutes after which no new round starts (1–120).">
                <NumberInput label="Stop after" value={settings.turnDeadlineMin} min={1} max={120} disabled={busy} onChange={(value) => update({ turnDeadlineMin: value })} />
              </Field>
            </div>
            <p className="text-[12px] text-muted">
              One message can produce up to <span className="text-fg">{settings.maxReplies}</span> replies, and a member is dropped after <span className="text-fg">{settings.memberTimeoutMin}</span> min.
            </p>

            <Toggle label="Notifications" hint="One push when the turn finishes." checked={settings.notifications} disabled={busy} onChange={(value) => update({ notifications: value })} />

            <div className="grid grid-cols-2 gap-3">
              <Field label="Section" hint="Groups the room in the sidebar, like a Bot's section.">
                <div className="space-y-1.5">
                  <Select
                    label="Section"
                    value={sectionChoice}
                    disabled={busy}
                    onChange={(value) => { setSectionChoice(value); if (value !== "__new") setNewSection(""); }}
                    options={[["", "No section"], ...sectionOptions.map((name) => [name, name] as [string, string]), ["__new", "New section…"]]}
                  />
                  {sectionChoice === "__new" && (
                    <input
                      value={newSection}
                      disabled={busy}
                      onChange={(event) => setNewSection(event.target.value)}
                      aria-label="New section name"
                      placeholder="Section name"
                      className="h-9 w-full rounded-xl border border-line bg-elevated px-2 text-[13px] text-fg outline-none focus:border-line-strong"
                    />
                  )}
                </div>
              </Field>
              <Toggle label="Pinned" hint="Keeps the room at the top of the sidebar." checked={pinned} disabled={busy} onChange={setPinned} />
            </div>
          </div>
        )}

        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}

        {editing && (
          <div className="space-y-2 border-t border-line pt-3">
            <div className="flex flex-wrap gap-2">
              <Pill variant="soft" disabled={busy} onClick={() => { setConfirmReset(true); setConfirmDelete(false); }}><RefreshCw size={13} /> Start over</Pill>
              <Pill variant="ghost" className="text-danger" disabled={busy} onClick={() => { setConfirmDelete(true); setConfirmReset(false); }}><Trash2 size={13} /> Delete room</Pill>
            </div>
            <p className="text-[12px] text-muted"><span className="text-fg">Start over</span> deletes this room's messages and opens a fresh thread for every member. The old threads stay in T3 as history.</p>
            <p className="text-[12px] text-muted"><span className="text-fg">Delete room</span> removes the room from Threebot. Its threads stay in T3.</p>
            {confirmReset && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-card p-2">
                <span className="mr-auto text-[12.5px]">Delete the messages and start over?</span>
                <Pill variant="ghost" disabled={busy} onClick={() => setConfirmReset(false)}>Cancel</Pill>
                <Pill variant="danger" disabled={busy} onClick={() => void recreate()}>{busy && <Spinner />} Start over</Pill>
              </div>
            )}
            {confirmDelete && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-card p-2">
                <span className="mr-auto text-[12.5px]">Delete this room? Its threads stay.</span>
                <Pill variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</Pill>
                <Pill variant="danger" disabled={busy} onClick={() => void remove()}>{busy && <Spinner />} Delete</Pill>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 justify-end gap-2 border-t border-line p-3">
        <Pill variant="soft" disabled={busy} onClick={onClose}>Cancel</Pill>
        <Pill disabled={busy || !name.trim()} onClick={() => void save()}>{busy && <Spinner />} {editing ? "Save" : "Create room"}</Pill>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[13px] font-medium">{label}</div>
      {hint && <p className="text-[12px] text-muted">{hint}</p>}
      {children}
    </div>
  );
}

function Select({ value, options, onChange, disabled, placeholder, label }: { value: string; options: [string, string][]; onChange: (value: string) => void; disabled?: boolean; placeholder?: string; label?: string }) {
  return (
    <select value={value} disabled={disabled} aria-label={label} onChange={(event) => onChange(event.target.value)} className="h-9 w-full rounded-xl border border-line bg-elevated px-2 text-[13px] text-fg outline-none focus:border-line-strong">
      {placeholder && !value && <option value="" className="bg-elevated text-fg">{placeholder}</option>}
      {options.map(([id, label]) => <option key={id} value={id} className="bg-elevated text-fg">{label}</option>)}
    </select>
  );
}

/** A small one-of-N pill, used for "when you mention nobody". */
function Choice({ selected, disabled, onSelect, children }: { selected: boolean; disabled?: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={clsx(
        "rounded-full border px-3 py-1.5 text-[12.5px] transition-colors",
        selected ? "border-accent bg-active text-fg" : "border-line text-muted hover:bg-hover",
        disabled && "opacity-50",
      )}
    >
      {children}
    </button>
  );
}

/**
 * A small integer field that survives being emptied. `type="number"` on a phone refuses to clear the
 * last digit, so the field keeps a draft string while focused, selects the value on focus (one tap to
 * replace it) and clamps on blur; typing only commits a value already inside the range.
 */
function NumberInput({ value, min, max, onChange, disabled, label }: { value: number; min: number; max: number; onChange: (value: number) => void; disabled?: boolean; label?: string }) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing]);
  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      aria-label={label}
      disabled={disabled}
      value={editing ? draft : String(value)}
      onFocus={(event) => {
        setEditing(true);
        setDraft(String(value));
        const element = event.currentTarget;
        // One tap should replace the number, not put the caret after it.
        requestAnimationFrame(() => element.select());
      }}
      onChange={(event) => {
        const digits = event.currentTarget.value.replace(/[^0-9]/g, "").slice(0, 3);
        setDraft(digits);
        const next = Number(digits);
        if (digits !== "" && next >= min && next <= max) onChange(next);
      }}
      onBlur={() => {
        setEditing(false);
        const next = draft.trim() === "" ? min : clamp(Number(draft), min, max);
        setDraft(String(next));
        onChange(next);
      }}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      className="h-9 w-full rounded-xl border border-line bg-elevated px-2 text-[13px] text-fg outline-none focus:border-line-strong disabled:opacity-50"
    />
  );
}

function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <div className={clsx("flex items-start gap-3 rounded-xl px-1 py-1.5", disabled && "opacity-50")}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{label}</div>
        <p className="text-[12px] text-muted">{hint}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onChange={onChange} label={label} />
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
