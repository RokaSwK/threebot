import assert from 'node:assert/strict';
import { test, after, beforeEach, afterEach } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { Window } from 'happy-dom';
import { buildOnce, domWindow, entryChunk, isModule } from './support.mts';
const channels = []; globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: 'http://routines.test' }));
for (const key of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','localStorage','requestAnimationFrame','cancelAnimationFrame','IntersectionObserver']) Object.defineProperty(globalThis,key,{configurable:true,value:window[key]});
globalThis.getComputedStyle = window.getComputedStyle.bind(window); globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const src = fileURLToPath(new URL('../src/',import.meta.url));
const bundle = await buildOnce({ configFile:false,logLevel:'silent',define:{'process.env.NODE_ENV':'"development"'}, plugins:[{name:'routine-tests',resolveId:id=>id.endsWith('virtual:routines')?'\0routines':undefined,load:id=>id==='\0routines'?`export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export * from ${JSON.stringify(src+'lib/routines.ts')}; export * from ${JSON.stringify(src+'lib/routineReports.ts')}; export * from ${JSON.stringify(src+'lib/routineAlerts.ts')}; export {chatDraft} from ${JSON.stringify(src+'lib/chatDrafts.ts')}; export {Details, RoutineDetail, RoutineRow} from ${JSON.stringify(src+'components/Details.tsx')}; export {useApp, refreshRoutineRuns} from ${JSON.stringify(src+'store.ts')}; export {t3, T3RpcError} from ${JSON.stringify(src+'lib/t3.ts')};`:undefined,transform:(code,id)=>isModule(id,src+'components/Details.tsx')?{code:code+'\nexport {RoutineDetail, RoutineRow};',map:null}:undefined}],ssr:{noExternal:true},build:{ssr:'virtual:routines',write:false}});
const temp = await mkdtemp(join(tmpdir(),'bot-routine-tests-')); const file=join(temp,'test.mjs'); await writeFile(file,entryChunk(bundle).code);
const {createElement:h,act,createRoot,chatDraft,Details,RoutineDetail,RoutineRow,useApp,t3,T3RpcError,...r} = await import(pathToFileURL(file).href);
after(async()=>{for(const c of channels){c.port1.close();c.port2.close();}await window.happyDOM.close();await rm(temp,{recursive:true,force:true});});
const model={instanceId:'provider',model:'example',options:[{id:'effort',value:'high'}]};
const bot={slug:'lab',name:'Lab',projectId:'project',mainThreadId:'thread',model};
const original={id:'routine-1',title:'Check example',prompt:'Read example data',enabled:false,schedule:{type:'fixed_time',timeOfDay:'09:00',weekdays:[1,2,3,4,5]},projectId:'project',threadId:null,workspaceStrategy:{type:'worktree',baseRef:'main',branch:'example',startFromOrigin:true},modelSelection:model,runtimeMode:'auto',interactionMode:'plan',runCount:4,lastRunAt:'2026-10-30T08:00:00Z',lastRunStatus:'succeeded',lastRunError:null,nextRunAt:null};
let root,host,calls,transport;
beforeEach(()=>{calls=[];transport=async(tag,payload)=>({task:{...original,...payload}});t3.call=async(tag,payload)=>{calls.push({tag,payload});return transport(tag,payload);};t3.dispatch=async command=>{calls.push({tag:'dispatch',payload:command});return {sequence:1};};chatDraft(bot,bot.mainThreadId).setText('');globalThis.fetch=async()=>new Response('{}',{status:404});useApp.setState({bots:{lab:bot},threads:{},tasks:[structuredClone(original)],detailsTab:'details',settings:{...useApp.getState().settings,timezone:'Europe/Madrid'}});host=document.createElement('main');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());document.body.replaceChildren();});
const click=async(el)=>{assert.ok(el);await act(async()=>el.click());};
// What the app does: the open routine follows the store, so a move changes its own view.
const LiveRoutine=({bot:b,task:t})=>{const tasks=useApp(s=>s.tasks);return h(RoutineDetail,{bot:b,task:tasks.find(x=>x.id===t.id)??t,onBack(){},onEdit(){}});};
const button=text=>[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
const render=async(el)=>act(async()=>root.render(el));

test('edit keeps identity, paused state, runtime, model and workspace; history is never sent as an input',()=>{
 const result=r.routineInput({task:original,bot,title:'Changed',prompt:'Changed instruction',schedule:original.schedule,commandId:'save-1'});
 assert.equal(result.id,original.id);assert.equal(result.requireExisting,true);assert.equal(result.enabled,false);assert.equal(result.threadId,null);assert.deepEqual(result.workspaceStrategy,original.workspaceStrategy);assert.deepEqual(result.modelSelection,model);assert.equal(result.runtimeMode,'auto');assert.equal(result.interactionMode,'plan');assert.ok(!('runCount' in result));assert.ok(!('lastRunAt' in result));
});
test('new routine starts paused and refuses missing model or malformed schedule',()=>{
 const input=r.routineInput({bot,title:'New',prompt:'Do it',schedule:{type:'interval',everyMs:60000},commandId:'new'}); assert.equal(input.enabled,false);assert.equal(input.runtimeMode,'approval-required');assert.equal(input.id,undefined);assert.equal(input.threadId,'thread');
 assert.throws(()=>r.routineInput({bot:{...bot,model:null},title:'x',prompt:'y',schedule:original.schedule,commandId:'a'}),/model/);
 for(const schedule of [{type:'interval',everyMs:59000},{type:'fixed_time',timeOfDay:'24:00'},{type:'fixed_time',timeOfDay:'09:00',weekdays:[7]}])assert.throws(()=>r.parseSchedule(schedule));
 assert.throws(()=>r.parseRoutineTask({...original,workspaceStrategy:null}));
});
test('webhook editing keeps signature metadata, dedupe and filters without copying credentials into input',()=>{
 const task={...original,schedule:{type:'webhook',signature:{header:'x-signature',encoding:'hex',prefix:'sha256='},filters:[{path:'body.action',op:'equals',value:'opened'}],dedupe:{replayKey:'{{headers.x-id}}',coalesceWindowSeconds:120},maxDeliveryAgeMinutes:30},webhook:{url:'https://example.invalid/private-token',path:'/private-token',hasSecret:true}};
 const input=r.routineInput({task,bot,title:task.title,prompt:task.prompt,schedule:task.schedule,commandId:'hook'});assert.deepEqual(input.schedule,task.schedule);assert.ok(!JSON.stringify(input).includes('private-token'));assert.ok(!('secret' in input.schedule.signature));
 assert.throws(()=>r.parseSchedule({...task.schedule,dedupe:{replayKey:'not-a-template'}}),/template/);
 assert.throws(()=>r.parseFilters([{path:'secret',op:'exists'}]));
});
test('schedule wording keeps exact interval and weekdays, and dates account for DST without changing schedule',()=>{
 assert.equal(r.scheduleText({schedule:{type:'interval',everyMs:90000}}),'Every 90 seconds');assert.match(r.scheduleText(original),/Weekdays.*server time/);
 assert.match(r.routineDate('2026-03-29T00:30:00Z','Europe/Madrid'),/1:30|01:30/);assert.match(r.routineDate('2026-03-29T01:30:00Z','Europe/Madrid'),/3:30|03:30/);
 assert.match(r.routineDate('2026-10-25T00:30:00Z','Europe/Madrid'),/2:30|02:30/);assert.match(r.routineDate('2026-10-25T01:30:00Z','Europe/Madrid'),/2:30|02:30/);
 assert.equal(original.schedule.timeOfDay,'09:00');assert.equal(r.dispatchStatus('succeeded'),'Dispatched');assert.equal(r.dispatchStatus('failed'),'Dispatch failed');
});
test('editing a routine prepares chat without changing its stored settings or history',async()=>{
 const b={...bot,shape:'blob',color:'blue'};useApp.setState({bots:{lab:b}});
 const before=structuredClone(useApp.getState().tasks);
 await render(h(Details,{bot:b,threadId:null}));
 await click([...host.querySelectorAll('button')].find(el=>el.textContent.startsWith(original.title)));
 await click(button('Edit'));
 assert.equal(chatDraft(b,b.mainThreadId).getSnapshot().text,'Edit your routine: Check example');
 assert.equal(useApp.getState().selectedThreadId,null);
 assert.equal(useApp.getState().detailsOpen,false);
 assert.deepEqual(useApp.getState().tasks,before);
 assert.equal(calls.some(c=>c.tag.startsWith('scheduledTasks.')),false);
});

test('routine chat editing preserves the existing draft and never submits automatically',async()=>{
 const b={...bot,shape:'blob',color:'blue'};useApp.setState({bots:{lab:b}});
 chatDraft(b,b.mainThreadId).setText('Keep my draft');
 await render(h(Details,{bot:b,threadId:null}));
 await click([...host.querySelectorAll('button')].find(el=>el.textContent.startsWith(original.title)));
 await click(button('Edit'));
 assert.equal(chatDraft(b,b.mainThreadId).getSnapshot().text,'Keep my draft\n\nEdit your routine: Check example');
 assert.equal(calls.some(c=>c.tag==='scheduledTasks.upsert'||c.payload?.type==='message.dispatch'),false);
});

test('new routine routes to chat and leaves existing routines intact',async()=>{
 const b={...bot,shape:'blob',color:'blue'};useApp.setState({bots:{lab:b}});
 await render(h(Details,{bot:b,threadId:null}));
 await click(document.querySelector('[aria-label="New routine"]'));
 assert.equal(chatDraft(b,b.mainThreadId).getSnapshot().text,'Set up a routine');
 assert.deepEqual(useApp.getState().tasks,[original]);
 assert.equal(document.querySelector('.routine-editor'),null);
 assert.equal(calls.some(c=>c.tag==='scheduledTasks.upsert'),false);
});

test('list pause failure keeps authoritative switch and schedule wording',async()=>{
 transport=async()=>{throw Error('Denied');};await render(h(RoutineRow,{task:original,onOpen(){}}));assert.match(host.textContent,/Paused.*Weekdays/);await click(document.querySelector('[role="switch"]'));assert.equal(document.querySelector('[role="switch"]').getAttribute('aria-checked'),'false');assert.match(host.textContent,/Denied/);
});
test('detail shows one history list; delete waits for confirmation and acknowledgement',async()=>{
 let back=false;await render(h(RoutineDetail,{bot,task:original,onBack(){back=true;},onEdit(){}}));assert.match(host.textContent,/History/);assert.doesNotMatch(host.textContent,/Last dispatch summary|Recorded run history|Rotate URL token/);assert.match(host.textContent,/not available on this gateway/);assert.ok(!host.textContent.includes('Next:'));
 await click(button('Delete routine'));assert.equal(calls.length,0);transport=async()=>{throw Error('Denied');};await click(button('Delete'));assert.equal(back,false);assert.equal(useApp.getState().tasks.length,1);assert.match(host.textContent,/Denied/);
 transport=async()=>({id:original.id});await click(button('Delete'));assert.equal(back,true);assert.equal(useApp.getState().tasks.length,0);
});
test('redacted webhook diagnostics never return payload, headers, prompts, errors or tokens',async()=>{
 transport=async()=>({deliveries:[{id:'delivery',receivedAt:'2026-10-31T00:00:00Z',outcome:'filtered',signatureVerified:false,body:'PRIVATE',headers:{token:'PRIVATE'},error:'PRIVATE',renderedPrompt:'PRIVATE'}]});const deliveries=await r.webhookDeliveries('routine-1');assert.equal(deliveries[0].outcome,'filtered');assert.ok(!JSON.stringify(deliveries).includes('PRIVATE'));
});

for (const runtimeMode of ['approval-required','auto-accept-edits','auto','full-access']) test(`editor retains T3 runtime mode ${runtimeMode}`,()=>{assert.equal(r.parseRoutineTask({...original,runtimeMode}).runtimeMode,runtimeMode);});

test('webhook Test is unavailable because T3 runNow rejects webhook tasks',async()=>{const task={...original,schedule:{type:'webhook',signature:null}};await assert.rejects(r.testRoutine(task),/private URL/);assert.equal(calls.length,0);await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));assert.equal(button('Test'),undefined);assert.match(host.textContent,/Paused.*When a webhook is called/);});

