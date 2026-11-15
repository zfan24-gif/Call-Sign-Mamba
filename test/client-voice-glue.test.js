import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./fixtures/voice-glue.txt',import.meta.url),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('coordinator deduplicates requests, aborts old rooms and fences delayed UI, VOX and mic presence',async()=>{
  const requests=[],connects=[],timers=[],talk=[],presence=[];
  const multiplayer={connected:true,room:{id:'a'},setTalking:v=>talk.push(v),setMicPresence:v=>presence.push(v)};
  const voice={connected:false,status:'off',disconnect(){this.connected=false;},stopMicMonitor(){},startMicMonitor(){},
    async connect(url,token){connects.push(token);this.connected=true;},hasMic:()=>true,monitorActive:()=>true};
  const ctx=vm.createContext({multiplayer,voice,AbortController,
    requestArenaVoiceToken:(room,{signal})=>{const d=deferred();requests.push({room,signal,...d});return d.promise;},
    setVoiceHudStatus(){},setVoiceHud(){},renderLobbyRosters(){},applyVoiceMode(){},
    $:()=>({classList:{contains:()=>false}}),setTimeout:fn=>timers.push(fn)});
  const connect=vm.runInContext(source+'\nconnectVoiceAudio',ctx);
  multiplayer.onVoiceConnection(multiplayer.room);connect();connect();assert.equal(requests.length,1);
  const oldRoom=multiplayer.room;multiplayer.onVoiceConnection(null);
  assert.equal(requests[0].signal.aborted,true);
  multiplayer.room={id:'b'};multiplayer.onVoiceConnection(multiplayer.room);
  requests[0].resolve({url:'ws://local',token:'old'});await flush();assert.equal(connects.length,0);
  requests[1].resolve({url:'ws://local',token:'new'});await flush();assert.deepEqual(connects,['new']);
  const oldVox=voice.onVoxActive,oldTimer=timers[0];
  multiplayer.onVoiceConnection(null);multiplayer.room=oldRoom;multiplayer.onVoiceConnection(oldRoom);
  const before=[talk.length,presence.length];oldVox(true);oldTimer();
  assert.deepEqual([talk.length,presence.length],before);
  requests[2].resolve(null);await flush();assert.equal(voice.reason,'no-token');
});
