# Implementation plan: composer mentions and rooms

Audience: Bolt (implementer). Read `docs/designs/rooms.md` first; it is the design and the
rationale. This file is the work order: files, behavior, tests, acceptance and PR bookkeeping.

Status: Ready to implement. PR 1 starts now; Phase 0 gates the rooms stack.
Date: 2026-11-11

## Decision: one mentions PR, and rooms as a stack of three

The work is **four PRs**, all linked to the same tracking thread:

1. `feat/composer-mentions` — the `@` menu. Small: one pure shared module plus the web UI; no
   server behavior or T3 change.
2. `feat/rooms-foundation` — room registry, settings, member threads, read-only room view.
3. `feat/rooms-panel` — send a room message; addressed members answer in parallel; queue, Stop.
4. `feat/rooms-roundtable` — Codync's waves, cross-mentions, `(pass)`, budgets.

Rooms are not one reviewable PR: the design is roughly 2,000+ lines with tests, and
`CONTRIBUTING.md` asks for small changes. The three room PRs are stacked and independently
reviewable. If a single rooms PR is required, squash 2–4, but expect review friction and a long
review cycle; it is not the recommended shape.

Every PR is generic: no Bot name, slug, model, runtime mode, locale or path from the maintainer's
setup is hardcoded. Every preference is a room setting with a default.

## Ground rules (apply to every PR)

- Read `CONTRIBUTING.md`, `docs/architecture.md` and `docs/designs/rooms.md` before writing code.
- **Do not change T3** source, schema or configuration. Use its existing RPC.
- **Do not use the MCP orchestrator tools** for rooms (`t3_thread_send` and friends): the gateway's
  MCP client is mode-capped (`clientModeCeiling`), and rooms must honor the user's runtime mode.
  Use the same RPC the app uses: `orchestration.launchThread`, `message.dispatch`,
  `getThreadProjection`, `run.interrupt`.
- **No database and no second transcript.** `rooms.json` holds the room, its settings and the
  user's turns. Bot replies stay in their T3 threads.
- **Bots are threads.** A room member is a normal T3 thread in the Bot's project. Do not invent an
  agentless group thread.
- **Generic defaults.** No `if (bot.name === "Bolt")`, no hardcoded `full-access`, no hardcoded
  model, no hardcoded locale.
- **Bounded.** Every room turn has `maxWaves`, `maxReplies`, `memberTimeoutMin` and
  `turnDeadlineMin`. Stop always works.
- **Privacy.** Room threads are separate from each Bot's main thread; no one-to-one context is
  injected into a room.
- Keep changes scoped to the PR. Do not mix unrelated fixes, formatting or dependency bumps.
- Run the gate before opening a PR:
  `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npm run check`.
  Record the exact command and result in the PR body.
- Open each PR as a **draft**, link it to the tracking thread, and ask Cristian before marking it
  ready or merging.
- Push only the feature branch. Never force-push a branch someone else is reviewing.

## PR 1 — `feat/composer-mentions`

**Title:** Add an @ mention menu to the composer
**Base:** `RokaSwK/threebot:main`
**Size:** small (one pure shared module plus the web UI)
**Depends on:** nothing

### Goal

Typing `@` at a word boundary in any composer opens a list of visible Bots. Picking one inserts
`@Name ` as **plain text** and keeps the cursor after it. The existing renderer already turns it
into a `bot:<slug>` link. The menu does not route, call the server or change the send format.

The mention boundary rules live in one pure module shared by the web UI and, later, the room
parser, so the two can never disagree about what `@Name` means.

### Files

