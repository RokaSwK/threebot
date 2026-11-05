// Scripted protocol fixtures, never an agent runner or a real T3 connection.
// Shapes follow runtime-cards.test.mjs, bot-messages.test.mjs and the installed
// T3 OrchestrationV2RuntimeRequest, ProviderApprovalDecision and
// SecretRequestAnswerInput contracts.
import { RICH_MESSAGES } from './fixture-rich-content.mjs';

export const DUMMY_SECRET = 'fixture-dummy-only';
export const INITIAL_ANSWER = '  Proposed generic message\n\nKeep this second line  \n';
export const APPROVAL_OPTIONS = [
  { decision: 'accept', label: 'Allow once' },
  { decision: 'acceptForSession', label: 'Allow for session', warning: 'Synthetic session only' },
  { decision: 'acceptAlways', label: 'Always allow', warning: 'Synthetic fixture only' },
  { decision: 'decline', label: 'Deny' },
  { decision: 'cancel', label: 'Cancel action' },
];
export const INTERACTION_IDS = {
  initial: 'fixture-question-initial', multi: 'fixture-question-multi', layout: 'fixture-question-layout',
  approvals: APPROVAL_OPTIONS.map(({ decision }) => `fixture-approval-${decision}`),
  save: 'fixture-secret-save', decline: 'fixture-secret-decline',
};

export function validateScenario(scenario) {
  if (!['basic', 'interactions', 'executor', 'library', 'landing', 'latest-t3'].includes(scenario)) throw new Error('Scenario must be basic, interactions, executor, library, landing or latest-t3.');
}

// A believable personal setup for product screenshots. Everything here is invented;
// no provider runs and nothing can be sent or answered.
export const LANDING_SAMPLES = [
  { slug: 'morning', name: 'Morning', shape: 't3', color: 'purple', primary: true },
  { slug: 'money', name: 'Money', shape: 'clover', color: 'pink', primary: false, pinned: true },
  { slug: 'trips', name: 'Trips', shape: 'sparkle', color: 'blue', primary: false, section: 'personal' },
  { slug: 'site', name: 'Side project', shape: 'hex', color: 'purple', primary: false, section: 'work' },
];
export const LANDING_SECTIONS = ['personal', 'work'];
export const LANDING_USER = 'Sam';

export function landingData(now = new Date()) {
  const at = (daysAgo, hour, minute = 0) => { const d = new Date(now); d.setDate(d.getDate() - daysAgo); d.setHours(hour, minute, 0, 0); return d.toISOString(); };
  const transcripts = {
    morning: [
      { type: 'user_message', at: at(0, 8, 2), text: 'What do I need to deal with today?' },
      { type: 'assistant_message', at: at(0, 8, 2), text: 'Two things.\n\n1. Your car insurance renews on Friday. The new quote is €412, up from €388 last year.\n2. The dentist moved you to Thursday at 4:30.\n\nThe rest of the week is clear.' },
      { type: 'user_message', at: at(0, 8, 4), text: 'Check this for me every morning.' },
      { type: 'assistant_message', at: at(0, 8, 4), text: 'Done. I\'ll look at your calendar and inbox at 8:00 every day, and only message you when something needs you.' },
    ],
    money: [
      { type: 'user_message', at: at(0, 7, 41), text: 'Anything unusual this week?' },
      { type: 'assistant_message', at: at(0, 7, 42), text: 'One thing. A €49 charge from a streaming service you cancelled in September. Everything else matches last month.' },
      { type: 'user_input_request', at: at(0, 7, 42), requestId: 'landing-money-dispute', questions: [{
        id: 'dispute', question: 'Dispute the €49 charge?', allowCustomAnswer: false,
        options: [{ label: 'Yes, dispute it', value: 'dispute' }, { label: 'Leave it', value: 'leave' }],
      }] },
    ],
    trips: [
      { type: 'user_message', at: at(1, 18, 10), text: 'Find a hotel in Lisbon for the 14th to the 17th. Walkable, under €180 a night.' },
      { type: 'assistant_message', at: at(1, 18, 16), text: 'Booked Lisboa Pessoa, €164 a night, three minutes from Baixa-Chiado. The confirmation is in your email and in Library.' },
    ],
    site: [
      { type: 'user_message', at: at(3, 14, 5), text: 'The login page breaks on Safari. Can you fix it?' },
      { type: 'subagent', at: at(3, 14, 6), title: 'Safari regression check', childThreadId: 'thread-site-child', subagentId: 'safari-check' },
      { type: 'assistant_message', at: at(3, 14, 31), text: 'Found it. The form used a `:has()` selector that Safari 16 doesn\'t support. Fixed, tested on Safari 16 and 17, and opened PR #42.' },
    ],
    'site-child': [
      { type: 'assistant_message', at: at(3, 14, 20), text: 'Login renders and submits on Safari 16.6 and 17.2. No regressions on Chrome or Firefox.' },
    ],
  };
  const tasks = [
    { id: 'landing-routine-morning', title: 'Morning check', prompt: 'Check my calendar and inbox. Tell me what needs me today.', enabled: true,
      schedule: { type: 'fixed_time', timeOfDay: '08:00' }, projectId: 'project-morning', threadId: 'thread-morning',
      nextRunAt: at(-1, 8), lastRunAt: at(0, 8), lastRunStatus: 'completed', runCount: 23 },
    { id: 'landing-routine-money', title: 'Weekly recap', prompt: 'Sum up what went out this week and flag anything unusual.', enabled: true,
      schedule: { type: 'fixed_time', timeOfDay: '18:00', weekdays: [0] }, projectId: 'project-money', threadId: 'thread-money',
      nextRunAt: at(-6, 18), lastRunAt: at(1, 18), lastRunStatus: 'completed', runCount: 9 },
  ];
  return { samples: LANDING_SAMPLES, sections: LANDING_SECTIONS, userName: LANDING_USER, transcripts, tasks, unread: ['trips'], child: { parent: 'site', title: 'Safari regression check' } };
}

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value, keys) => record(value) && Object.keys(value).every((key) => keys.includes(key));

