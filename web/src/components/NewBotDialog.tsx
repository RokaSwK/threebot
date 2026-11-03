import { useState } from "react";
import { ChevronRight, Pencil } from "lucide-react";
import { Avatar } from "./Avatar";
import { AvatarEditorDialog, AvatarPicker, type AvatarDraft } from "./AvatarEditor";
import { Modal, Pill, Spinner } from "./ui";
import { createBot, defaultModel, deleteBot, openDialog, toast, updateBot, useApp } from "../store";
import { DEFAULT_AVATAR } from "../lib/character";

export { AvatarPicker } from "./AvatarEditor";

export function NewBotDialog() {
  const bots = useApp((s) => s.bots);
  const first = Object.keys(bots).length === 0;
  const [name, setName] = useState(first ? "Threebot" : "");
  const [avatar, setAvatar] = useState<AvatarDraft>({ ...DEFAULT_AVATAR });
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => openDialog(null);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await createBot({ name: name.trim(), ...avatar, model: defaultModel(), primary: first });
      if (first) await updateBot(Object.values(useApp.getState().bots)[0].slug, { pinned: true });
      close();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't create the Bot");
      setBusy(false);
    }
  };

  return (
    <Modal onClose={close} title="Create New Bot" className="new-bot-sheet w-[440px]">
      <div className="dialog-body">
        <div className="new-bot-preview flex flex-col items-center px-5 pt-5">
          <button type="button" aria-label="Edit Bot avatar" onClick={() => setPicker(true)}><Avatar {...avatar} picture={avatar.avatarImage} definition={avatar.avatarDefinition} size={184} state="idle" /></button>
          <input
            aria-label="Name your Bot"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
            placeholder="Name your Bot"
            className="new-bot-name mt-4 h-10 w-full rounded-xl border border-line bg-transparent text-center text-[14px] outline-none placeholder:text-faint focus:border-line-strong"
          />
        </div>
        <AvatarPicker shape={avatar.shape} color={avatar.color} disabled={busy} onChange={(shape, color) => setAvatar({ shape, color, avatarImage: null, avatarDefinition: shape === avatar.shape ? avatar.avatarDefinition : null })} />
      </div>
      <div className="dialog-footer flex items-center gap-2 border-t border-line px-3 py-3">
        <Pill onClick={create} disabled={!name.trim() || busy}>
          {busy && <Spinner />} Create
        </Pill>
      </div>
      {picker && <AvatarEditorDialog initial={avatar} onSave={async draft => { setAvatar(draft); }} onClose={() => setPicker(false)} />}
    </Modal>
  );
}

export function RenameBotDialog({ slug }: { slug: string }) {
  const bot = useApp((s) => s.bots[slug]);
  const [name, setName] = useState(bot?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [avatar, setAvatar] = useState<AvatarDraft>({ shape: bot?.shape ?? DEFAULT_AVATAR.shape, color: bot?.color ?? DEFAULT_AVATAR.color, avatarImage: bot?.avatarImage, avatarDefinition: bot?.avatarDefinition });
  const [picker, setPicker] = useState(false);
  const close = () => openDialog(null);
  if (!bot) return null;
  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await updateBot(slug, { name: name.trim(), ...avatar });
      close();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't rename the Bot");
      setBusy(false);
    }
  };
  return (
    <Modal onClose={close} onBack={close} title="Edit Bot" className="edit-bot-sheet w-[380px]" headerActions={<Pill onClick={save} disabled={busy || !name.trim()}>Done</Pill>}>
      <div className="edit-bot-body dialog-body p-4">
        <button type="button" className="edit-bot-avatar relative mx-auto mb-5 block" aria-label="Edit Bot avatar" onClick={() => setPicker(true)}><Avatar {...avatar} picture={avatar.avatarImage} definition={avatar.avatarDefinition} size={88} /><span className="absolute -right-2 -bottom-2 grid size-10 place-items-center rounded-full border border-line bg-elevated"><Pencil size={20} /></span></button>
        <label className="edit-bot-label block text-muted" htmlFor="edit-bot-name">Name</label>
        <input id="edit-bot-name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} autoComplete="off" className="edit-bot-name h-10 w-full rounded-xl border border-line bg-transparent px-3 text-[14px] outline-none focus:border-line-strong" />
        <p className="edit-bot-label text-muted">Appearance</p>
        <button type="button" className="edit-bot-appearance flex w-full items-center justify-between rounded-2xl bg-card p-4 text-left" onClick={() => setPicker(true)}>Avatar<ChevronRight size={20} className="text-muted" /></button>
      </div>
      {picker && <AvatarEditorDialog initial={avatar} onSave={async draft => { setAvatar(draft); }} onClose={() => setPicker(false)} />}
      <div className="edit-bot-footer flex justify-end gap-2 p-3"><Pill variant="soft" onClick={close}>Cancel</Pill></div>
    </Modal>
  );
}

export function DeleteBotDialog({ slug }: { slug: string }) {
  const bot = useApp((s) => s.bots[slug]);
  const [busy, setBusy] = useState(false);
  const close = () => openDialog(null);
  if (!bot) return null;
  return (
    <Modal onClose={close} className="w-[400px]">
      <div className="p-5">
        <div className="text-[15px] font-semibold">Delete {bot.name}?</div>
        <p className="mt-2 text-[13.5px] text-muted">This erases its conversation, memory and routines. Its folder is moved to the trash on the server.</p>
      </div>
      <div className="flex justify-end gap-2 border-t border-line p-3">
        <Pill variant="soft" onClick={close}>Cancel</Pill>
        <Pill
          variant="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await deleteBot(slug);
              close();
            } catch (error) {
              toast(error instanceof Error ? error.message : "Couldn't delete the Bot");
              setBusy(false);
            }
          }}
        >
          {busy && <Spinner />} Delete
        </Pill>
      </div>
    </Modal>
  );
}