- **New `server/mention-rules.mts`** (pure; no Node imports, importable by the web like
  `server/avatar-color.mts`):
  ```ts
  export function isMentionBoundary(text: string, at: number): boolean;
  export function isNameContinuation(rest: string): boolean;
  export function mentionQueryAt(text: string, cursor: number): { start: number; query: string } | null;
  export function mentionsInText(text: string, names: readonly string[], policy: "anywhere" | "leading"): string[];
  export function mentionSegments(text: string, names: readonly string[]): MentionSegment[];
  ```
  Rules:
  - The `@` must be at index 0 or preceded by whitespace or one of ``([{<'"“`*_~.``.
  - It must not be preceded by a letter, number, `_`, `/` (URL) or `@`; the word-character rule
    already excludes emails such as `a@b.com`.
  - Between `@` and the cursor: 0–32 characters, no newline.
  - `mentionsInText` ignores fenced and inline code, matches the longest name first, and respects
    the `leading` policy (only at the start, separated by spaces, commas, `and` or `&`).
- **New `web/src/lib/mentionMenu.ts`** (pure UI logic; imports `mentionQueryAt`):
  ```ts
  export type MentionBot = { slug: string; name: string; label: string; hidden?: boolean };
  export type MentionQuery = { start: number; query: string };
  export function mentionSuggestions(query: string, bots: MentionBot[]): MentionBot[];
  export function withMention(draft: string, cursor: number, bot: MentionBot): { value: string; cursor: number };
  export function shouldSendOnEnter(menuHasSelection: boolean): boolean;
  ```
  Rules:
  - If the text from `@` to the cursor is exactly a visible Bot's name plus one space, there is no
    query (the mention is complete; the menu closes).
  - `mentionSuggestions`: only `!hidden` and non-empty names; case-insensitive `startsWith` first,
    then `includes`; stable alphabetical order; cap at 8.
  - `withMention`: replace `[start, cursor)` with `@${bot.name} `; return the new cursor.
  - `shouldSendOnEnter` is false only when the menu has a selectable row.
  - Do not parse code fences in the UI query in v1; Escape always closes the menu.
- **New `web/src/components/MentionMenu.tsx`**:
  - Props: `bots`, `query`, `activeIndex`, `onPick`, `onHover`, `hint`.
  - `role="listbox"`, rows `role="option"`, `aria-selected`, `aria-label`.
  - Row: `Avatar` (shape/color/picture), name, label; no new palette.
  - Position: absolute above the composer (`bottom-full mb-2`), max height 240px, scroll-thin.
  - Empty state: a single non-selectable "No Bots match" line.
- **New `web/src/components/UserMessageText.tsx`**: the user's bubble is plain text (it does not go
  through Markdown on purpose), so this splits it with `mentionSegments` and swaps each mention for
  the same `BotMention` chip the assistant messages use. On a Bot-coloured bubble the chip inherits
  the bubble foreground instead of the Bot hue, for contrast.
- **Modify `web/src/components/Chat.tsx`** (the `Composer`):
  - Local state: `mention: { start, query, index } | null`.
  - Recompute from the current text and cursor after any change, including the mobile `beforeinput`
    path; do not rely on keydown alone.
  - Keydown, before `handleComposerListKey`:
    - menu open: `ArrowDown`/`ArrowUp` move (wrap), `Enter`/`Tab` pick, `Escape` closes; all
      `preventDefault`; return.
    - `Enter` with the menu closed keeps the current send behavior.
  - On pick: `setText`, set the pending cursor, close the menu, keep focus.
  - Filter out the Bot whose chat is open (a self-mention is a dead link); in a room the caller
    passes the members instead (PR 2b).
  - Keep the menu closed when the composer is `readOnly` because the thread is archived, and while
    `isComposing`.
- **Modify `web/src/lib/chatBehavior.ts`** only if a shared key helper is needed; do not change the
  list-continuation behavior.
- **Docs:** `docs/architecture.md`, "Chat rendering rules": one line saying the composer offers the
  visible Bots and inserts plain text that the existing renderer links. `README.md` feature list:
  optional, one line.

### Tests

- `server/mention-rules.test.mts` (pure):
  - `@` at 0 and after a space, `(`, `"` open a query; `foo@bar`, `a@b.com`, `https://x/@y` do not.
  - A newline or more than 32 characters closes the query.
  - A complete `@Name ` returns no query.
  - `mentionsInText`: longest name first, code fences ignored, `leading` policy, `@all`.
  - `mentionSegments`: plain runs and mentions with the original text, canonical casing, longest name
    first, `@Maxine` and emails are not mentions, and code (inline and fenced) survives verbatim.
- `web/tests/mention-menu.test.mts` (pure):
  - Filtering is case-insensitive; `startsWith` ranks before `includes`; hidden Bots are excluded.
  - Insertion preserves the text before and after, puts one space after the name, and returns the
    cursor after it.
  - A name with spaces inserts the full name.
  - Empty bot list returns no suggestions.
- `web/tests/chat-composer-mentions.test.mts` (happy-dom, following
  `web/tests/mobile-composer.test.mts`; that test's Vite transform exports `Composer` from
  `Chat.tsx`, so the production module needs no extra export):
  - Arrow keys move the highlight; Enter picks and does not send; Escape closes; Enter with the
    menu closed sends.
  - Escape stays closed: a later recompute over the same text does not reopen the menu, and typing
    again does.
  - Picking a Bot inserts `@Name ` and keeps typing possible.
- `web/tests/chat-actions.test.mts`: a user message renders `@Name` as the Bot chip, and `@Maxine`
  is left as plain text.
- The existing `chat-composer-lists.test.mts` must stay green.

### Acceptance

- Typing `@` at a boundary opens the list; typing a partial filters it.
- Arrows, Enter, Tab, Escape work; picking never sends the message.
- Enter after a complete `@Name ` sends, as today.
- Mobile: tapping a row picks it; the menu opens from typed text, not only from a keydown.
- No server, T3 or send-format change.
- `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npm run check` passes.

## Phase 0 — Rooms spike (before PR 2a)

**File:** `scripts/rooms-spike.mts` (not shipped in the app; a development script).
**Bot:** `tester`, the Bot the repository reserves for harness tests.

Steps:

1. Read `tester`'s `bot.json` for `projectId` and `mainThreadId`; read its main thread projection
   for the current `runtimeMode` and model selection.
2. `orchestration.launchThread` an idle thread titled `#rooms-spike`, with the same project, model
   and runtime mode, `workspaceStrategy: { type: "root" }`, a fresh `commandId` and `threadId`.
3. `message.dispatch` with `messageId` = a fresh UUID, text
   `Reply with exactly: SPIKE-OK`, `createdBy: "agent"`, `creationSource: "server"`,
   `dispatchMode: { type: "start_immediately" }` (the thread is idle).
4. Poll `orchestration.getThreadProjection` every 500 ms:
   - print the time until the new run appears;
   - confirm `runs[]` has `userMessageId === messageId` (or report the fallback needed);
   - confirm `turnItems` has the assistant message with that `runId` and `text` `SPIKE-OK`.
5. Call `run.interrupt` on the finished run (expect a terminal/no-op result) to prove Stop's path.
6. Leave the thread and report its id; do not delete it without asking. Record the results in
   `docs/designs/rooms.md` under "Spike results".

**Go/no-go:** if the projection does not expose `userMessageId` or the run does not appear within
30 s, stop and report before writing PR 2b. The fallback is to match the newest run after the
dispatch timestamp; confirm it works.

## PR 2a — `feat/rooms-foundation`

**Title:** Add rooms: registry, settings and read-only room view
**Base:** `RokaSwK/threebot:main`
**Size:** medium
**Depends on:** Phase 0. PR 1 is independent; the room UI does not use its component until 2b.

### Goal

A user can create a room with 2–8 Bots, configure every preference, and see the room's member
threads in one read-only timeline. No message is sent to a member yet.

### Files

- **New `server/rooms.mts`:**
  - Types: `Room`, `RoomSettings`, `RoomMember`, `RoomTurn`, `RoomSummary`.
  - Defaults exactly as the design table; `DEFAULT_SETTINGS`.
  - Validation: name and guidance lengths, member count 2–8, unique member names, lead is a
    member, `allowCrossMentions` boolean, `maxWaves` 1–5, `maxReplies` 1–20, timeouts in range,
    known runtime modes and mention policy, `section`/`pinned` types.
  - `readRooms`, `writeRooms` (serialized, atomic temp+rename, mode `0600`), `createRoom`,
    `updateRoom`, `deleteRoom`, `findRoom`, `roomSummary`.
  - `turns` capped at 200 per room; prune oldest on write.
- **New `server/rooms-threads.mts`:**
  - `resolveMemberLaunch(bot, settings)`: read the Bot's main thread projection; resolve
    `runtimeMode: inherit` and `model: inherit`; fall back to `settings.autoReview` and the project
    default.
  - `launchRoomThread({ roomId, bot, settings })`: `orchestration.launchThread` with
    `commandId`, `threadId`, `projectId`, `title: "#<room>"`, `modelSelection`, `runtimeMode`,
    `interactionMode: "default"`, `workspaceStrategy: { type: "root" }`.
  - `recreateRoomThread` (used by the endpoint; no delete).
  - A room thread is never deleted by the app.
- **New `server/rooms-routes.mts`** (or the gateway's route table, matching the repo's style):
  - `GET /api/rooms`, `GET /api/rooms/:id`, `POST /api/rooms`, `PATCH /api/rooms/:id`,
    `DELETE /api/rooms/:id`, `POST /api/rooms/:id/recreate`.
  - Same login, JSON and `Origin` checks as `/api/projects`; errors as JSON with a useful message.
- **New `web/src/lib/rooms.ts`:** types and fetch calls.
- **New `web/src/components/Rooms.tsx`, `RoomView.tsx`, `RoomSettings.tsx`:**
  - Sidebar "Rooms" section with `+`.
  - Create/edit dialog with every setting and its default; the cost warning. Include `guidance`,
    `section` and `pinned`; the room row uses the same section/pin treatment as a Bot.
  - Room view: one timeline of the member threads (read-only in this PR), author avatar/name/color,
    status, Stop disabled/hidden until 2b.
  - Settings panel: name, description, members, mode, default responder, lead, runtime mode,
    model, mention policy, budgets, notifications. Explain each default in one line.
  - "Recreate threads" action.
  - Link to each member's room thread in T3 Code (via the existing thread link).
- **Modify `web/src/store.ts`:** `rooms`, `selectedRoom`, room thread watchers, `?room=` deep
  link. Do not break the Bot selection.
- **Modify the sidebar component:** add the section without changing Bot ordering.
- **Docs:** `docs/architecture.md` add a "Rooms" section (mapping, files, settings, data); update
  `docs/designs/rooms.md` status and spike results.

### Tests

- `server/rooms.test.mts`: defaults, validation (each boundary), CRUD, atomic writes, 200-turn cap,
  unique names, lead membership, delete leaves the file consistent.
- `server/rooms-threads.test.mts`: fake T3 client; `inherit` resolves from the main thread; a
  missing main thread falls back to the app default; launch payload has the right fields; a failed
  launch leaves the member `pending`.
- `server/rooms-routes.test.mts`: login, JSON content type, Origin, unknown room, invalid settings.
- `web/tests/rooms.test.mts`: pure settings validation and the room summary/selection helpers.
- `scripts/fixture-scenarios.mts`: a `rooms` scenario with two fake Bots and two threads; a
  `scripts/fixture.test.mts` check that the room view renders both authors.

### Acceptance

- Create a room with two Bots; each gets a thread in its own project, titled `#<room>`.
- Settings persist across a gateway restart; invalid settings are refused with a message.
- The room view shows the member threads read-only; no message is dispatched.
- Delete leaves the threads; the Bots are untouched.
- The room list works on mobile.
- `npm run check` passes.

## PR 2b — `feat/rooms-panel`

**Title:** Rooms: send a message and let mentioned Bots answer
**Base:** `feat/rooms-foundation` (stacked), or `main` after it merges
**Size:** large
**Depends on:** 2a and Phase 0, plus PR 1 merged for the composer's `@` menu. If PR 1 is not merged,
use the component from its branch; do not duplicate it in this PR.

### Goal

The user sends a message in a room; the addressed members answer in parallel (panel mode); a new
message queues; Stop cancels; one push per turn. This is a complete "group DM".

### Files

- **New `server/room-lines.mts`** (pure, shared with the web; imports `server/mention-rules.mts`):
  - `parseMentions(text, members, policy)` → slugs, `@all`, ignoring code fences/inline code.
  - `formatRoomLine(author, text, replyTo?)`.
  - `isPass(text)`.
  - `pickReply(turnItems, runId)` → the last completed `assistant_message` of the run.
  - `roomLine(s)` for the prompt.
- **Modify `server/rooms.mts` or new `server/room-turn.mts`:**
  - `startTurn(room, message)`: address, enqueue, return the turn id.
  - The prompt builder reads each member's `lastTurnAt` and includes the room lines after it
    (capped at 24): user turns from the index, Bot replies from the member threads' projections,
    merged by time. Set `lastTurnAt` to the reply's time when it is read (the dispatch time if it
    failed or passed).
  - `runTurn`: dispatch via `message.dispatch` with `threadId`, `messageId`, `text` (the framed
    prompt), `attachments`, `createdBy: "agent"`, `creationSource: "server"`,
    `dispatchMode: { type: "queue_after_active" }` (the client fills `commandId`).
  - `waitRun`: poll `getThreadProjection` every 1 s; find the run by `userMessageId` (fallback:
    newest after dispatch); wait for terminal; `waiting` keeps waiting; timeouts per settings.
  - `readReply`: `turnItems` with `runId`, `assistant_message`, `completed`; `(pass)` hides.
  - `stopTurn`: `run.interrupt` with the active run id (fallback `thread.stop`); mark stopped;
    clear the queue.
  - Startup: `running` → `interrupted`; interrupt active runs.
  - One running turn per room; a FIFO queue.
- **Modify `server/rooms-routes.mts`:** `POST /messages`, `POST /stop`.
- **Modify the room view:** merge the turn index (user messages, `at`) and the member threads'
  assistant messages (their `completedAt`/`updatedAt`) by time, dedupe by item id, and show the
  user's message once from the turn index. The composer uses the PR 1 `MentionMenu` limited to
  members plus `@all`; send/stop; statuses; inline cards from member threads with the member's
  identity; the answers go to that thread.
- **Modify `web/src/lib/rooms.ts`:** send/stop.
- **Notifications:** one push per turn through the existing push sender; `/?room=<id>` deep link;
  honor `settings.notifications`.
- **Docs:** `docs/architecture.md` room turn; `docs/designs/rooms.md` panel behavior.

### Tests

- `server/room-lines.test.mts`: mention boundaries, code fences, `@all`, duplicate names, `(pass)`,
  reply selection by runId.
- `server/room-turn.test.mts`: fake runtime (`dispatch`, `projection`, `interrupt`) with scripted
  runs: addressing, panel parallel, no mention → lead, queue, stop, timeout, failed run, restart.
- `server/rooms-routes.test.mts`: messages/stop validation and auth.
- `web/tests/room-composer.test.mts`: the mention list is limited to members; `@all`; send/stop.
- E2E (manual or scripted): two cheap Bots, one room, one message mentioning both; both answer;
  Stop; a new message queues.

### Acceptance

- A panel room with two Bots: mentioning both starts both; mentioning one starts only it; no
  mention starts the lead (or everyone, per the setting).
- Stop interrupts the active members and leaves the room usable.
- A message sent during a turn is queued, not lost.
- Reload shows the user's messages and the replies; no duplicate user bubbles.
- One push per turn; no push for a `(pass)`.
- No bot-to-bot dispatch in panel mode.
- `npm run check` passes.

## PR 2c — `feat/rooms-roundtable`

**Title:** Rooms: bounded roundtable with cross-mentions
**Base:** `feat/rooms-panel` (stacked), or `main` after it merges
**Size:** medium
**Depends on:** 2b

### Goal

`mode: "roundtable"` behaves like Codync's room turn: sequential waves, cross-mentions, `(pass)`,
budgets, rotating first speaker, late handling.

### Files

- **Modify `server/room-turn.mts`:**
  - `speakers(round, members, lines, spoken)` — wave 0 per the responder rule; later waves only
    members mentioned after their last message and not spoken since; `@all` → all others;
    `rotate_left` the first speaker per turn.
  - `spoken` set and `maxWaves`/`maxReplies`; a wave with nobody speaking ends the turn.
  - Late replies: appear in the room, start no wave.
  - Cross-mentions honor the `allowCrossMentions` setting introduced in 2a (default true); no
    schema change in this PR.
- **Modify `server/room-lines.mts`:** the cross-mention parser (same rules as the user's).
- **Modify the settings UI:** explain `allowCrossMentions` and the mode; no new field.
- **Docs:** `docs/architecture.md` roundtable; `docs/designs/rooms.md` behavior.

### Tests

- `server/room-turn.test.mts`: a cross-mention schedules the mentioned member in the next wave; a
  member that spoke and was cited after speaks again; `(pass)` does not consume `maxReplies`; the
  cap stops the turn; Stop during a wave; late reply does not start a wave; rotation.
- `web/tests/room-settings.test.mts`: the new setting validation and explanation.
- E2E: three cheap Bots; Bolt mentions Max; Max answers in wave 1; the turn ends at the budget.

### Acceptance

- A roundtable room with three Bots: the user asks Bolt; Bolt's reply mentions Max; Max answers in
  the next wave with the room lines; a third member is not woken unless mentioned.
- At most `maxWaves` and `maxReplies`; a `(pass)` is hidden.
- A new user message queues; Stop cancels.
- Panel rooms are unchanged.
- `npm run check` passes.

## Shared acceptance for every room PR

- No T3 change, no new database, no duplicated transcript.
- Every setting is in `rooms.json`, validated, and editable in the UI; defaults match the design.
- `runtimeMode: inherit` is the default; no forced `auto` or `full-access`.
- The engine uses the app's RPC (`launchThread`, `message.dispatch`, `getThreadProjection`,
  `run.interrupt`), not the MCP orchestrator.
- The room's member threads are separate from each Bot's main thread.
- Stop, restart, timeout and a failed run are handled, not ignored.
- Mobile: the room list, room view and composer work.
- Docs updated; tests added; no unrelated changes.

## Test commands

```bash
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npm run check
```

For a faster loop:

```bash
cd server && npm run typecheck && node --test --test-timeout=120000 *.test.mts
cd web && npm run typecheck && npm test && npm run build
node scripts/fixture.mts --scenario rooms
```

## PR bookkeeping (required)

For each PR:

1. Rebase on its base (`git fetch origin && git rebase origin/main` or the stacked base).
2. Run the gate; paste the exact command and result in the body.
3. Open a **draft** PR against `RokaSwK/threebot:main` from the fork:
   ```bash
   gh pr create --repo RokaSwK/threebot --base main --head cristianbdev:<branch> \
     --title "<title>" --body-file <body.md> --draft
   ```
4. **Link it to the tracking thread** with T3's `t3_thread_update`, action `link_pull_request`,
   repository `RokaSwK/threebot`, the PR number and URL. This is what the Bot's PR list shows. If
   the tool is unavailable, add it from T3 Code's thread UI.
5. Ask Cristian before marking it ready; do not merge.

PR body sections: **What**, **Why**, **Security**, **Upgrade**, **Tests**, **Screenshots** (UI
PRs), **Linked PRs** (stack order).

## Prompt for Bolt

Paste this into Bolt's thread when starting:

> Read `docs/designs/rooms.md` and `docs/designs/rooms-and-mentions-plan.md` in the Threebot repo.
> Implement the plan in order. Start with PR 1 (`feat/composer-mentions`) on its own branch:
> follow the files, behavior, tests and acceptance in the plan, run
> `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npm run check`, open a draft PR against
> `RokaSwK/threebot:main`, and link it to this thread with `t3_thread_update`
> (`link_pull_request`). Then run the Phase 0 spike with the `tester` Bot and report the results
> before writing any rooms code. Do not touch T3, do not use the MCP orchestrator tools, do not
> hardcode any Bot, model, runtime mode or locale, and ask before marking a PR ready or pushing
> anything outside the feature branch.

## Order of work

1. PR 1 (mentions) — independent; open it first.
2. Phase 0 spike — go/no-go; record results in the design doc.
3. PR 2a — foundation.
4. PR 2b — panel.
5. PR 2c — roundtable.

Do not start 2b before the spike passes. Do not start 2c before 2b's engine tests pass.