export function seedInteractions({ threads, items, stamp }) {
  const requests = new Map(threads.map(({ id }) => [id, []]));
  const targets = new Map();
  let tick = 0;
  const now = () => new Date(Date.parse(stamp) + ++tick * 1000).toISOString();
  const append = (threadId, type, extra = {}) => {
    const ordinal = Math.max(0, ...items.get(threadId).map((item) => item.ordinal)) + 1;
    const at = now();
    const item = { id: `${threadId}-interaction-${ordinal}`, threadId, ordinal, type,
      runId: null, nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null,
      parentItemId: null, status: 'completed', title: null, startedAt: at, completedAt: at, updatedAt: at, ...extra };
    items.get(threadId).push(item);
    return item;
  };
  const message = (threadId, type, text, extra = {}) => append(threadId, type, {
    messageId: `${threadId}-fixture-message-${items.get(threadId).length}`, text,
    ...(type === 'user_message' ? { createdBy: 'user', creationSource: 'web', inputIntent: 'turn_start', attachments: [] } : {}), ...extra,
  });
  for (let index = 1; index <= 12; index++) message('thread-alpha', 'assistant_message',
    `Generic history ${index}. This fixed paragraph gives the parent transcript a measurable scroll position.\n\nOnly disposable scripted data is present.`);
  message('thread-alpha', 'assistant_message', 'Exchange return anchor. Ask @Beta and @Gamma. Thread reference: t3-thread://v1/thread-beta.\n\nThese are paired synthetic messages, not live Bot delivery.');
  const exchange = (sender, recipient, id, text) => {
    append(`thread-${sender.toLowerCase()}`, 'dynamic_tool', { toolName: 't3-code.t3_thread_send',
      input: { threadId: `thread-${recipient.toLowerCase()}`, message: `From ${sender}: ${text}` },
      output: { threadId: `thread-${recipient.toLowerCase()}`, messageId: id } });
    message(`thread-${recipient.toLowerCase()}`, 'user_message', `From ${sender}: ${text}`, {
      senderThreadId: `thread-${sender.toLowerCase()}`, messageId: id, createdBy: 'agent', creationSource: 'mcp',
    });
  };
  exchange('Alpha', 'Beta', 'fixture-alpha-beta', 'Please review the generic sample.');
  exchange('Alpha', 'Gamma', 'fixture-alpha-gamma', 'Please check the generic layout.');
  exchange('Beta', 'Alpha', 'fixture-beta-alpha', 'The generic sample is ready.');

  const addRequest = (id, type, extra, status = 'pending', threadId = 'thread-alpha', decision) => {
    const item = append(threadId, type, { id: `${id}-item`, requestId: id, nodeId: `node-${id}`,
      status: status === 'pending' ? 'waiting' : status === 'cancelled' || decision === 'decline' || decision === 'cancel' ? 'cancelled' : 'completed',
      ...(status === 'pending' ? { completedAt: null } : {}), ...extra });
    const request = { id, nodeId: item.nodeId, providerTurnId: null, nativeRequestRef: null,
      kind: type === 'user_input_request' ? 'user_input' : 'command', status,
      responseCapability: { type: 'live', providerSessionId: 'fixture-session' },
      createdAt: item.startedAt, resolvedAt: status === 'pending' ? null : item.completedAt,
      ...(decision ? { decision } : {}) };
    requests.get(threadId).push(request);
    targets.set(id, { item, request });
  };
  const initialQuestion = { id: 'draft', header: 'Generic draft', question: 'Review the proposed generic message',
    options: [], allowCustomAnswer: true, initialAnswer: INITIAL_ANSWER };
  addRequest(INTERACTION_IDS.initial, 'user_input_request', { questions: [initialQuestion] });
  addRequest(INTERACTION_IDS.multi, 'user_input_request', { questions: [
    { id: 'choices', header: 'Generic choices', question: 'Which generic samples should be checked?', multiSelect: true,
      allowCustomAnswer: false, options: [{ label: 'First sample', description: 'Generic first sample', value: 'first-id' },
        { label: 'Second sample', description: 'Generic second sample', value: 'second-id' }] },
    { ...initialQuestion, id: 'detail', question: 'Review the generic detail' },
  ] });
  // Asynchronous questions resume the provider through a synthetic message.
  // The real transcript must fold that message into its answered question.
  targets.get(INTERACTION_IDS.multi).request.responseCapability = { type: 'message' };
  for (const id of INTERACTION_IDS.approvals) addRequest(id, 'approval_request', {
    requestKind: 'command', title: `Generic approval: ${id.slice('fixture-approval-'.length)}`,
    reason: 'Synthetic decision only. No command executes and no permission is granted.',
    prompt: 'Review the generic sample', options: structuredClone(APPROVAL_OPTIONS),
  });
  for (const [status, decision] of [['resolved', 'accept'], ['resolved', 'decline'], ['expired'], ['cancelled']]) {
    const suffix = decision ?? status;
    addRequest(`fixture-terminal-approval-${suffix}`, 'approval_request', { requestKind: 'command',
      title: `Generic ${suffix} approval`, options: structuredClone(APPROVAL_OPTIONS) }, status, 'thread-beta', decision);
  }
  for (const status of ['resolved', 'expired', 'cancelled']) addRequest(`fixture-terminal-question-${status}`,
    'user_input_request', { questions: [{ ...initialQuestion, question: `Generic ${status} question` }] }, status, 'thread-beta');
  const addSecret = (id, status = 'pending', threadId = 'thread-alpha') => {
    const item = append(threadId, 'secret_request', { id,
      label: `Generic secret: ${id.slice('fixture-secret-'.length)}`,
      reason: 'Synthetic only. Use DUMMY_SECRET from scripts/fixture-scenarios.mjs. No value is stored or delivered.',
      placeholder: 'Fixed dummy fixture value only', secretStatus: status,
      status: status === 'pending' ? 'waiting' : status === 'cancelled' ? 'cancelled' : 'completed',
      ...(status === 'pending' ? { completedAt: null } : {}) });
    targets.set(id, { item });
  };
  addSecret(INTERACTION_IDS.save);
  addSecret(INTERACTION_IDS.decline);
  for (const status of ['saved', 'declined', 'cancelled']) addSecret(`fixture-secret-${status}`, status, 'thread-gamma');
  for (let index = 1; index <= 12; index++) message('thread-alpha', 'assistant_message',
    `Generic continuation ${index}. Return to the exchange anchor above to check exact parent scroll restoration.\n\nNo provider or real T3 runs in this scenario.`);
  addRequest(INTERACTION_IDS.layout, 'user_input_request', { questions: [{ id: 'layout',
    question: 'Which layout do you prefer?', allowCustomAnswer: false,
    options: [{ label: 'Compact', value: 'compact' }, { label: 'Spacious', value: 'spacious' }],
  }] });
  targets.get(INTERACTION_IDS.layout).request.responseCapability = { type: 'message' };

  // Dedicated populated comparison lane; original Alpha acceptance specimens stay unchanged.
  message('thread-gamma', 'user_message', 'Please compare these disposable UI specimens.', { id: 'fixture-rich-user' });
  for (const [name, text] of RICH_MESSAGES) message('thread-gamma', 'assistant_message', text, {
    id: `fixture-rich-${name}`, runId: 'fixture-rich-request-id',
  });
  const layout = { id: 'layout', question: 'Pick a layout', allowCustomAnswer: true,
    options: [{ label: 'Compact', value: 'compact' }, { label: 'Spacious', value: 'spacious' }] };
  addRequest('fixture-rich-choice', 'user_input_request', { questions: [layout] }, 'pending', 'thread-gamma');
  targets.get('fixture-rich-choice').request.responseCapability = { type: 'message' };
  addRequest('fixture-rich-custom', 'user_input_request', { questions: [{...layout, question:'Choose format'}] }, 'pending', 'thread-gamma');
  targets.get('fixture-rich-custom').request.responseCapability = { type: 'message' };
  addRequest('fixture-rich-review', 'user_input_request', { questions: [layout, {
    id: 'sections', question: 'Pick sections', multiSelect: true, allowCustomAnswer: false,
    options: [{label:'Summary', value:'summary'}, {label:'Code sample', value:'code'}],
  }], questionAnswer: { requestId:'fixture-rich-review', answers: {layout:'compact', sections:['summary','code']} } }, 'resolved', 'thread-gamma');
  targets.get('fixture-rich-review').request.answers = {layout:'compact', sections:['summary','code']};

  const counters = new Map([...targets].map(([id]) => [id, { attempts: 0, accepted: 0, failed: 0, rejected: 0, failOnce: false }]));
  const statusOf = ({ item, request }) => request?.status ?? item.secretStatus;
  const updateShell = () => {
    for (const thread of threads) {
      const pending = requests.get(thread.id).find((request) => request.status === 'pending');
      thread.pendingRuntimeRequest = pending ? { id: pending.id, kind: pending.kind, blocking: true } : null;
    }
  };
  updateShell();
  const validAnswers = (questions, answers) => onlyKeys(answers, questions.map(({ id }) => id)) &&
    Object.keys(answers).length === questions.length && questions.every((question) => {
      const answer = answers[question.id];
      const values = question.options.map((option) => option.value ?? option.label);
      const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
        (question.allowCustomAnswer !== false || values.includes(value));
      return question.multiSelect
        ? typeof answer === 'string' ? question.allowCustomAnswer !== false && text(answer)
          : Array.isArray(answer) && answer.length > 0 && new Set(answer).size === answer.length && answer.every(text)
        : text(answer);
    });

  return {
    requests,
    inspect() {
      return { fixtureOnly: true, scenario: 'interactions', liveDelivery: false,
        targets: [...targets].map(([id, target]) => ({ id, threadId: target.item.threadId,
          kind: target.item.type, status: statusOf(target), ...counters.get(id),
          ...(target.request?.decision ? { decision: target.request.decision } : {}),
          ...(target.request?.answers ? { answerFields: Object.entries(target.request.answers).map(([id, value]) => ({ id, type: Array.isArray(value) ? 'array' : 'string' })) } : {}),
        })) };
    },
    armFailure(body) {
      if (!onlyKeys(body, ['targetId']) || typeof body.targetId !== 'string') return false;
      const target = targets.get(body.targetId);
      if (!target || statusOf(target) !== 'pending') return false;
      counters.get(body.targetId).failOnce = true;
      return true;
    },
    // Returns null for RPCs outside this deliberately narrow scenario.
    respond(tag, payload) {
      const secret = tag === 'secrets.answerRequest';
      const dismiss = tag === 'orchestration.dispatchCommand' && payload?.type === 'thread.user-input.dismiss';
      if (!secret && !dismiss && !(tag === 'orchestration.dispatchCommand' && payload?.type === 'runtime-request.respond')) return null;
      const target = targets.get(secret ? payload?.turnItemId : payload?.requestId);
      if (!target || target.item.threadId !== payload?.threadId || secret !== (target.item.type === 'secret_request')) return { error: 'Unknown fixture interaction target.' };
      const count = counters.get(secret ? payload.turnItemId : payload.requestId);
      count.attempts++;
      const reject = (error) => { count.rejected++; return { error }; };
      if (statusOf(target) !== 'pending') return reject('Fixture interaction already answered or terminal.');
      if (secret) {
        if (!onlyKeys(payload, ['threadId', 'turnItemId', 'answer']) ||
          !(onlyKeys(payload.answer, ['type']) && payload.answer.type === 'decline' ||
            onlyKeys(payload.answer, ['type', 'secret']) && payload.answer.type === 'save' && payload.answer.secret === DUMMY_SECRET)) {
          return reject('Fixture secret response rejected. Use only the fixed dummy fixture value or decline.');
        }
      } else {
        if (typeof payload.commandId !== 'string' || !payload.commandId.length) return reject('Fixture response requires a commandId.');
        if (dismiss) {
          if (!onlyKeys(payload, ['commandId', 'type', 'threadId', 'requestId']) || target.request.kind !== 'user_input' ||
            target.request.responseCapability.type !== 'message') return reject('This fixture question needs an answer.');
        } else if (target.request.kind === 'user_input') {
          if (!onlyKeys(payload, ['commandId', 'type', 'threadId', 'requestId', 'answers']) || !validAnswers(target.item.questions, payload.answers)) return reject('Fixture question requires complete valid answers.');
        } else if (!onlyKeys(payload, ['commandId', 'type', 'threadId', 'requestId', 'decision']) ||
          !target.item.options.some(({ decision }) => decision === payload.decision)) return reject('Unsupported fixture approval decision.');
      }
      if (count.failOnce) {
        count.failOnce = false;
        count.failed++;
        return { error: 'Synthetic fixture response failed once. Try again.' };
      }
      // Never retain, echo, log, hash or write the submitted secret value.
      const at = now();
      // T3 resolves the request for every decision, while decline/cancel mark
      // the associated action item cancelled (dispatchRuntimeRequestRespond).
      target.item.status = dismiss || !secret && ['decline', 'cancel'].includes(payload.decision) ? 'cancelled' : 'completed';
      target.item.completedAt = at;
      target.item.updatedAt = at;
      if (secret) target.item.secretStatus = payload.answer.type === 'save' ? 'saved' : 'declined';
      else {
        target.request.status = 'resolved';
        target.request.resolvedAt = at;
        if (dismiss) target.request.decision = 'cancel';
        else if (target.request.kind === 'user_input') {
          target.request.answers = structuredClone(payload.answers);
          target.item.questionAnswer = { requestId: target.request.id, answers: structuredClone(payload.answers), attachmentsByQuestionId: {},
            questionTextById: Object.fromEntries(target.item.questions.map(({ id, question }) => [id, question])) };
          if (target.request.responseCapability.type === 'message') {
            const text = target.item.questions.map(({ id, question }) => {
              const answer = payload.answers[id];
              return `${question}\n${Array.isArray(answer) ? answer.join(', ') : answer}`;
            }).join('\n\n');
            message(target.item.threadId, 'user_message', text, {
              messageId: `async-answer:${target.request.id}`, creationSource: 'server',
            });
          }
        } else target.request.decision = payload.decision;
      }
      count.accepted++;
      updateShell();
      return { ok: true };
    },
  };
}

