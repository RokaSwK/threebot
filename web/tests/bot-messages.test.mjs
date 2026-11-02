import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'vite';
const modules = ['botMessages','transcript','remarkBotLinks','navigation'].map(name=>new URL(`../src/lib/${name}.ts`,import.meta.url).pathname);
const bundle=await build({configFile:false,logLevel:'silent',plugins:[{name:'messages-test',resolveId:id=>id.endsWith('virtual:messages-test')?'\0messages-test':undefined,load:id=>id==='\0messages-test'?modules.map(path=>`export * from ${JSON.stringify(path)};`).join('\n'):undefined}],build:{ssr:'virtual:messages-test',write:false},ssr:{noExternal:true}});
const entry=bundle.output.find(c=>c.type==='chunk'&&c.isEntry);assert.ok(entry);
const {shortToolName,botDelivery,botExchange,parseThreadLink,buildEntries,workingPhrases,remarkBotLinks,navigationFor,navigationUrl,readNavigation,restoreNavigation}=await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString('base64')}`);
const at='2026-10-30T01:00:00Z';
const bot={slug:'alpha',name:'Alpha',mainThreadId:'a',color:'teal',shape:'blob',workspaceRoot:'/alpha'};
const other={...bot,slug:'beta',name:'Beta',mainThreadId:'b'};
const third={...bot,slug:'gamma',name:'Gamma',mainThreadId:'c'};
const bots={alpha:bot,beta:other,gamma:third};
const ctx={bot,botsByThread:new Map(Object.values(bots).map(b=>[b.mainThreadId,b])),tasks:[],requests:{}};
function item(fields){return {id:'item',type:'dynamic_tool',threadId:'a',runId:'run',ordinal:1,startedAt:at,completedAt:at,updatedAt:at,title:null,status:'completed',...fields};}
function sent(fields={}){return item({toolName:'t3-code.t3_thread_send',input:{threadId:'b',message:'From Alpha: Hello Beta'},output:{threadId:'b',messageId:'message-1'},...fields});}

test('normalises the tool namespaces actually stored by T3',()=>{
 for(const name of ['t3-code.t3_thread_send','mcp__t3_code__t3_thread_send','mcp__t3-code__t3_thread_send','t3_thread_send'])assert.equal(shortToolName(name),'t3_thread_send');
});
test('send event requires a successful result for the exact recipient',()=>{
 assert.equal(botDelivery(sent()).recipientThreadId,'b');
 for(const output of [undefined,{isError:true},{_tag:'OrchestratorMcpFailure',message:'no'},{threadId:'wrong'},{error:'failed'}])assert.equal(botDelivery(sent({output})),null);
 assert.equal(botDelivery(sent({status:'running'})),null);
 assert.equal(botDelivery(sent({output:{content:[{type:'text',text:JSON.stringify({threadId:'b',messageId:'message-1'})}]}})).id,'message-1');
});
test('consecutive sends show a centred multi-recipient event without duplicates',()=>{
 const items=[sent(),sent({id:'item-2',ordinal:2,input:{threadId:'c',message:'Hi Gamma'},output:{threadId:'c',messageId:'message-2'}}),sent({id:'item-3',ordinal:3})];
 const events=buildEntries(items,ctx).filter(e=>e.kind==='bot-event');
 assert.equal(events.length,1);assert.equal(events[0].direction,'sent');assert.deepEqual(events[0].bots.map(b=>b.name),['Beta','Gamma']);
});
test('incoming Bot messages are exchange events, not user bubbles',()=>{
 const incoming=item({type:'user_message',id:'incoming',threadId:'a',senderThreadId:'b',messageId:'peer-1',text:'From Beta: Ready',createdBy:'agent'});
 const entries=buildEntries([incoming],ctx);
 assert.equal(entries.filter(e=>e.kind==='user'||e.kind==='peer').length,0);
 assert.equal(entries.find(e=>e.kind==='bot-event').bots[0].slug,'beta');
 assert.equal(botExchange([incoming],'a','b')[0].text,'Ready');
});
test('ordinary user text beginning From is never attributed to a Bot',()=>{
 const text='From Beta: this is text the user wrote';
 assert.equal(buildEntries([item({type:'user_message',text,createdBy:'user'})],ctx).find(e=>e.kind==='user').text,text);
});
test('an answered choice stays in its question card without a duplicate sent bubble',()=>{
 const question=item({id:'question',type:'user_input_request',requestId:'choice-request',ordinal:2,
  questions:[{id:'choice',question:'Which sample?',options:[{label:'First sample',value:'first-id'}]}],
  questionAnswer:{requestId:'choice-request',answers:{choice:'first-id'},attachmentsByQuestionId:{}}});
 const answer=item({id:'answer-message',type:'user_message',ordinal:1,messageId:'async-answer:choice-request',text:'First sample',createdBy:'user'});
 const typed=item({id:'typed-message',type:'user_message',ordinal:3,messageId:'typed',text:'First sample',createdBy:'user'});
 for(const records of [[answer,question,typed],[question,answer,typed]]){
  const entries=buildEntries(records,ctx);
  assert.equal(entries.filter(e=>e.kind==='question').length,1);
  assert.deepEqual(entries.filter(e=>e.kind==='user').map(e=>e.id),['typed-message']);
  assert.deepEqual(entries.find(e=>e.kind==='question').item.questionAnswer.answers,{choice:'first-id'});
 }
});
test('unmatched async answers and ordinary text are preserved',()=>{
 const orphan=item({id:'orphan',type:'user_message',messageId:'async-answer:missing-request',text:'Keep this answer',createdBy:'user'});
 const pending=item({id:'pending',type:'user_input_request',requestId:'missing-request',status:'waiting'});
 const unrelated=item({id:'other-question',type:'user_input_request',questionAnswer:{requestId:'other-request',answers:{choice:'Keep this answer'}}});
 assert.deepEqual(buildEntries([orphan,pending,unrelated],ctx).filter(e=>e.kind==='user').map(e=>e.text),['Keep this answer']);
});
test('Executor activity keeps its connected-app identity across runtime namespaces',()=>{
 for(const toolName of ['mcp__executor__execute','mcp__executor__search','executor.call','executor.describe']){
  assert.deepEqual(workingPhrases([item({toolName,status:'running'})],'run'),['Working in a connected app']);
 }
 assert.ok(workingPhrases([item({toolName:'web_search',status:'running'})],'run').includes('Searching the web'));
 assert.ok(workingPhrases([item({toolName:'preview_snapshot',status:'running'})],'run').includes('Working on your computer'));
});
test('exchange includes actual messages in both directions and excludes summaries and duplicates',()=>{
 const outgoing=sent();
 const received=item({id:'receive',threadId:'b',type:'user_message',senderThreadId:'a',messageId:'message-1',text:'From Alpha: Hello Beta'});
 const reply=item({id:'reply',threadId:'a',type:'user_message',senderThreadId:'b',messageId:'message-2',text:'From Beta: All good',updatedAt:'2026-10-30T01:01:00Z',startedAt:'2026-10-30T01:01:00Z'});
 const summary=item({id:'summary',type:'assistant_message',text:'I sent a message to Beta'});
 const unrelated=item({id:'other',type:'user_message',threadId:'a',senderThreadId:'c',text:'Hi from Gamma'});
 const entries=botExchange([outgoing,received,reply,summary,unrelated],'a','b');
 assert.deepEqual(entries.map(e=>e.text),['Hello Beta','All good']);
 assert.deepEqual(entries.map(e=>e.senderThreadId),['a','b']);
});
test('thread references preserve environment and colon-containing IDs',()=>{
 assert.deepEqual(parseThreadLink('t3-thread://v2/mac/mcp:launch:child'),{environmentId:'mac',threadId:'mcp:launch:child'});
 assert.deepEqual(parseThreadLink('t3-thread://v1/root'),{environmentId:null,threadId:'root'});
 assert.equal(parseThreadLink('https://example.com'),null);assert.equal(parseThreadLink('t3-thread://v2/mac/%broken'),null);
});
test('rich reference transformation preserves code, links, surrounding text and email addresses',()=>{
 const tree={type:'root',children:[{type:'paragraph',children:[{type:'text',value:'Sent to t3-thread://v2/nas/b. Ask @Beta and mail me@Beta.test'},{type:'inlineCode',value:'@Beta'},{type:'link',url:'https://example.com',children:[{type:'text',value:'@Beta'}]}]}]};
 remarkBotLinks({bots:[{slug:'beta',name:'Beta'}]})(tree);
 const nodes=tree.children[0].children;
 assert.deepEqual(nodes.filter(n=>n.type==='link').map(n=>n.url),['t3-thread://v2/nas/b','bot:beta','https://example.com']);
 assert.ok(nodes.some(n=>n.type==='text'&&n.value.includes('me@Beta.test')));
 assert.equal(nodes.find(n=>n.type==='inlineCode').value,'@Beta');
});
test('phone back/forward restores the exact child, exchange and overlay',()=>{
 const base={selected:'alpha',selectedThreadId:'child',exchangeBotSlug:null,detailsOpen:false,dialog:null};
 const chat=navigationFor(base,true);assert.equal(navigationUrl(chat,'/'), '/?bot=alpha&thread=child');
 const exchange=navigationFor({...base,exchangeBotSlug:'beta'},true);assert.equal(exchange.view,'exchange');
 assert.equal(restoreNavigation(readNavigation(exchange),bots).exchangeBotSlug,'beta');
 const settings=navigationFor({...base,dialog:'settings'},true);assert.equal(settings.view,'overlay');
 const restored=restoreNavigation(readNavigation(settings),bots);assert.equal(restored.dialog,'settings');assert.equal(restored.detailsOpen,false);assert.equal(restored.selectedThreadId,'child');
 assert.equal(readNavigation({view:'chat',slug:null,threadId:'child'}),null);
 assert.equal(readNavigation({view:'overlay',slug:'alpha',threadId:null,details:false,dialog:{kind:'evil'}}),null);
});

test('phone history restores main-Bot picker intent and rejects malformed candidates',()=>{
 const base={selected:'alpha',selectedThreadId:null,exchangeBotSlug:null,detailsOpen:false};
 for(const intent of [{kind:'replace'},{kind:'hide',slug:'alpha'},{kind:'delete',slug:'alpha'}]){
  const dialog={kind:'main-bot',intent,initialSlug:'beta'};
  const route=navigationFor({...base,dialog},true);
  const saved=readNavigation(JSON.parse(JSON.stringify(route)));
  assert.ok(saved);assert.deepEqual(restoreNavigation(saved,bots).dialog,dialog);
 }
 for(const dialog of [{kind:'main-bot'},{kind:'main-bot',intent:{kind:'hide'}},{kind:'main-bot',intent:{kind:'evil'}},{kind:'main-bot',intent:{kind:'replace'},initialSlug:12}]){
  assert.equal(readNavigation({view:'overlay',slug:'alpha',threadId:null,details:false,dialog}),null);
 }
});
