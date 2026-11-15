import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenVerifier } from 'livekit-server-sdk';
import { VoiceAccess, VoiceRateLimit } from '../voice/VoiceAccess.js';
import { createVoiceBackend } from '../voice/backend.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({backend, processLimit = new VoiceRateLimit(120)} = {}) {
  let time = 0;
  const issued = [], removed = [];
  const room = {roomId:'arena-one', clients:[], state:{ships:new Map()}};
  const voice = new VoiceAccess(room, backend || {configured:true,
    async issue(claims) { issued.push(claims); return {url:'ws://127.0.0.1:1',token:'test-token'}; },
    async remove(...args) {removed.push(args);},
  }, {now:()=>time,processLimit});
  const add = (id='pilot') => {
    const client={sessionId:id,ref:{readyState:1},messages:[],send(type,data){this.messages.push({type,data});}};
    room.clients.push(client);room.state.ships.set(id,{name:'SERVER PILOT',connected:true});voice.join(client);return client;
  };
  return {voice,room,issued,removed,add,advance:ms=>{time+=ms;}};
}

test('voice claims come only from the active arena, ship and exact connection',async()=>{
  const f=fixture(),c=f.add();
  await f.voice.request({...c});
  await f.voice.request(c,{room:'stolen',sessionId:'other',identity:'other',name:'spoof'});
  assert.deepEqual(f.issued,[{room:'arena-one',identity:'pilot',name:'SERVER PILOT'}]);
  assert.equal(c.messages[0].type,'voiceToken');
  f.advance(5000);f.room.clients=[];await f.voice.request(c);
  assert.equal(f.issued.length,1);
});

test('unjoined, closed, disconnected and disposed transports cannot issue',async()=>{
  for(const change of [f=>f.voice.members.clear(),f=>f.room.clients[0].ref.readyState=3,
    f=>f.room.state.ships.get('pilot').connected=false,f=>f.voice.dispose()]) {
    const f=fixture(),c=f.add();change(f);await f.voice.request(c);
    assert.equal(f.issued.length,0);assert.equal(c.messages.length,0);
  }
});

test('delayed signing is discarded on leave, disposal and membership replacement',async()=>{
  for(const action of ['leave','dispose','replace']) {
    const sign=deferred();
    const f=fixture({backend:{configured:true,issue:()=>sign.promise,remove:async()=>{}}}),c=f.add();
    const request=f.voice.request(c);await flush();
    if(action==='leave')f.voice.leave(c);
    if(action==='dispose')f.voice.dispose();
    if(action==='replace')f.add('pilot');
    sign.resolve({url:'ws://127.0.0.1:1',token:'never-send'});await request;
    assert.equal(c.messages.length,0);
  }
});

test('one outstanding signing and five-second cooldown include signing failures',async()=>{
  const sign=deferred();let calls=0;
  const f=fixture({backend:{configured:true,issue:()=>{calls++;return sign.promise;},remove:async()=>{}}}),c=f.add();
  const pending=f.voice.request(c);await flush();f.advance(6000);
  await f.voice.request(c);assert.equal(calls,1);assert.equal(c.messages.length,0);
  sign.reject(new Error('private SDK details'));await pending;
  assert.deepEqual(c.messages[0].data,{error:'voice_token_failed'});
  f.voice.backend.issue=async()=>({url:'ws://127.0.0.1:1',token:'ok'});
  await f.voice.request(c);await f.voice.request(c);
  assert.equal(c.messages.at(-1).data.error,'voice_rate_limited');
  f.advance(4999);await f.voice.request(c);assert.equal(c.messages.at(-1).data.error,'voice_rate_limited');
  f.advance(1);await f.voice.request(c);assert.equal(c.messages.at(-1).data.token,'ok');
});

test('rolling arena limit is 48 and shared process limit is 120 per minute',async()=>{
  const processLimit=new VoiceRateLimit(120);
  const rooms=[fixture({processLimit}),fixture({processLimit}),fixture({processLimit})];
  for(const [index,f] of rooms.entries()) {
    for(let i=0;i<49;i++) await f.voice.request(f.add('pilot-'+i));
    assert.equal(f.issued.length,index<2?48:24);
  }
  for(const f of rooms) f.advance(60000);
  await rooms[0].voice.request(rooms[0].add('fresh'));
  assert.equal(rooms[0].issued.length,49);
});

test('reconnection waits for old participant removal and stale leave cannot remove new membership',async()=>{
  const removal=deferred();let issued=0,removed=0;
  const f=fixture({backend:{configured:true,issue:async()=>({url:'ws://127.0.0.1:1',token:String(++issued)}),
    remove:()=>{removed++;return removal.promise;}}});
  const old=f.add();await f.voice.request(old);f.voice.leave(old);
  const fresh=f.add();const pending=f.voice.request(fresh);await flush();
  assert.equal(issued,1);assert.equal(removed,1);assert.equal(fresh.messages.length,0);
  f.voice.leave(old);assert.equal(f.voice.members.get('pilot').client,fresh);
  removal.resolve();await pending;
  assert.equal(fresh.messages[0].data.token,'2');assert.equal(removed,1);
});

test('departure removal is best effort, issued connections only, and disposal clears membership',async()=>{
  let removals=0;
  const f=fixture({backend:{configured:true,issue:async()=>({url:'x',token:'y'}),remove:async()=>{removals++;throw Error('unavailable');}}});
  f.add('silent');const c=f.add('issued');await f.voice.request(c);
  await f.voice.dispose();assert.equal(removals,1);assert.equal(f.voice.members.size,0);
  const fresh=f.add('late');await f.voice.request(fresh);assert.equal(fresh.messages.length,0);
});

test('backend signs 60-second microphone-only JWTs and configures bounded removal',async()=>{
  let options,removed;
  class FakeRoomService {
    constructor(url,key,secret,config){options={url,config};}
    async removeParticipant(...args){removed=args;}
  }
  const env={LIVEKIT_URL:'ws://127.0.0.1:1',LIVEKIT_API_KEY:'local-key',LIVEKIT_API_SECRET:'local-test-secret-not-production'};
  const backend=createVoiceBackend(env,{RoomService:FakeRoomService});
  const before=Math.floor(Date.now()/1000);
  const result=await backend.issue({room:'a',identity:'b',name:'PILOT'});
  const claims=await new TokenVerifier(env.LIVEKIT_API_KEY,env.LIVEKIT_API_SECRET).verify(result.token);
  assert.equal(result.url,env.LIVEKIT_URL);assert.equal(claims.sub,'b');assert.equal(claims.name,'PILOT');
  assert(claims.exp>=before+59&&claims.exp<=before+61);
  assert.deepEqual(claims.video,{roomJoin:true,room:'a',canPublish:true,canPublishSources:['microphone'],canSubscribe:true,canPublishData:false});
  await backend.remove('a','b');
  assert.deepEqual(options,{url:'http://127.0.0.1:1',config:{requestTimeout:5,failover:false}});
  assert.deepEqual(removed,['a','b']);
  const disabled=createVoiceBackend({});assert.equal(disabled.configured,false);
  await assert.rejects(disabled.issue({}));
});