test('mobile Back returns from routine to list, then profile; changing Bot closes its routine view',async()=>{
 const b={...bot,shape:'blob',color:'blue'};useApp.setState({bots:{lab:b},detailsTab:'details'});
 await render(h(Details,{bot:b,threadId:null}));await click(document.querySelector('.profile-actions button'));await click([...host.querySelectorAll('button')].find(el=>el.textContent.startsWith(original.title)));
 assert.match(host.textContent,/History/);await click(document.querySelector('.details-back'));assert.ok(!host.textContent.includes('History'));assert.match(document.querySelector('.details-page-title').textContent,/Routines/);
 await click(document.querySelector('[aria-label="New routine"]'));assert.equal(document.querySelector('.routine-editor'),null);assert.match(chatDraft(b,b.mainThreadId).getSnapshot().text,/Set up a routine/);
 const other={...b,slug:'other',projectId:'other-project'};useApp.setState({bots:{lab:b,other}});await render(h(Details,{bot:other,threadId:null}));assert.equal(document.querySelector('.routine-editor'),null);assert.ok(!host.textContent.includes(original.title));
});
test('repeated Test clicks dispatch once while pending',async()=>{
 let resolve;transport=()=>new Promise(r=>{resolve=r;});
 await render(h(RoutineDetail,{bot,task:original,onBack(){},onEdit(){}}));
 await act(async()=>{const b=button('Test');b.click();b.click();});
 assert.equal(calls.filter(c=>c.tag==='scheduledTasks.runNow').length,1);await act(async()=>resolve({task:original}));
});

test('webhook details expose no technical form or token rotation controls',async()=>{
 const task={...original,schedule:{type:'webhook',signature:{header:'x-signature',encoding:'base64',prefix:'sha256='}}};
 await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));
 assert.doesNotMatch(host.textContent,/Coalesce key|Replay key|Signature header|Encoding|Prefix|Base64|HMAC|Rotate URL token/);
 assert.equal(calls.length,0);
});

test('editing an open routine closes the detail and does not mount a technical editor',async(t)=>{
 const b={...bot,shape:'blob',color:'blue'};useApp.setState({bots:{lab:b},detailsTab:'details'});
 await render(h(Details,{bot:b,threadId:null}));await click([...host.querySelectorAll('button')].find(el=>el.textContent.startsWith(original.title)));
 const errors=t.mock.method(console,'error',()=>{});await click(button('Edit'));
 assert.equal(document.querySelector('.routine-editor'),null);
 assert.ok(!errors.mock.calls.some(call=>String(call.arguments[0]).includes('same key')));
 assert.match(chatDraft(b,b.mainThreadId).getSnapshot().text,/Edit your routine/);
});