// Shapes added in T3 Code 0.1.6–0.1.8, so the app can be checked without a real T3:
// a child waiting on an approval, a Stop the agent ignored, one-time and policy-blocked
// routines, and a Bot whose project was archived in T3 Code. Synthetic data only.
export const LATEST_T3_IDS = { childApproval: 'fixture-child-approval', stuckRun: 'fixture-run-stuck', once: 'fixture-routine-once', blocked: 'fixture-routine-blocked' };
export function seedLatestT3({ threads, items, runs, projects, model, stamp }) {
  const requests = new Map(threads.map(({ id }) => [id, []]));
  const ordinal = (threadId) => Math.max(0, ...items.get(threadId).map((item) => item.ordinal)) + 1;
  const base = (threadId, type, extra) => ({ id: `${threadId}-latest-${ordinal(threadId)}`, threadId, ordinal: ordinal(threadId), type,
    runId: null, status: 'completed', title: null, startedAt: stamp, completedAt: stamp, updatedAt: stamp, parentItemId: null, ...extra });
  projects.find((p) => p.id === 'project-gamma').archivedAt = stamp;

  const child = threads.find((t) => t.id === 'thread-alpha-child');
  const approval = base(child.id, 'approval_request', { requestId: LATEST_T3_IDS.childApproval, requestKind: 'command', status: 'waiting', completedAt: null,
    title: 'Delete the generic build folder', reason: 'Synthetic decision only. No command executes.', prompt: 'rm -rf ./generic-build',
    options: [{ decision: 'accept', label: 'Allow once' }, { decision: 'decline', label: 'Deny' }] });
  items.get(child.id).push(approval);
  const request = { id: LATEST_T3_IDS.childApproval, kind: 'command', status: 'pending', responseCapability: { type: 'live', providerSessionId: 'fixture-session' }, createdAt: stamp, resolvedAt: null };
  requests.get(child.id).push(request);
  child.pendingRuntimeRequest = { id: request.id, kind: 'command', blocking: true };

  const beta = threads.find((t) => t.id === 'thread-beta');
  const run = { id: LATEST_T3_IDS.stuckRun, ordinal: 1, status: 'running', requestedAt: stamp, startedAt: stamp, completedAt: null, modelSelection: model };
  runs.get(beta.id).push(run);
  Object.assign(beta, { status: 'running', activityRunStatus: 'running', activeRunId: run.id, latestRunId: run.id, latestRunStartedAt: stamp });
  items.get(beta.id).push(base(beta.id, 'run_interrupt_request', { runId: run.id, message: 'Stop', unresponsiveAt: stamp }));

  const task = (id, title, schedule, extra = {}) => ({ id, title, prompt: `Generic routine: ${title}`, enabled: false, schedule, projectId: 'project-alpha', threadId: 'thread-alpha',
    workspaceStrategy: { type: 'root' }, modelSelection: model, runtimeMode: 'auto', interactionMode: 'default', nextRunAt: null, lastRunAt: null, lastRunStatus: null, lastRunError: null, runCount: 0, ...extra });
  const tasks = [
    task(LATEST_T3_IDS.once, 'Send the generic reminder once', { type: 'once', runAt: '2026-12-01T08:30:00.000Z' }),
    task(LATEST_T3_IDS.blocked, 'Generic weekday check', { type: 'fixed_time', timeOfDay: '09:00', weekdays: [1, 2, 3, 4, 5] }, { enabled: true, blockedByPolicy: 'Scheduled tasks are turned off by Example Org.' }),
  ];
  const calls = [];
  return {
    requests, tasks,
    capabilities: { sideChats: true, threadForceStop: true },
    inspect: () => ({ fixtureOnly: true, scenario: 'latest-t3', liveDelivery: false, request: request.status, decision: request.decision ?? null, run: run.status, gammaArchived: !!projects.find((p) => p.id === 'project-gamma').archivedAt, tasks: tasks.map(({ id, enabled }) => ({ id, enabled })), calls }),
    armFailure: () => false,
    respond(tag, payload) {
      if (tag === 'orchestration.dispatchCommand' && payload?.type === 'runtime-request.respond' && payload.requestId === request.id) {
        if (payload.threadId !== child.id) return { error: 'This approval belongs to the child thread.' };
        if (request.status !== 'pending') return { error: 'Fixture approval already answered.' };
        Object.assign(request, { status: 'resolved', decision: payload.decision, resolvedAt: new Date().toISOString() });
        Object.assign(approval, { status: payload.decision === 'decline' ? 'cancelled' : 'completed', completedAt: request.resolvedAt, updatedAt: request.resolvedAt });
        child.pendingRuntimeRequest = null;
        calls.push({ tag, threadId: payload.threadId, decision: payload.decision });
        return { ok: true };
      }
      if (tag === 'orchestration.forceStopThread') {
        if (payload?.threadId !== beta.id || payload.runId !== run.id) return { error: 'Fixture force stop needs the stuck run.' };
        const at = new Date().toISOString();
        Object.assign(run, { status: 'interrupted', completedAt: at });
        Object.assign(beta, { status: 'interrupted', activityRunStatus: null, activeRunId: null, updatedAt: at });
        items.get(beta.id).push(base(beta.id, 'run_interrupt_result', { runId: run.id, scopeId: 'fixture', files: [] }));
        calls.push({ tag, threadId: payload.threadId, runId: payload.runId });
        return { ok: true, value: { outcome: 'killed', sharedWithThreadIds: [] } };
      }
      if (tag === 'scheduledTasks.setEnabled') {
        const found = tasks.find((t) => t.id === payload?.id);
        if (!found || typeof payload.enabled !== 'boolean') return { error: 'Unknown fixture routine.' };
        found.enabled = payload.enabled;
        calls.push({ tag, id: found.id, enabled: found.enabled });
        return { ok: true, value: { task: found }, tasks: true };
      }
      return null;
    },
  };
}
