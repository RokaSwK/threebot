import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { archivedBotIdentities } from './bot-identities.mts';

test('old mentions recover exact identities from trash without restoring files or exposing unrelated metadata', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'bot-identities-'));
  try {
    const dir=path.join(root,'research-helper-1793324642743');await mkdir(path.join(dir,'.bot'),{recursive:true});
    const metadata={name:'Research',mainThreadId:'old-thread',projectId:'old-project',shape:'hex',color:'purple',credentials:'never-return-this'};
    const file=path.join(dir,'.bot/bot.json');await writeFile(file,JSON.stringify(metadata));
    await mkdir(path.join(root,'unrelated'));await mkdir(path.join(root,'broken-1793324642743'));
    const result=await archivedBotIdentities(root);
    assert.equal(result.length,1);assert.equal(result[0].name,'Research');assert.equal(result[0].slug,'research-helper');
    assert.equal(result[0].mainThreadId,'old-thread');assert.equal(result[0].shape,'hex');assert.equal(result[0].color,'purple');
    assert.equal(result[0].workspaceRoot,dir);assert.equal(result[0].notifications,false);assert.equal(result[0].hidden,true);
    assert.equal('credentials' in result[0],false);assert.deepEqual(JSON.parse(await readFile(file,'utf8')),metadata);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('a new installation without recoverable Bots has an empty identity list', async()=>{
  assert.deepEqual(await archivedBotIdentities(path.join(tmpdir(),'missing-bot-identities-folder')),[]);
});
