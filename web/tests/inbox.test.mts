import assert from 'node:assert/strict';
import { test, after, beforeEach, afterEach } from 'node:test';
import { MessageChannel } from 'node:worker_threads';
import { Window } from 'happy-dom';
import { buildOnce, domWindow, entryChunk } from './support.mts';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const channels = [];
globalThis.MessageChannel = class extends MessageChannel { constructor() { super(); channels.push(this); } };
const window = domWindow(new Window({ url: 'http://inbox.test', width: 412, height: 915, settings: { device: { prefersReducedMotion: 'reduce' } } }));
for (const key of ['window','document','navigator','HTMLElement','Element','Node','Event','MouseEvent','PointerEvent','localStorage','location','requestAnimationFrame','cancelAnimationFrame','MutationObserver','IntersectionObserver','ResizeObserver','getComputedStyle']) Object.defineProperty(globalThis, key, { configurable: true, value: typeof window[key] === 'function' && key === 'getComputedStyle' ? window[key].bind(window) : window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.HTMLElement.prototype.getClientRects = () => [{ width: 32, height: 32 }] as unknown as DOMRectList;
const src = new URL('../src/', import.meta.url).pathname;
const bundle = await buildOnce({ configFile:false, logLevel:'silent', define:{'process.env.NODE_ENV':'"development"'}, plugins:[{name:'inbox', resolveId:id=>id.endsWith('virtual:inbox')?'\0inbox':undefined,load:id=>id==='\0inbox'?`export { createElement, act } from 'react'; export { createRoot } from 'react-dom/client'; export { Sidebar } from ${JSON.stringify(src+'components/Sidebar.tsx')}; export { SearchDialog } from ${JSON.stringify(src+'components/SearchDialog.tsx')}; export * from ${JSON.stringify(src+'store.ts')}; export { t3 } from ${JSON.stringify(src+'lib/t3.ts')}; export { api } from ${JSON.stringify(src+'lib/api.ts')};`:undefined}],ssr:{noExternal:true},build:{ssr:'virtual:inbox',write:false}});
const entry=entryChunk(bundle);
const directory=await mkdtemp(path.join(tmpdir(),'bot-inbox-test-')); await writeFile(path.join(directory,'entry.mjs'),entry.code);
const {createElement:h,act,createRoot,Sidebar,SearchDialog,useApp,t3,api,setThreadDone,snoozeThread,archiveThread,botStatus,resolvedSnoozes,completionNotification,loadThreadMeta,navigateSearchHit,loadArchivedThreads}=await import(pathToFileURL(path.join(directory, 'entry.mjs')).href);
const bot={slug:'sample',name:'Sample',projectId:'project',mainThreadId:'main',shape:'blob',color:'blue',createdAt:'2026-01-01',workspaceRoot:'/fixture',notifications:true};
const original={id:'main',projectId:'project',title:'Conversation',status:'completed',activityRunStatus:null,pendingRuntimeRequest:null,settledOverride:null,settledAt:null,archivedAt:null,snoozedUntil:null,lastVisitedAt:'2026-01-01',latestRunCompletedAt:'2026-01-01',latestRunStartedAt:'2026-01-01',latestRunId:'run',lineage:{parentThreadId:null,rootThreadId:'main'},updatedAt:'2026-01-01'};
let root,host,thread,commands;
beforeEach(()=>{
 thread={...original};commands=[];
 useApp.setState({searchSession:{query:"",filter:"All",index:0,scrollTop:0},bots:{sample:bot},threads:{main:thread},historicalBots:{},archivedThreads:{},previews:{},selected:null,settings:{sections:[]},sidebarCompact:false,snoozePresets:[{kind:'after',minutes:60}],toast:null,tasks:[]});
 t3.dispatch=async command=>{commands.push(command);if(command.type==='thread.settle'){thread={...thread,settledOverride:'settled',settledAt:'2026-01-02'};}if(command.type==='thread.unsettle')thread={...thread,settledOverride:'active',settledAt:null};if(command.type==='thread.snooze')thread={...thread,snoozedUntil:command.snoozedUntil};if(command.type==='thread.unsnooze')thread={...thread,snoozedUntil:null};if(command.type==='thread.archive')thread={...thread,archivedAt:'2026-01-02'};if(command.type==='thread.unarchive')thread={...thread,archivedAt:null};return{sequence:1};};
 t3.call=async tag=>tag==='orchestration.getThreadProjection'?{thread}:tag==='orchestration.getArchivedShellSnapshot'?{projects:[],threads:thread.archivedAt?[thread]:[]}:tag==='orchestration.searchThreads'?{matches:[]}:{entries:[],truncated:false};
 globalThis.fetch=async()=>Response.json({configured:false});
 host=document.createElement('main');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
after(async()=>{for(const c of channels){c.port1.close();c.port2.close();}await window.happyDOM.close();await rm(directory,{recursive:true,force:true});});
const click=async(label)=>{const element=[...document.querySelectorAll<HTMLElement>('[role=menuitem]'),...document.querySelectorAll('button')].find(e=>e.textContent.trim()===label||e.getAttribute('aria-label')===label);assert.ok(element,`missing ${label}`);await act(async()=>element.click());};

test('Mark as finished and Reopen use the confirmed lifecycle; archived Bots stay reachable',async()=>{
 await act(async()=>root.render(h(Sidebar,{wide:true})));
 await click('Options for Sample');await click('Mark as finished');
 assert.equal(commands[0].type,'thread.settle');assert.equal(botStatus(bot),'done');
 await click('Options for Sample');await click('Reopen');assert.equal(commands[1].reason,'user');assert.equal(botStatus(bot),'idle');
 await click('Options for Sample');await click('Archive');
 assert.equal(useApp.getState().bots.sample.hidden,undefined);assert.ok(document.querySelector('[aria-label="Chat with Sample"]'));
 assert.equal(useApp.getState().threads.main.archivedAt,'2026-01-02');
 await click('Options for Sample');await click('Unarchive conversation');assert.equal(useApp.getState().threads.main.archivedAt,null);
});

test('touch long press opens lifecycle menu and does not select the Bot',async()=>{
 await act(async()=>root.render(h(Sidebar,{wide:true})));
 const row=document.querySelector<HTMLElement>('[aria-label="Chat with Sample"]');
 await act(async()=>{row.dispatchEvent(new window.PointerEvent('pointerdown',{bubbles:true,pointerType:'touch',button:0,clientX:40,clientY:100}));await new Promise(r=>setTimeout(r,550));row.dispatchEvent(new window.PointerEvent('pointerup',{bubbles:true,pointerType:'touch'}));row.click();});
 assert.ok(document.body.textContent.includes('Archive'));assert.equal(useApp.getState().selected,null);assert.deepEqual(commands,[]);
});

test('failed lifecycle writes do not optimistically mark work done; snooze data survives a fresh store read without changing roster status',async()=>{
 const dispatch=t3.dispatch;t3.dispatch=async()=>{throw new Error('Permission denied')};
 await assert.rejects(setThreadDone('main',true),/Permission denied/);assert.equal(botStatus(bot),'idle');t3.dispatch=dispatch;
 const until=new Date(Date.now()+3600000).toISOString();await snoozeThread('main',until);assert.equal(botStatus(bot),'idle');
 useApp.setState({threads:{main:JSON.parse(JSON.stringify(thread))}});assert.equal(botStatus(bot),'idle');
 await snoozeThread('main',null);assert.equal(botStatus(bot),'idle');
 await assert.rejects(snoozeThread('main','2020-01-01T00:00:00Z'),/future/);
});

test('snooze presets skip elapsed choices and preserve next weekday semantics',()=>{
 const now=new Date(2026,9,26,19,0);
 const choices=resolvedSnoozes([{kind:'at',day:'today',time:'18:00'},{kind:'at',day:'tomorrow',time:'09:00'},{kind:'at',day:'monday',time:'09:00'}],now);
 assert.equal(choices.length,2);assert.equal(new Date(choices[0].snoozedUntil).getDate(),27);assert.equal(new Date(choices[1].snoozedUntil).getDate(),2);
});

test('completion notifications never repeat a user prompt or stale prior-run reply',async()=>{
 const notifications=[];globalThis.Notification=class {static permission='granted';constructor(title,options){notifications.push(options.body)}} as unknown as typeof Notification;
 api.threadPreviews=async()=>({main:{role:'user',text:'Private prompt',at:'2026-01-02'}});
 await completionNotification(bot,thread);assert.deepEqual(notifications,['Finished']);
 api.threadPreviews=async()=>({main:{role:'assistant',text:'Older answer',at:'2025-12-01'}});
 await completionNotification(bot,thread);assert.equal(notifications.at(-1),'Finished');
 api.threadPreviews=async()=>({main:{role:'assistant',text:'Current answer',at:'2026-01-02'}});
 await completionNotification(bot,thread);assert.equal(notifications.at(-1),'Current answer');
});

test('old gateways also hide short voice calls without changing the data source',async()=>{
 const meta={reactions:{},voiceCalls:[{at:'failed',seconds:9},{at:'recorded',seconds:10}]};api.threadMeta=async()=>meta;
 await loadThreadMeta('main');assert.deepEqual(useApp.getState().threadMeta.main.voiceCalls,[meta.voiceCalls[1]]);assert.equal(meta.voiceCalls.length,2);
});

test('global file search reads the backend index and opens the exact signed result',async()=>{
 let searches=0;
 t3.call=async(tag,payload)=>{
  if(tag==='projects.searchEntries'){searches++;assert.equal(payload.cwd,'/fixture');return{entries:[{path:'reports/sample.txt',kind:'file'}],truncated:false};}
  if(tag==='orchestration.searchThreads')return{matches:[]};
  if(tag==='assets.createUrl'){assert.equal(payload.resource.threadId,'main');assert.equal(payload.resource.path,'reports/sample.txt');return{relativeUrl:'/signed/sample'};}
  throw new Error('Unexpected search request');
 };
 globalThis.fetch=async url=>url==='/t3/signed/sample'?new Response('Exact sample file contents'):Response.json({configured:false});
 await act(async()=>root.render(h(SearchDialog)));
 const input=document.querySelector('input');
 await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(input,'sample');input.dispatchEvent(new window.Event('input',{bubbles:true}));});
 await click('Files');await act(async()=>new Promise(r=>setTimeout(r,250)));
 assert.equal(searches,1);const result=document.querySelector<HTMLElement>('[role="option"]');assert.ok(result.textContent.includes('reports/sample.txt'));
 await act(async()=>result.click());assert.ok(document.body.textContent.includes('Exact sample file contents'));
});

test('global message navigation preserves the hit id and reveals its older entry',async()=>{
 t3.call=async tag=>tag==='orchestration.getThreadFamily'?{threads:[]}:{turnItems:[{id:'first',messageId:'other'},{id:'exact-entry',messageId:'hit-message'}]};
 const messages=document.createElement('div');messages.className='chat-messages';host.append(messages);
 const earlier=document.createElement('button');earlier.textContent='Load earlier messages';messages.append(earlier);
 let scrolled=false,animated=false;
 earlier.onclick=()=>{const entry=document.createElement('div');entry.dataset.chatEntry='exact-entry';const content=document.createElement('p');content.textContent='Matching message';content.className="bubble";content.animate=()=>{animated=true;return{} as Animation};content.scrollIntoView=()=>{scrolled=true;};entry.append(content);entry.animate=()=>({} as Animation);earlier.replaceWith(entry);};
 await navigateSearchHit(bot,{threadId:'main',messageId:'hit-message',query:'matching'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(scrolled,true);assert.equal(animated,true);assert.equal(useApp.getState().selected,'sample');assert.equal(useApp.getState().selectedThreadId,null);
 assert.equal(commands[0].type,'thread.visit');
});

test('refreshing local archives preserves environment-scoped archived conversations',async()=>{
 const key='environment:remote:same-id';const archived={...original,id:key,archivedAt:'2026-01-02',environmentId:'remote'};
 useApp.setState({threads:{main:thread,[key]:archived},archivedThreads:{[key]:archived}});
 t3.call=async()=>({threads:[],projects:[]});await loadArchivedThreads();
 assert.equal(useApp.getState().threads[key].id,key);assert.equal(useApp.getState().archivedThreads[key].id,key);
});

for (const wide of [false, true]) test(`archived and snoozed main Bots stay in the normal ${wide ? 'mobile' : 'desktop'} roster`, async () => {
 const until = new Date(Date.now() + 3600000).toISOString();
 useApp.setState({threads:{main:{...original,archivedAt:'2026-01-02',snoozedUntil:until}}});
 await act(async()=>root.render(h(Sidebar,{wide})));
 assert.ok(host.querySelector('[aria-label="Chat with Sample"]'));
 assert.doesNotMatch(host.textContent,/Snoozed|Load older done conversations/);
 assert.equal(host.querySelectorAll('[aria-label="Conversation filters"]').length,0);
 await click('Options for Sample');
 assert.doesNotMatch(document.body.textContent,/Snooze|auto-settle|Choose date/);
 assert.equal(useApp.getState().threads.main.snoozedUntil,until);
 assert.deepEqual(commands,[]);
});

test('existing search reaches historical Bot identities after removing the Archived view',async()=>{
 const historical={...bot,slug:'retired',name:'Retired fixture Bot',mainThreadId:'old-main'};
 useApp.setState({historicalBots:{'archived:old-main':historical}});
 await act(async()=>root.render(h(SearchDialog)));
 await click('Bots');
 const result=[...document.querySelectorAll<HTMLElement>('[role="option"]')].find(el=>el.textContent.includes('Retired fixture Bot'));
 assert.ok(result);
 await act(async()=>result.click());
 assert.equal(useApp.getState().selected,'archived:old-main');
 assert.equal(useApp.getState().historicalBots['archived:old-main'].mainThreadId,'old-main');
});

test('Search remount restores query, filter and result position',async()=>{
 useApp.setState({searchSession:{query:'Sample',filter:'Bots',index:0,scrollTop:120}});
 await act(async()=>root.render(h(SearchDialog)));
 assert.equal(document.querySelector<HTMLInputElement>('.search-dialog input').value,'Sample');
 assert.equal(document.querySelector('.search-filters [aria-pressed=true]').textContent,'Bots');
 assert.equal(document.querySelector('.search-results').scrollTop,120);
 const result=document.querySelector<HTMLElement>('[role=option]');
 await act(async()=>result.click());
 assert.equal(useApp.getState().dialog,null);
 assert.equal(useApp.getState().selected,'sample');
 assert.deepEqual(useApp.getState().searchSession,{query:'Sample',filter:'Bots',index:0,scrollTop:120});
});


test('pinned mobile menu starts with read state and retains lifecycle actions in More', async () => {
 const primary={...bot,primary:true};
 thread={...thread,lastVisitedAt:'2025-01-01',latestRunCompletedAt:'2026-01-01'};
 useApp.setState({bots:{sample:primary},threads:{main:thread}});
 const dispatch=t3.dispatch;
 t3.dispatch=async command=>{if(command.type==='thread.visit')thread={...thread,lastVisitedAt:command.visitedAt};return dispatch(command);};
 await act(async()=>root.render(h(Sidebar,{wide:true})));
 const target=document.querySelector('.pinned-bot');
 await act(async()=>target.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,clientX:20,clientY:100})));
 const labels=()=>[...document.querySelectorAll('[role=menuitem]')].map(e=>e.textContent.trim());
 assert.deepEqual(labels(),['Mark Read','Replace Primary Bot…','Hide','More']);
 await click('Mark Read');
 assert.equal(commands.at(-1).type,'thread.visit');
 assert.equal(useApp.getState().selected,null,'Mark as Read does not open the conversation');
 assert.equal(botStatus(primary),'idle');
 await act(async()=>target.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,clientX:20,clientY:100})));
 assert.equal(labels()[0],'Mark as Unread');
 await click('More');
 assert.ok(labels().includes('Mark as finished')); assert.ok(labels().includes('Archive')); assert.ok(labels().includes('Rename Bot'));
});

test('a Bot whose T3 project is archived in T3 Code moves to Hidden Bots, and Unhide unarchives it',async()=>{
 const calls=[];t3.call=async(tag,payload)=>{calls.push({tag,payload});return {sequence:1};};
 useApp.setState({projects:{project:{id:'project',title:'Sample',workspaceRoot:'/fixture',defaultModelSelection:null,archivedAt:'2026-11-01T00:00:00Z',createdAt:'2026-01-01',updatedAt:'2026-01-01'}}});
 await act(async()=>root.render(h(Sidebar,{wide:true})));
 assert.match(host.textContent,/Hidden Bots 1/);
 await click('Hidden Bots 1');assert.ok(document.querySelector('[aria-label="Chat with Sample"]'));
 await click('Options for Sample');await click('Unhide');
 const mutate=calls.find(c=>c.tag==='projects.mutate');assert.ok(mutate);assert.equal(mutate.payload.type,'project.update');assert.equal(mutate.payload.projectId,'project');assert.equal(mutate.payload.archived,false);
 assert.equal(useApp.getState().projects.project.archivedAt,null);assert.doesNotMatch(host.textContent,/Hidden Bots/);
 useApp.setState({projects:{}});
});
