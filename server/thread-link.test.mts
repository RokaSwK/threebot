import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkedThreadUrl, createThreadLinkResolver } from './thread-link.mts';
const links=[{environmentId:'mac',urls:['https://mac.example.test'],status:'reachable'}];
test('remote child links use the exact linked machine and encode their real thread ID',()=>{
 assert.equal(linkedThreadUrl(links,{environmentId:'mac',threadId:'mcp:launch:child'}),'https://mac.example.test/mac/mcp%3Alaunch%3Achild');
 const delegated='thread:delegated-task:command%3Amcp%3Aparent%3Adelegate-task%3Achild';
 assert.equal(linkedThreadUrl(links,{environmentId:'mac',threadId:delegated}),`https://mac.example.test/mac/${encodeURIComponent(delegated)}`);
});
test('unlinked, expired, malformed and credential-bearing destinations are refused',()=>{
 assert.throws(()=>linkedThreadUrl(links,{environmentId:'elsewhere',threadId:'child'}));
 assert.throws(()=>linkedThreadUrl([{...links[0],status:'expired'}],{environmentId:'mac',threadId:'child'}));
 for(const url of ['javascript:alert(1)','file:///etc/passwd','https://token:secret@example.com'])assert.throws(()=>linkedThreadUrl([{...links[0],urls:[url]}],{environmentId:'mac',threadId:'child'}));
 assert.throws(()=>linkedThreadUrl(links,{environmentId:'mac',threadId:'../../outside'}));
});
test('public link metadata is shared between concurrent requests and cached without exposing the CLI output',async()=>{
 let calls=0;
 const resolve=createThreadLinkResolver({cli:'test-t3',exec:async(command,args)=>{calls++;assert.equal(command,'test-t3');assert.deepEqual(args,['environment','list','--json']);return{stdout:JSON.stringify(links)}}});
 const results=await Promise.all([resolve({environmentId:'mac',threadId:'one'}),resolve({environmentId:'mac',threadId:'two'})]);
 assert.equal(calls,1);assert.deepEqual(results,['https://mac.example.test/mac/one','https://mac.example.test/mac/two']);
 assert.equal(await resolve({environmentId:'mac',threadId:'three'}),'https://mac.example.test/mac/three');assert.equal(calls,1);
});
