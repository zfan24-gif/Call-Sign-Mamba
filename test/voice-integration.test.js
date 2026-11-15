import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'colyseus.js';
import { matchMaker } from '@colyseus/core';
import { createArenaServer } from '../index.js';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const clientSource=readFileSync(new URL('./fixtures/voiceTransport.txt',import.meta.url),'utf8');
const helperSource=clientSource.slice(clientSource.indexOf('export function requestArenaVoiceToken'),clientSource.indexOf('export class VoiceTransport')).replace('export ','');
const requestArenaVoiceToken=vm.runInNewContext(helperSource+'\nrequestArenaVoiceToken',{setTimeout,clearTimeout});

async function until(predicate) {
  for(let i=0;i<100;i++){if(predicate())return;await delay(10);}
  assert.fail('local room transition timed out');
}
function request(room,payload) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{off();reject(Error('voice response timeout'));},2000);
    const off=room.onMessage('voiceToken',data=>{clearTimeout(timer);off();resolve(data);});
    room.send('voiceToken',payload);
  });
}

test('real HTTP and two independent websocket arenas enforce connection scoping and reconnection',async t=>{
  const issued=[],removed=[];
  const backend={configured:true,async issue(claims){issued.push(claims);return {url:'ws://127.0.0.1:1',token:'local-token-'+issued.length};},
    async remove(...args){removed.push(args);}};
  const {gameServer,httpServer}=createArenaServer({voiceBackend:backend,gracefullyShutdown:false});
  await gameServer.listen(0,'127.0.0.1');
  const port=httpServer.address().port,client=new Client('ws://127.0.0.1:'+port);
  let a,b,rejoined;
  t.after(async()=>{await Promise.allSettled([a,b,rejoined].filter(r=>r?.connection.isOpen).map(r=>r.leave()));await gameServer.gracefullyShutdown(false);});
  const response=await fetch('http://127.0.0.1:'+port+'/voice-token',{method:'POST',body:JSON.stringify({room:'stolen'})});
  assert.equal(response.status,410);assert.deepEqual(await response.json(),{error:'voice_requires_joined_connection'});
  a=await client.create('arena',{name:'alpha'});b=await client.create('arena',{name:'bravo'});
  for(const room of [a,b]) room.onMessage('netprobe',msg=>room.send('netprobe',msg));
  assert.notEqual(a.roomId,b.roomId);
  await request(a,{room:b.roomId,identity:b.sessionId,sessionId:b.sessionId,name:'BRAVO'});
  await request(b,{room:a.roomId,identity:a.sessionId});
  assert.deepEqual(issued,[{room:a.roomId,identity:a.sessionId,name:'ALPHA'},{room:b.roomId,identity:b.sessionId,name:'BRAVO'}]);
  const serverA=matchMaker.getRoomById(a.roomId),serverB=matchMaker.getRoomById(b.roomId);
  const old=serverA.clients[0];
  await serverB.voiceAccess.request(old);assert.equal(issued.length,2);
  const reconnectToken=a.reconnectionToken;
  a.connection.close(4001);
  await until(()=>!serverA.voiceAccess.members.has(a.sessionId));
  assert.equal(serverA.state.ships.get(a.sessionId).connected,false);
  await serverA.voiceAccess.request(old);assert.equal(issued.length,2);
  rejoined=await client.reconnect(reconnectToken);
  rejoined.onMessage('netprobe',msg=>rejoined.send('netprobe',msg));
  const credentials=await requestArenaVoiceToken(rejoined,{timeoutMs:2000});
  assert.equal(credentials?.url,'ws://127.0.0.1:1');
  assert.equal(credentials?.token,'local-token-3');
  assert.equal(rejoined.sessionId,a.sessionId);
  assert.deepEqual(issued.at(-1),{room:a.roomId,identity:a.sessionId,name:'ALPHA'});
  assert.deepEqual(removed[0],[a.roomId,a.sessionId]);
  assert.notEqual(serverA.voiceAccess.members.get(a.sessionId).client,old);
  a=null;
});