test('one-time routines from T3 0.1.7+ parse, read as a date and keep working controls',async()=>{
 const task={...original,schedule:{type:'once',runAt:'2026-11-20T09:30:00+01:00'},blockedByPolicy:undefined};
 assert.deepEqual(r.parseSchedule(task.schedule),task.schedule);
 for(const schedule of [{type:'once',runAt:'2026-11-20T09:30'},{type:'once',runAt:'soon+01:00'},{type:'once'}])assert.throws(()=>r.parseSchedule(schedule));
 const text=r.scheduleText(task,'Europe/Madrid');assert.match(text,/^Once, /);assert.match(text,/9:30|09:30/);assert.match(text,/2026/);assert.doesNotMatch(text,/webhook/);
 await render(h(RoutineRow,{task,onOpen(){}}));assert.match(host.textContent,/Paused · Once, /);
 await click(document.querySelector('[role="switch"]'));assert.deepEqual(calls.at(-1),{tag:'scheduledTasks.setEnabled',payload:{id:task.id,enabled:true}});assert.equal(document.querySelector('[role="alert"]'),null);
 const input=r.routineInput({task,bot,title:task.title,prompt:task.prompt,schedule:task.schedule,commandId:'once'});assert.deepEqual(input.schedule,task.schedule);
});
test('a routine an administrator policy blocks says why',async()=>{
 const task={...original,enabled:true,blockedByPolicy:'Webhooks are turned off by Example Org.'};
 assert.equal(r.parseRoutineTask(task).blockedByPolicy,task.blockedByPolicy);
 await render(h(RoutineRow,{task,onOpen(){}}));assert.match(host.textContent,/Blocked · Weekdays/);
 await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));assert.match(host.textContent,/This routine can’t run: Webhooks are turned off by Example Org\./);
});
test('a bound routine can start fresh each run where T3 supports thread modes, and keeps everything else',async()=>{
 const task={...original,threadId:'thread',threadMode:'continue',workspaceStrategy:{type:'root'}};
 assert.equal(r.parseRoutineTask(task).threadMode,'continue');assert.equal('threadMode' in r.parseRoutineTask(original),false);
 assert.throws(()=>r.parseRoutineTask({...task,threadMode:'elsewhere'}),/destination/);
 assert.equal(r.threadMode(original),'new_thread');assert.equal(r.threadMode({...original,threadId:'thread'}),'continue');
 const features=useApp.getState().runtimeFeatures;
 useApp.setState({runtimeFeatures:{...features,scheduledTaskThreadModes:false}});
 await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));assert.doesNotMatch(host.textContent,/Start fresh each run/,'older T3 ignores the mode, so no switch');
 await act(async()=>useApp.setState({runtimeFeatures:{...features,scheduledTaskThreadModes:true}}));
 await render(h(RoutineDetail,{bot,task:original,onBack(){},onEdit(){}}));assert.doesNotMatch(host.textContent,/Start fresh each run/,'a routine that starts a new conversation each run has no switch');
 await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));
 const toggle=host.querySelector('[role="switch"]');assert.equal(toggle.getAttribute('aria-labelledby'),'routine-fresh-label');assert.equal(toggle.getAttribute('aria-checked'),'false');assert.match(host.textContent,/continues the conversation/);
 await click(toggle);
 const saved=calls.find(c=>c.tag==='scheduledTasks.upsert');assert.ok(saved);
 assert.equal(saved.payload.threadMode,'fresh_session');assert.equal(saved.payload.id,task.id);assert.equal(saved.payload.requireExisting,true);assert.equal(saved.payload.threadId,'thread');assert.equal(saved.payload.enabled,false);assert.deepEqual(saved.payload.modelSelection,model);assert.equal(saved.payload.runtimeMode,'auto');assert.deepEqual(saved.payload.schedule,task.schedule);
 assert.equal(useApp.getState().tasks.find(t=>t.id===task.id).threadMode,'fresh_session');
 await render(h(RoutineDetail,{bot,task:useApp.getState().tasks.find(t=>t.id===task.id),onBack(){},onEdit(){}}));
 assert.equal(host.querySelector('[role="switch"]').getAttribute('aria-checked'),'true');assert.match(host.textContent,/Lab keeps its memory and files/);
});
test('a routine in the chat keeps the chat model until a different one is picked, then moves to its own conversation',async()=>{
 const chatModel={instanceId:'pi',model:'chat-model',options:[]};const ownModel={instanceId:'pi',model:'cheap',options:[{id:'thinking',value:'low'}]};
 useApp.setState({bots:{lab:{...bot,model:chatModel}},threads:{thread:{id:'thread',modelSelection:chatModel}}});
 transport=async(tag,payload)=>tag==='orchestration.launchThread'?{threadId:'routine-thread'}:{task:{...original,...payload}};
 const task={...original,threadId:'thread',threadMode:'continue',modelSelection:chatModel};
 assert.equal(r.routineDestination(task,bot),'chat');
 assert.equal(await r.setRoutineModel(task,bot,chatModel),null);
 assert.equal(calls.length,0,'keeping the chat model is not a move');
 const moved=await r.setRoutineModel(task,bot,ownModel);
 assert.equal(moved.threadId,'routine-thread');
 const launch=calls.find(c=>c.tag==='orchestration.launchThread').payload;
 assert.equal(launch.projectId,'project');assert.equal(launch.title,task.title);assert.deepEqual(launch.modelSelection,ownModel);assert.deepEqual(launch.workspaceStrategy,{type:'root'});assert.equal(launch.runtimeMode,'auto');assert.equal(launch.interactionMode,'plan');assert.equal('initialMessage' in launch,false);
 const saved=calls.find(c=>c.tag==='scheduledTasks.upsert').payload;
 assert.equal(saved.id,task.id);assert.equal(saved.requireExisting,true);assert.equal(saved.threadId,'routine-thread');assert.equal(saved.threadMode,'continue');assert.deepEqual(saved.modelSelection,ownModel);assert.deepEqual(saved.workspaceStrategy,{type:'root'});
 assert.equal(useApp.getState().tasks.find(t=>t.id===task.id).threadId,'routine-thread');
});
test('changing the model of a routine that has its own conversation changes that conversation only',async()=>{
 const first={instanceId:'pi',model:'flash',options:[]};const next={instanceId:'antigravity',model:'big',options:[{id:'thinking',value:'high'}]};
 const task={...original,threadId:'routine-thread',threadMode:'fresh_session',modelSelection:first};
 transport=async(tag,payload)=>({task:{...task,...payload}});
 assert.equal(r.routineDestination(task,bot),'own');
 const saved=await r.setRoutineModel(task,bot,next);
 assert.equal(saved.modelSelection.model,'big');
 assert.deepEqual(calls.find(c=>c.tag==='dispatch').payload,{type:'thread.model-selection.set',threadId:'routine-thread',modelSelection:next});
 assert.equal(calls.some(c=>c.tag==='orchestration.launchThread'),false,'the conversation already exists');
 const upsert=calls.find(c=>c.tag==='scheduledTasks.upsert').payload;
 assert.equal(upsert.threadId,'routine-thread');assert.equal(upsert.threadMode,'fresh_session');assert.deepEqual(upsert.modelSelection,next);
});
test('routines T3 starts a thread for just save the model',async()=>{
 const next={instanceId:'pi',model:'cheap',options:[]};
 for(const task of [{...original},{...original,threadId:null,threadMode:'fresh_session'}]){
  calls=[];assert.ok(['new-thread','own-pending'].includes(r.routineDestination(task,bot)));
  transport=async(tag,payload)=>({task:{...task,...payload}});
  await r.setRoutineModel(task,bot,next);
  assert.deepEqual(calls.map(c=>c.tag),['scheduledTasks.upsert']);
  assert.deepEqual(calls[0].payload.modelSelection,next);assert.equal(calls[0].payload.threadId,null);
 }
});
test('a routine with its own conversation can go back to the chat',async()=>{
 const task={...original,threadId:'routine-thread',threadMode:'continue'};
 transport=async(tag,payload)=>({task:{...task,...payload}});
 assert.equal(r.routineDestination(task,bot),'own');
 await r.moveRoutineToChat(task,bot);
 const saved=calls.find(c=>c.tag==='scheduledTasks.upsert').payload;
 assert.equal(saved.threadId,'thread');assert.equal(saved.threadMode,'continue');assert.deepEqual(saved.workspaceStrategy,{type:'root'});
 assert.equal(calls.some(c=>c.tag==='dispatch'||c.tag==='orchestration.launchThread'),false);
 await assert.rejects(r.moveRoutineToChat({...task,threadId:'thread'},bot),/already runs in the chat/);
});
test('edits keep who created the routine and where it came from',()=>{
 const task={...original,createdBy:'agent',creationSource:'mcp',threadId:'thread',threadMode:'continue'};
 assert.equal(r.routineDestination(task,bot),'chat');
 const parsed=r.parseRoutineTask(task);assert.equal(parsed.createdBy,'agent');assert.equal(parsed.creationSource,'mcp');
 const saved=r.routineSaveInput(parsed,{modelSelection:{instanceId:'pi',model:'cheap',options:[]}});assert.equal(saved.createdBy,'agent');assert.equal(saved.creationSource,'mcp');
 const edited=r.routineInput({task,bot,title:task.title,prompt:task.prompt,schedule:task.schedule,commandId:'keep-me'});assert.equal(edited.createdBy,'agent');assert.equal(edited.creationSource,'mcp');
 assert.equal(r.routineSaveInput(r.parseRoutineTask(original)).createdBy,'user');
});

test('the chat routine shows its chat model and the sheet explains what picking another one does',async()=>{
 const chatModel={instanceId:'pi',model:'chat-model',options:[]};
 useApp.setState({bots:{lab:{...bot,model:chatModel}},threads:{thread:{id:'thread',modelSelection:chatModel}},providers:[]});
 const task={...original,threadId:'thread',threadMode:'continue',modelSelection:chatModel};
 await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));
 assert.match(host.textContent,/Runs with the model of Lab’s chat/);
 await click(button('Use its own model…'));
 const dialog=document.querySelector('[role="dialog"]');
 assert.match(dialog.textContent,/Model for this routine/);
 assert.match(dialog.textContent,/A model of its own means a conversation of its own\. Lab’s chat keeps its model\./);
 assert.equal(calls.some(c=>c.tag==='orchestration.launchThread'),false,'opening the sheet moves nothing');
});
test('picking a model for a chat routine asks before moving it to its own conversation',async()=>{
 const chatModel={instanceId:'pi',model:'chat-model',options:[]};
 useApp.setState({bots:{lab:{...bot,model:chatModel}},threads:{thread:{id:'thread',modelSelection:chatModel}},providers:[{instanceId:'pi',driver:'pi',displayName:'Pi',enabled:true,status:'ready',models:[{slug:'chat-model',name:'Chat model'},{slug:'cheap',name:'Cheap'}]}]});
 const task={...original,threadId:'thread',threadMode:'continue',modelSelection:chatModel};
 transport=async(tag,payload)=>tag==='orchestration.launchThread'?{threadId:'routine-thread'}:{task:{...task,...payload}};
 await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));
 await click(button('Use its own model…'));
 const cheap=[...document.querySelectorAll('[role="radio"]')].find(el=>el.textContent?.includes('Cheap'));
 assert.ok(cheap);
 await act(async()=>(cheap as HTMLElement).click());
 assert.match(host.textContent,/Move it to its own conversation on Cheap\?/,'the confirmation names the model as the picker does');
 assert.equal(calls.some(c=>c.tag==='orchestration.launchThread'),false,'the move waits for the confirmation');
 await click(button('Move it'));
 const launch=calls.find(c=>c.tag==='orchestration.launchThread');
 assert.deepEqual(launch.payload.modelSelection,{instanceId:'pi',model:'cheap',options:[]});
 assert.ok(launch.payload.threadId.startsWith('threebot-routine:'),'the conversation is marked as the routine\u2019s own');
 const saved=calls.find(c=>c.tag==='scheduledTasks.upsert');
 assert.equal(saved.payload.threadId,'routine-thread');
 assert.equal(useApp.getState().tasks.find(t=>t.id===task.id).threadId,'routine-thread');
});
test('a routine with its own conversation changes that model and can move back to the chat',async()=>{
 const chatModel={instanceId:'pi',model:'chat-model',options:[]};const own={instanceId:'pi',model:'cheap',options:[]};
 const task={...original,threadId:'routine',threadMode:'continue',modelSelection:own,runCount:2,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 useApp.setState({bots:{lab:{...bot,model:chatModel}},threads:{thread:{id:'thread',modelSelection:chatModel},routine:{id:'routine',modelSelection:own,latestRunId:'run-1'}},tasks:[structuredClone(task)],providers:[]});
 transport=async(tag,payload)=>({task:{...task,...payload}});
 await render(h(LiveRoutine,{bot,task}));
 assert.match(host.textContent,/Runs on cheap in its own conversation/);
 assert.match(host.textContent,/Open conversation/);
 await click(button('Move it back to the chat'));
 assert.match(host.textContent,/Move it back to Lab’s chat\?/);
 await click(button('Move it back'));
 const saved=calls.find(c=>c.tag==='scheduledTasks.upsert');
 assert.equal(saved.payload.threadId,'thread');assert.equal(saved.payload.threadMode,'continue');
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30));});
 assert.match(host.querySelector('[role="status"][aria-live="polite"]').textContent,/Back in the chat/);
 assert.equal(document.activeElement?.textContent?.trim(),'Use its own model…','focus returns to the action that reappears');
});
test('a conversation the routine was just moved to offers nothing to open until it runs',async()=>{
 const own={instanceId:'pi',model:'cheap',options:[]};
 // runCount counts the runs it had in the chat; the new conversation is still empty.
 const task={...original,threadId:'routine',threadMode:'continue',modelSelection:own,runCount:2,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 useApp.setState({threads:{thread:{id:'thread',modelSelection:model},routine:{id:'routine',modelSelection:own,latestRunId:null}},providers:[]});
 await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));
 assert.match(host.textContent,/Nothing there until the first run/);
 assert.equal(button('Open conversation'),undefined);
});
test('cancelling the move keeps the routine in the chat and moves no focus or data',async()=>{
 const chatModel={instanceId:'pi',model:'chat-model',options:[]};
 useApp.setState({bots:{lab:{...bot,model:chatModel}},threads:{thread:{id:'thread',modelSelection:chatModel}},providers:[{instanceId:'pi',driver:'pi',displayName:'Pi',enabled:true,status:'ready',models:[{slug:'chat-model',name:'Chat model'},{slug:'cheap',name:'Cheap'}]}]});
 const task={...original,threadId:'thread',threadMode:'continue',modelSelection:chatModel};
 await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));
 await click(button('Use its own model…'));
 const cheap=[...document.querySelectorAll('[role="radio"]')].find(el=>el.textContent?.includes('Cheap'));
 await act(async()=>(cheap as HTMLElement).click());
 await click(button('Keep it here'));
 assert.equal(calls.some(c=>c.tag==='scheduledTasks.upsert'),false);
 assert.equal(document.activeElement?.textContent?.trim(),'Use its own model…');
});
const R='threebot-routine:';
const own=(id,extra={})=>({id,title:'Check example',status:'completed',latestRunId:`${id}-run`,latestRunCompletedAt:'2026-11-19T03:31:00Z',pendingRuntimeRequest:null,archivedAt:null,lineage:{parentThreadId:null,relationshipToParent:null,rootThreadId:id},...extra});
test('the routine report tag is per routine and deep-links to its exact conversation',()=>{
 assert.equal(r.routineTag('task-1'),'routine:task-1');
 assert.deepEqual(r.routineTarget('lab','task-1','own-thread'),{tag:'routine:task-1',url:'/?bot=lab&thread=own-thread'});
});
test('a routine in its own conversation reports one line with time and the last text',async()=>{
 const task={...original,threadId:R+'a',threadMode:'continue',runCount:2,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 const threads={[R+'a']:own(R+'a'),[R+'empty']:own(R+'empty')};
 transport=async(tag)=>tag==='orchestration.getThreadProjection'?{messages:[{id:'message-1',runId:'run-1',scheduledTaskId:task.id}],runs:[{id:'run-1',status:'completed',completedAt:'2026-11-19T03:30:30Z'}],turnItems:[{type:'assistant_message',runId:'run-1',text:'Tidied three lines.\n\nDetails.'}]}:{};
 const reports=await r.readRoutineReports(bot,[task],threads);
 assert.deepEqual(reports,[{id:task.id,at:'2026-11-19T03:30:30Z',title:task.title,summary:'Tidied three lines.',threadId:R+'a',state:'finished',bot:'lab'}]);
 assert.equal((await r.readRoutineReports(bot,[{...task,threadId:'thread'}],{...threads,thread:own('thread')})).length,0,'a routine in the chat leaves no line');
 transport=async()=>({messages:[{id:'message-2',runId:'run-2',scheduledTaskId:'routine-empty'}],runs:[{id:'run-2',status:'completed'}],turnItems:[]});
 const empty=await r.readRoutineReports(bot,[{...task,id:'routine-empty',threadId:R+'empty'}],threads);
 assert.equal(empty[0].summary,'The run finished without a written report.','a run without text does not borrow another reply');
});
test('the line follows the run in its conversation, not only T3\u2019s dispatch record',async()=>{
 // T3 records "succeeded" as soon as the prompt is sent; the reply lands later in the thread.
 const id=R+'live';
 const task={...original,id:'routine-live',threadId:id,threadMode:'continue',runCount:3,lastRunAt:'2026-11-20T03:30:00Z',lastRunStatus:'succeeded'};
 let text='Yesterday\u2019s report.', status='running';
 transport=async(tag)=>tag==='orchestration.getThreadProjection'?{messages:[{id:'message-live',runId:'run-3',scheduledTaskId:task.id}],runs:[{id:'run-3',status,completedAt:status==='running'?null:'2026-11-20T03:31:00Z'}],turnItems:[{type:'assistant_message',runId:'run-3',text}]}:{};
 const running={[id]:own(id,{status:'running',latestRunId:'run-3',latestRunCompletedAt:null})};
 assert.equal((await r.readRoutineReports(bot,[task],running))[0].summary,'Running now, in its conversation.');
 text='Today\u2019s report.'; status='completed';
 const done={[id]:own(id,{status:'completed',latestRunId:'run-3',latestRunCompletedAt:'2026-11-20T03:31:00Z'})};
 assert.notEqual(r.reportKey(task,running[id]),r.reportKey(task,done[id]),'the reply landing is a new key');
 assert.equal((await r.readRoutineReports(bot,[task],done))[0].summary,'Today\u2019s report.');
 const asking={[id]:own(id,{status:'running',latestRunId:'run-3',latestRunCompletedAt:null,pendingRuntimeRequest:{id:'req',kind:'approval',blocking:true}})};
 assert.equal((await r.readRoutineReports(bot,[task],asking))[0].summary,'Waiting for you in its conversation.');
 status='failed';
 const failed=await r.readRoutineReports(bot,[task],{[id]:own(id,{status:'failed',latestRunId:'run-3',latestRunCompletedAt:'2026-11-20T03:32:00Z'})});
 assert.deepEqual([failed[0].state,failed[0].summary],['failed','The run failed. Open the conversation for details.']);
});
test('a manual-only conversation in a routine thread leaves no routine line',async()=>{
 const id=R+'manual-only';
 const task={...original,id:'routine-manual-only',threadId:id,threadMode:'continue',runCount:1,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 transport=async(tag)=>tag==='orchestration.getThreadProjection'?{messages:[{id:'manual',runId:'manual-run',scheduledTaskId:null}],runs:[{id:'manual-run',status:'completed',requestedAt:'2026-11-19T03:30:00Z',completedAt:'2026-11-19T03:30:20Z'}],turnItems:[{type:'assistant_message',runId:'manual-run',text:'Manual reply.'}]}:{};
 assert.deepEqual(await r.readRoutineReports(bot,[task],{[id]:own(id,{status:'completed',latestRunId:'manual-run'})}),[],'a conversation without a routine message is not a routine result');
});
test('a manual turn in a routine thread is never reported as the routine running or waiting',async()=>{
 const id=R+'manual';
 const task={...original,id:'routine-manual',threadId:id,threadMode:'continue',runCount:2,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 transport=async(tag)=>tag==='orchestration.getThreadProjection'?{
  messages:[{id:'routine-message',runId:'routine-run',scheduledTaskId:task.id},{id:'manual-message',runId:'manual-run',scheduledTaskId:null}],
  runs:[{id:'routine-run',status:'completed',requestedAt:'2026-11-19T03:30:00Z',completedAt:'2026-11-19T03:30:20Z'},{id:'manual-run',status:'waiting',requestedAt:'2026-11-19T04:00:00Z'}],
  turnItems:[{type:'assistant_message',runId:'routine-run',text:'Routine report.'},{type:'assistant_message',runId:'manual-run',text:'Manual reply.'}]}:{};
 const waiting={[id]:own(id,{status:'waiting',latestRunId:'manual-run',latestRunCompletedAt:null,pendingRuntimeRequest:{id:'req',kind:'approval',blocking:true}})};
 assert.deepEqual(await r.readRoutineReports(bot,[task],waiting),[],'a manual wait must not show as the routine waiting');
 const running={[id]:own(id,{status:'running',latestRunId:'manual-run',latestRunCompletedAt:null})};
 assert.deepEqual(await r.readRoutineReports(bot,[task],running),[],'a manual run must not show as the routine running');
 // A manual run after the routine's own completed run does not erase the routine's last report.
 transport=async(tag)=>tag==='orchestration.getThreadProjection'?{
  messages:[{id:'routine-message',runId:'routine-run',scheduledTaskId:task.id},{id:'manual-message',runId:'manual-run',scheduledTaskId:null}],
  runs:[{id:'routine-run',status:'completed',requestedAt:'2026-11-19T03:30:00Z',completedAt:'2026-11-19T03:30:20Z'},{id:'manual-run',status:'completed',requestedAt:'2026-11-19T04:00:00Z',completedAt:'2026-11-19T04:00:20Z'}],
  turnItems:[{type:'assistant_message',runId:'routine-run',text:'Routine report.'},{type:'assistant_message',runId:'manual-run',text:'Manual reply.'}]}:{};
 const report=(await r.readRoutineReports(bot,[task],{[id]:own(id,{status:'completed',latestRunId:'manual-run',latestRunCompletedAt:'2026-11-19T04:00:20Z'})}))[0];
 assert.deepEqual([report.state,report.summary],['finished','Routine report.'],'the completed routine keeps its own text and state');
});
test('the line is the routine\u2019s own run, not a reply the user got there by chatting',async()=>{
 const id=R+'chatty';
 const task={...original,id:'routine-chatty',threadId:id,threadMode:'continue',runCount:1,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 transport=async(tag)=>tag==='orchestration.getThreadProjection'?{
  messages:[{id:'m1',runId:'r1',scheduledTaskId:task.id},{id:'m2',runId:'r2',scheduledTaskId:null}],
  turnItems:[{type:'assistant_message',runId:'r1',text:'The routine\u2019s report.'},{type:'assistant_message',runId:'r2',text:'A reply to the user.'}]}:{};
 assert.equal((await r.readRoutineReports(bot,[task],{[id]:own(id)}))[0].summary,'The routine\u2019s report.');
 assert.equal((await r.readRoutineReports(bot,[task],{[id]:own(id)}))[0].state,'finished');
});
test('Details promises a line in the chat only where one will appear',async()=>{
 const own2={instanceId:'pi',model:'cheap',options:[]};
 const task={...original,threadId:'room',threadMode:'continue',modelSelection:own2,runCount:2,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 useApp.setState({threads:{thread:{id:'thread',modelSelection:model},room:{id:'room',modelSelection:own2,latestRunId:'run-1'},[R+'b']:{id:R+'b',modelSelection:own2,latestRunId:'run-1'}},providers:[]});
 await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));
 assert.match(host.textContent,/one-line summary/,'a routine bound to another conversation reports there');
 await render(h(RoutineDetail,{bot,task:{...task,threadId:R+'b'},onBack(){},onEdit(){}}));
 assert.match(host.textContent,/chat gets a one-line summary/);
 useApp.setState({threads:{...useApp.getState().threads,[R+'b']:{id:R+'b',modelSelection:own2,latestRunId:'run-1',archivedAt:'2026-11-20T00:00:00Z'}}});
 await render(h(RoutineDetail,{bot,task:{...task,threadId:R+'b'},onBack(){},onEdit(){}}));
 assert.doesNotMatch(host.textContent,/one-line summary/,'an archived conversation leaves no line either');
 await render(h(RoutineDetail,{bot,task:{...task,threadId:null,threadMode:'new_thread',runCount:0},onBack(){},onEdit(){}}));
 assert.doesNotMatch(host.textContent,/one-line summary/,'a thread per run leaves no line before it has run');
 await render(h(RoutineDetail,{bot,task:{...task,threadId:null,threadMode:'new_thread',runCount:2},onBack(){},onEdit(){}}));
 assert.match(host.textContent,/one-line summary/,'a thread per run reports once it has run');
});
test('only a routine owned by this Bot, in a conversation that has run, leaves a line in this chat',async()=>{
 const task={...original,threadId:R+'a',threadMode:'continue',runCount:2,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 const threads={[R+'a']:own(R+'a')};
 assert.deepEqual(r.ownConversationRoutines(bot,[task],threads).map(t=>t.threadId),[R+'a'],'its own routine reports');
 assert.deepEqual(r.ownConversationRoutines(bot,[{...task,projectId:'someone-else'}],threads),[],'a routine of another project is not this Bot\u2019s');
 assert.deepEqual(r.ownConversationRoutines({...bot,projectId:null},[task],threads),[],'a Bot with no project owns no routine');
 assert.deepEqual(r.ownConversationRoutines(bot,[task],{}),[],'an unknown thread leaves no line');
 assert.deepEqual(r.ownConversationRoutines(bot,[task],{[R+'a']:own(R+'a',{archivedAt:'2026-11-19T04:00:00Z'})}),[],'an archived conversation leaves no line');
 // Just moved: the run T3 recorded happened in the chat, not in the new conversation.
 assert.deepEqual(r.ownConversationRoutines(bot,[task],{[R+'a']:own(R+'a',{latestRunId:null,status:'idle'})}),[],'a conversation that has not run yet leaves no line');
 // A routine bound to another conversation still reports there: a prefix is not what makes it the routine's.
 assert.deepEqual(r.ownConversationRoutines(bot,[{...task,threadId:'room'}],{room:own('room',{title:'#general'})}).map(t=>t.threadId),['room'],'another bound conversation is its own');
 assert.deepEqual(r.ownConversationRoutines({...bot,memoryTidyRoutineId:task.id},[{...task,threadId:'tidy'}],{tidy:own('tidy',{title:'Renamed'})}).map(t=>t.id),[task.id],'the memory tidy\u2019s conversation always counts');
});
test('an adopted project with one Bot does not own user or room routines without explicit evidence',()=>{
 const adopted={...bot,slug:'adopted',name:'Adopted',projectId:'user-repo',mainThreadId:'adopted-main',adopted:true,memoryTidyRoutineId:'tidy-task'};
 const task={...original,id:'user-routine',projectId:'user-repo',threadId:'user-thread',threadMode:'continue'};
 assert.equal(r.routineOwner(task,[adopted],{}).kind,'ambiguous','a user thread in an adopted project is not proof');
 assert.equal(r.routineOwner({...task,threadId:'room-thread'},[adopted],{}).kind,'ambiguous','a room thread in an adopted project is not proof');
 assert.equal(r.routineOwner({...task,threadId:null,threadMode:'new_thread'},[adopted],{}).kind,'ambiguous','a new thread in an adopted project is not proof');
 assert.equal(r.routineOwner({...task,threadId:'adopted-main'},[adopted],{}).kind,'bot','the Bot main thread is proof');
 assert.equal(r.routineOwner({...task,threadId:'tidy-thread',id:'tidy-task'},[adopted],{}).kind,'bot','the tidy routine link is proof');
 assert.equal(r.routineOwner(task,[adopted],{[task.id]:{bot:'adopted'}}).kind,'bot','an explicit link resolves it');
 assert.deepEqual(r.ownConversationRoutines(adopted,[{...task,runCount:1,lastRunAt:'2026-11-19T03:30:00Z'}],{'user-thread':own('user-thread')},[adopted],{}),[],'no chat line without evidence');
});
test('a shared project is ambiguous until a routine is linked, and a Bot\u2019s own chat wins over a stale link',()=>{
 const other={...bot,slug:'other',name:'Other',mainThreadId:'other-thread'};
 const task={...original,threadId:R+'shared',threadMode:'continue',runCount:1,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 const threads={[R+'shared']:own(R+'shared')};
 assert.equal(r.routineOwner(task,[bot,other],{}).kind,'ambiguous');
 assert.deepEqual(r.ownConversationRoutines(bot,[task],threads,[bot,other],{}),[],'an ambiguous routine is nobody\u2019s');
 assert.deepEqual(r.ownConversationRoutines(bot,[task],threads,[bot,other],{[task.id]:{bot:'lab'}}).map(t=>t.id),[task.id],'the link resolves it');
 assert.deepEqual(r.ownConversationRoutines(other,[task],threads,[bot,other],{[task.id]:{bot:'lab'}}),[],'and only for the linked Bot');
 const chatTask={...task,id:'chat-task',threadId:bot.mainThreadId};
 assert.deepEqual(r.routineOwner(chatTask,[bot,other],{['chat-task']:{bot:'other'}}),{kind:'bot',bot},'the chat is proof, not the link');
});
test('a new run never borrows the previous conversation while history catches up',async()=>{
 const task={...original,id:'routine-lag',threadId:null,threadMode:'new_thread',runCount:2,lastRunAt:'2026-11-20T03:30:00Z',lastRunStatus:'succeeded'};
 globalThis.fetch=async()=>new Response(JSON.stringify({rows:[{id:'execution:old:run-old',taskId:task.id,at:'2026-11-19T03:30:00Z',status:'completed',trigger:'scheduled',threadId:'old-thread',runId:'run-old',source:'execution'}],observingSince:'2026-11-01T00:00:00Z',incomplete:true,observing:true}),{status:200,headers:{'content-type':'application/json'}});
 transport=async(tag)=>tag==='orchestration.getThreadProjection'?{messages:[{id:'old-message',runId:'run-old',scheduledTaskId:task.id}],runs:[{id:'run-old',status:'completed',completedAt:'2026-11-19T03:30:20Z'}],turnItems:[{type:'assistant_message',runId:'run-old',text:'Old report.'}]}:{};
 const first=await r.readRoutineReports(bot,[task],{'old-thread':own('old-thread',{latestRunId:'run-old'})});
 assert.deepEqual(first.map((item)=>[item.threadId,item.summary]),[[null,'A run was dispatched, but its conversation could not be found.']],'the old run must not be linked to the new dispatch');
 // History catches up with the new execution: the next read must use it, not the old row or a cached null.
 globalThis.fetch=async()=>new Response(JSON.stringify({rows:[{id:'execution:new:run-new',taskId:task.id,at:'2026-11-20T03:30:01Z',status:'completed',trigger:'scheduled',threadId:'new-thread',runId:'run-new',source:'execution'}],observingSince:'2026-11-01T00:00:00Z',incomplete:true,observing:true}),{status:200,headers:{'content-type':'application/json'}});
 transport=async(tag)=>tag==='orchestration.getThreadProjection'?{messages:[{id:'new-message',runId:'run-new',scheduledTaskId:task.id}],runs:[{id:'run-new',status:'completed',completedAt:'2026-11-20T03:30:20Z'}],turnItems:[{type:'assistant_message',runId:'run-new',text:'New report.'}]}:{};
 const second=await r.readRoutineReports(bot,[task],{'new-thread':own('new-thread',{latestRunId:'run-new'})});
 assert.deepEqual(second.map((item)=>[item.threadId,item.summary]),[['new-thread','New report.']],'a late history row updates the line');
 globalThis.fetch=async()=>new Response('{}',{status:404});
});
test('a missing history row is retried instead of cached as a permanent null',async()=>{
 const task={...original,id:'routine-retry-null',threadId:null,threadMode:'new_thread',runCount:1,lastRunAt:'2026-11-20T03:30:00Z',lastRunStatus:'succeeded'};
 globalThis.fetch=async()=>new Response(JSON.stringify({rows:[],observingSince:'2026-11-01T00:00:00Z',incomplete:true,observing:true}),{status:200,headers:{'content-type':'application/json'}});
 const first=await r.readRoutineReports(bot,[task],{});
 assert.deepEqual(first.map((item)=>[item.threadId,item.state]),[[null,'unavailable']]);
 globalThis.fetch=async()=>new Response(JSON.stringify({rows:[{id:'execution:new:run-new',taskId:task.id,at:'2026-11-20T03:30:01Z',status:'completed',trigger:'scheduled',threadId:'new-thread',runId:'run-new',source:'execution'}],observingSince:'2026-11-01T00:00:00Z',incomplete:true,observing:true}),{status:200,headers:{'content-type':'application/json'}});
 transport=async(tag)=>tag==='orchestration.getThreadProjection'?{messages:[{id:'new-message',runId:'run-new',scheduledTaskId:task.id}],runs:[{id:'run-new',status:'completed',completedAt:'2026-11-20T03:30:20Z'}],turnItems:[{type:'assistant_message',runId:'run-new',text:'New report.'}]}:{};
 const second=await r.readRoutineReports(bot,[task],{'new-thread':own('new-thread',{latestRunId:'run-new'})});
 assert.deepEqual(second.map((item)=>[item.threadId,item.summary]),[['new-thread','New report.']],'the null must not be permanent');
 globalThis.fetch=async()=>new Response('{}',{status:404});
});
test('a new-thread routine resolves its conversation through the gateway\u2019s bounded history',async()=>{
 const task={...original,id:'routine-new',threadId:null,threadMode:'new_thread',runCount:1,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 const thread=own('new-run',{latestRunId:'run-new'});
 globalThis.fetch=async(url)=>{ if(String(url).startsWith('/api/routine-history')) return new Response(JSON.stringify({rows:[{id:'execution:new-run:run-new',taskId:task.id,at:'2026-11-19T03:30:00Z',status:'completed',trigger:'scheduled',threadId:'new-run',runId:'run-new',source:'execution'}],observingSince:'2026-11-01T00:00:00Z',incomplete:true,observing:true}),{status:200,headers:{'content-type':'application/json'}}); return new Response('{}',{status:404}); };
 transport=async(tag)=>tag==='orchestration.getThreadProjection'?{messages:[{id:'message-new',runId:'run-new',scheduledTaskId:task.id}],runs:[{id:'run-new',status:'completed',completedAt:'2026-11-19T03:30:20Z'}],turnItems:[{type:'assistant_message',runId:'run-new',text:'Fresh report.'}]}:{};
 const reports=await r.readRoutineReports(bot,[task],{'new-run':thread});
 assert.deepEqual(reports.map((item)=>[item.threadId,item.summary,item.state]),[['new-run','Fresh report.','finished']]);
 globalThis.fetch=async()=>new Response('{}',{status:404});
 const missing=await r.readRoutineReports(bot,[{...task,id:'routine-new-missing'}],{'new-run':thread});
 assert.deepEqual(missing.map((item)=>[item.threadId,item.state]),[[null,'unavailable']],'a run with no findable conversation still leaves an honest line');
});
test('the routine detail saves each notification choice, keeps it on failure and explains a muted Bot',async()=>{
 const own2={instanceId:'pi',model:'cheap',options:[]};
 const task={...original,threadId:'own-thread',threadMode:'continue',modelSelection:own2,runCount:1,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 useApp.setState({threads:{'own-thread':{id:'own-thread',modelSelection:own2,latestRunId:'run-1'}},routineAlerts:{}});
 const puts=[];
 globalThis.fetch=async(url,init)=>{ if(String(url).startsWith('/api/routine-alerts/')&&init?.method==='PUT'){ const body=JSON.parse(String(init.body)); puts.push([String(url),body]); if(body.alerts?.failed===true) return new Response(JSON.stringify({error:'Couldn’t save'}),{status:500,headers:{'content-type':'application/json'}}); return new Response(JSON.stringify({task:{...body,alerts:{...(body.alerts??{})}}}),{status:200,headers:{'content-type':'application/json'}}); } if(String(url).startsWith('/api/routine-history')) return new Response(JSON.stringify({rows:[],observingSince:'2026-11-01T00:00:00Z',incomplete:true,observing:true}),{status:200,headers:{'content-type':'application/json'}}); return new Response('{}',{status:404}); };
 await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));
 assert.match(host.textContent,/Its runs happen in their own conversation/);
 await click(document.querySelector('[aria-label="Routine notifications: Finished"]'));
 assert.deepEqual(puts.at(-1)[1],{alerts:{finished:true}});
 assert.equal(useApp.getState().routineAlerts[task.id].alerts.finished,true);
 await click(document.querySelector('[aria-label="Routine notifications: Failed"]'));
 assert.match(host.textContent,/Couldn’t save/);
 assert.equal(useApp.getState().routineAlerts[task.id].alerts.failed,undefined,'a failed save keeps the old choice');
 await render(h(RoutineDetail,{bot:{...bot,notifications:false},task,onBack(){},onEdit(){}}));
 assert.match(host.textContent,/Notifications are off for this Bot/);
 assert.equal((document.querySelector('[aria-label="Routine notifications: Finished"]') as HTMLButtonElement | null)?.disabled,true);
 globalThis.fetch=async()=>new Response('{}',{status:404});
});
test('a new run during a run-ref fetch starts a new read instead of reusing the old one',async()=>{
 let calls=0;const pending=[];
 globalThis.fetch=async(url)=>{ if(String(url).startsWith('/api/routine-history/latest')){ calls+=1; return new Promise<Response>((resolve)=>{ pending.push(resolve); }); } return new Response('{}',{status:404}); };
 const task={...original,id:'task-gen',lastRunAt:'2026-11-19T03:30:00Z'};
 useApp.setState({tasks:[task],routineRuns:{}});
 const first=r.refreshRoutineRuns(['task-gen']);
 useApp.setState({tasks:[{...task,lastRunAt:'2026-11-20T03:30:00Z'}]});
 const second=r.refreshRoutineRuns(['task-gen']);
 await new Promise((resolve)=>setTimeout(resolve,5));
 assert.equal(calls,2,'a newer run must not join the older in-flight read');
 pending[0](new Response(JSON.stringify({tasks:{'task-gen':{threadId:'old',runId:'old',at:'2026-11-19T03:30:01Z',status:'completed'}}}),{status:200,headers:{'content-type':'application/json'}}));
 pending[1](new Response(JSON.stringify({tasks:{'task-gen':{threadId:'new',runId:'new',at:'2026-11-20T03:30:01Z',status:'completed'}}}),{status:200,headers:{'content-type':'application/json'}}));
 await Promise.all([first,second]);
 assert.equal(useApp.getState().routineRuns['task-gen'].threadId,'new');
 globalThis.fetch=async()=>new Response('{}',{status:404});
});
test('a successful read that still lags the new dispatch does not present the old run as current',async()=>{
 const task={...original,id:'task-lag-ref',threadId:null,threadMode:'new_thread',runCount:2,lastRunAt:'2026-11-20T03:30:00Z',lastRunStatus:'succeeded'};
 useApp.setState({tasks:[task],routineRuns:{'task-lag-ref':{threadId:'old-run',runId:'old-run-run',at:'2026-11-19T03:30:00Z',status:'waiting'}},routineRunsStale:{},threads:{'old-run':own('old-run',{status:'waiting',pendingRuntimeRequest:{id:'request',kind:'approval',blocking:true}})}} as any);
 globalThis.fetch=async()=>new Response(JSON.stringify({tasks:{'task-lag-ref':{threadId:'old-run',runId:'old-run-run',at:'2026-11-19T03:30:00Z',status:'waiting'}}}),{status:200,headers:{'content-type':'application/json'}});
 await r.refreshRoutineRuns(['task-lag-ref']);
 assert.equal((useApp.getState() as any).routineRunsStale['task-lag-ref'],true,'a lagging row is not the new dispatch');
 await render(h(RoutineRow,{task,onOpen(){}}));
 assert.doesNotMatch(host.textContent,/Needs attention/);
 globalThis.fetch=async()=>new Response('{}',{status:404});
});
test('a failed run-ref read marks the state stale so the list does not show old attention',async()=>{
 const task={...original,id:'task-stale',threadId:null,threadMode:'new_thread',runCount:1,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 useApp.setState({tasks:[task],routineRuns:{'task-stale':{threadId:'new-run',runId:'new-run-run',at:'2026-11-19T03:30:00Z',status:'waiting'}},routineRunsStale:{},threads:{'new-run':own('new-run',{status:'waiting',pendingRuntimeRequest:{id:'request',kind:'approval',blocking:true}})}} as any);
 globalThis.fetch=async()=>new Response('{}',{status:500});
 await r.refreshRoutineRuns(['task-stale']);
 assert.equal((useApp.getState() as any).routineRunsStale['task-stale'],true,'a failure must be visible, not silently stale');
 await render(h(RoutineRow,{task,onOpen(){}}));
 assert.doesNotMatch(host.textContent,/Needs attention/,'an unreadable refresh must not keep showing old attention');
 assert.match(host.textContent,/Run state unavailable/,'the stale state is disclosed');
 globalThis.fetch=async()=>new Response('{}',{status:404});
});
test('persisted run refs load once per batch and never replace a newer run',async()=>{
 let calls=0;
 globalThis.fetch=async(url)=>{ if(String(url).startsWith('/api/routine-history/latest')){ calls+=1; await new Promise((resolve)=>setTimeout(resolve,20)); return new Response(JSON.stringify({tasks:{'task-1':{threadId:'thread-1',runId:'run-1',at:'2026-11-19T03:30:00Z',status:'completed'}}}),{status:200,headers:{'content-type':'application/json'}}); } return new Response('{}',{status:404}); };
 await Promise.all([r.refreshRoutineRuns(['task-1']),r.refreshRoutineRuns(['task-1'])]);
 assert.equal(calls,1,'two renders must share one read');
 assert.deepEqual(useApp.getState().routineRuns['task-1'],{threadId:'thread-1',runId:'run-1',at:'2026-11-19T03:30:00Z',status:'completed'});
 // A slow older response must not overwrite a newer run already in the store.
 useApp.setState({routineRuns:{'task-1':{threadId:'thread-2',runId:'run-2',at:'2026-11-19T04:00:00Z',status:'running'}}});
 globalThis.fetch=async()=>new Response(JSON.stringify({tasks:{'task-1':{threadId:'thread-1',runId:'run-1',at:'2026-11-19T03:30:00Z',status:'completed'}}}),{status:200,headers:{'content-type':'application/json'}});
 await r.refreshRoutineRuns(['task-1']);
 assert.equal(useApp.getState().routineRuns['task-1'].runId,'run-2');
 globalThis.fetch=async()=>new Response('{}',{status:404});
});
test('a routine moved to another thread keeps the waiting run of the thread that produced it',async()=>{
 const task={...original,id:'routine-moved',threadId:'thread-B',threadMode:'continue',runCount:1,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 useApp.setState({tasks:[task],routineRuns:{[task.id]:{threadId:'thread-A',runId:'run-A',at:'2026-11-19T03:30:00Z',status:'waiting'}},threads:{'thread-A':own('thread-A',{status:'waiting',latestRunId:'run-A',pendingRuntimeRequest:{id:'request',kind:'approval',blocking:true}}),'thread-B':own('thread-B',{status:'idle',latestRunId:null})}} as any);
 await render(h(RoutineRow,{task,onOpen(){}}));
 assert.match(host.textContent,/Needs attention/,'the verified run thread must win over the moved task thread');
});
test('a new-thread routine with a waiting run shows Needs attention in the routines list',async()=>{
 const task={...original,id:'routine-new-attention',threadId:null,threadMode:'new_thread',runCount:1,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 useApp.setState({tasks:[task],routineRuns:{[task.id]:{threadId:'new-run',runId:'new-run-run',at:'2026-11-19T03:30:00Z',status:'waiting'}},threads:{'new-run':own('new-run',{status:'waiting',pendingRuntimeRequest:{id:'request',kind:'approval',blocking:true}})}} as any);
 await render(h(RoutineRow,{task,onOpen(){}}));
 assert.match(host.textContent,/Needs attention/,'the list cannot show a new-thread wait today');
});
test('a manual wait in a routine conversation never paints the list as routine attention',async()=>{
 const task={...original,id:'routine-manual-list',threadId:null,threadMode:'new_thread',runCount:1,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 useApp.setState({tasks:[task],routineRuns:{[task.id]:{threadId:'new-run',runId:'routine-run',at:'2026-11-19T03:30:00Z',status:'completed'}},threads:{'new-run':own('new-run',{status:'waiting',latestRunId:'manual-run',pendingRuntimeRequest:{id:'request',kind:'approval',blocking:true}})}} as any);
 await render(h(RoutineRow,{task,onOpen(){}}));
 assert.doesNotMatch(host.textContent,/Needs attention/);
 const bound={...original,id:'routine-manual-own',threadId:'own-thread',threadMode:'continue',runCount:1,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 useApp.setState({tasks:[bound],routineRuns:{[bound.id]:{threadId:'own-thread',runId:'routine-run',at:'2026-11-19T03:30:00Z',status:'completed'}},threads:{'own-thread':own('own-thread',{status:'waiting',latestRunId:'manual-run',pendingRuntimeRequest:{id:'request',kind:'approval',blocking:true}})}} as any);
 await render(h(RoutineRow,{task:bound,onOpen(){}}));
 assert.doesNotMatch(host.textContent,/Needs attention/,'a manual turn in an own routine thread is not routine attention');
});
test('a main-chat routine exposes its own choices with the compatible chat defaults',async()=>{
 const task={...original,threadId:'thread',threadMode:'continue',runCount:1,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 useApp.setState({threads:{thread:{id:'thread',modelSelection:model,latestRunId:'run-1'}},routineAlerts:{}});
 globalThis.fetch=async(url)=>{ if(String(url).startsWith('/api/routine-history')) return new Response(JSON.stringify({rows:[],observingSince:'2026-11-01T00:00:00Z',incomplete:true,observing:true}),{status:200,headers:{'content-type':'application/json'}}); return new Response('{}',{status:404}); };
 await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));
 assert.match(host.textContent,/follow the Bot’s Notifications switch/);
 const checked=(label)=>document.querySelector(`[aria-label="Routine notifications: ${label}"]`).getAttribute('aria-checked');
 assert.equal(checked('Finished'),'true');
 assert.equal(checked('Failed'),'false');
 assert.equal(checked('Needs attention'),'true');
 globalThis.fetch=async()=>new Response('{}',{status:404});
});
test('an ambiguous routine in a shared project can be linked explicitly from its detail',async()=>{
 const other={...bot,slug:'other',name:'Other',mainThreadId:'other-thread'};
 const task={...original,id:'routine-shared',threadId:'shared-thread',threadMode:'continue',runCount:1,lastRunAt:'2026-11-19T03:30:00Z',lastRunStatus:'succeeded'};
 useApp.setState({bots:{lab:bot,other},routineAlerts:{},threads:{'shared-thread':own('shared-thread')}});
 const puts=[];
 globalThis.fetch=async(url,init)=>{ if(String(url).startsWith('/api/routine-alerts/')&&init?.method==='PUT'){ const body=JSON.parse(String(init.body)); puts.push([String(url),body]); return new Response(JSON.stringify({task:{...body}}),{status:200,headers:{'content-type':'application/json'}}); } if(String(url).startsWith('/api/routine-history')) return new Response(JSON.stringify({rows:[],observingSince:'2026-11-01T00:00:00Z',incomplete:true,observing:true}),{status:200,headers:{'content-type':'application/json'}}); return new Response('{}',{status:404}); };
 await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));
 assert.match(host.textContent,/Bot association unavailable/);
 await click(button('Link it to Lab'));
 assert.deepEqual(puts.at(-1)[1],{bot:'lab'});
 assert.equal(useApp.getState().routineAlerts[task.id].bot,'lab');
 useApp.setState({bots:{lab:bot}});
 globalThis.fetch=async()=>new Response('{}',{status:404});
});

test('a failed move archives the conversation it started and leaves the routine in the chat',async()=>{
 const chatModel={instanceId:'pi',model:'chat-model',options:[]};const next={instanceId:'pi',model:'next',options:[]};
 const task={...original,threadId:'thread',threadMode:'continue',modelSelection:chatModel};
 useApp.setState({bots:{lab:{...bot,model:chatModel}},threads:{thread:{id:'thread',modelSelection:chatModel}},tasks:[structuredClone(task)]});
 transport=async(tag)=>{if(tag==='orchestration.launchThread')return{threadId:'routine-thread'};throw new Error('Nope');};
 await assert.rejects(r.setRoutineModel(task,bot,next),/Nope/);
 assert.deepEqual(calls.find(c=>c.tag==='dispatch').payload,{type:'thread.archive',threadId:'routine-thread'});
 assert.equal(useApp.getState().tasks.find(t=>t.id===task.id).threadId,'thread');
});
test('a routine cannot be moved while a run is in progress',async()=>{
 const chatModel={instanceId:'pi',model:'chat-model',options:[]};
 useApp.setState({bots:{lab:{...bot,model:chatModel}},threads:{thread:{id:'thread',modelSelection:chatModel}}});
 const task={...original,threadId:'thread',threadMode:'continue',modelSelection:chatModel,lastRunStatus:'running'};
 await render(h(RoutineDetail,{bot,task,onBack(){},onEdit(){}}));
 assert.equal(button('Use its own model…').disabled,true);
 assert.match(host.textContent,/A run is in progress/);
});
