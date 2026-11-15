import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

// Exact recovered client source, with only module import/export plumbing adapted
// for a deterministic SDK/device mock. No connection or cleanup logic is replaced.
const source=readFileSync(new URL('./fixtures/voiceTransport.txt',import.meta.url),'utf8')
  .replace("import { micTalkThreshold, micReleaseThreshold } from './settings.js';",'')
  .replace("import('livekit-client')",'loadSDK()').replace(/^export /gm,'');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function load(extra={}) {
  const ctx=vm.createContext({console:{info(){},warn(){}},setTimeout,clearTimeout,AbortController,
    performance,micTalkThreshold:()=>.1,micReleaseThreshold:()=>.05,
    navigator:{mediaDevices:{}},window:{},requestAnimationFrame:()=>1,cancelAnimationFrame(){},
    document:{body:{appendChild(){}}},...extra});
  return vm.runInContext(source+'\n({VoiceTransport,requestArenaVoiceToken})',ctx);
}
function arena() {
  const messages=new Set(),leaves=new Set(),sent=[];
  const onLeave=fn=>leaves.add(fn);onLeave.remove=fn=>leaves.delete(fn);
  return {messages,leaves,sent,onLeave,
    onMessage(type,fn){assert.equal(type,'voiceToken');messages.add(fn);return()=>messages.delete(fn);},
    send(...args){sent.push(args);},reply(data){for(const fn of [...messages])fn(data);}};
}

test('joined helper subscribes before sending no payload and cleans up every completion path',async()=>{
  const {requestArenaVoiceToken}=load();
  for(const finish of ['response','error','leave','abort','timeout','send-error']) {
    const room=arena(),ac=new AbortController();
    room.send=(...args)=>{room.sent.push(args);assert.equal(room.messages.size,1);if(finish==='send-error')throw Error('closed');};
    const pending=requestArenaVoiceToken(room,{signal:ac.signal,timeoutMs:5});
    if(finish==='response')room.reply({url:'ws://local',token:'test'});
    if(finish==='error')room.reply({error:'unavailable'});
    if(finish==='leave')for(const fn of [...room.leaves])fn();
    if(finish==='abort')ac.abort();
    const result=await pending;
    assert.equal(result?.token,finish==='response'?'test':undefined);
    assert.deepEqual(room.sent,[['voiceToken']]);
    assert.equal(room.messages.size,0);assert.equal(room.leaves.size,0);
  }
});

test('late SDK, SFU, capture, mute and publication work cannot replace the next connection',async()=>{
  for(const phase of ['sdk','connect','capture','mute','publish']) {
    const gate=deferred(),rooms=[],tracks=[];let sdkCalls=0;
    const track=()=>{const t={stopped:0,muted:false,async mute(){this.muted=true;if(phase==='mute'&&tracks[0]===this)await gate.promise;},unmute(){this.muted=false;},stop(){this.stopped++;}};tracks.push(t);return t;};
    const sdk={Track:{Kind:{Audio:'audio'}},RoomEvent:{TrackSubscribed:'track',TrackUnsubscribed:'untrack',Disconnected:'disconnect',AudioPlaybackStatusChanged:'play'},
      Room:class{
        constructor(){this.events=new Map();this.disconnects=0;this.canPlaybackAudio=true;rooms.push(this);
          this.localParticipant={publishTrack:async t=>{assert.equal(t.muted,true,'mic must be muted before publication');if(phase==='publish'&&rooms[0]===this)await gate.promise;}};}
        on(event,fn){this.events.set(event,fn);}
        async connect(){if(phase==='connect'&&rooms[0]===this)await gate.promise;}
        async disconnect(){this.disconnects++;}
        async startAudio(){}
      },async createLocalAudioTrack(){const t=track();if(phase==='capture'&&tracks[0]===t)await gate.promise;return t;}};
    const {VoiceTransport}=load({loadSDK:()=>phase==='sdk'&&++sdkCalls===1?gate.promise:Promise.resolve(sdk)});
    const voice=new VoiceTransport();const old=voice.connect('ws://local','old');await flush();
    const oldRoom=voice.room;
    await voice.disconnect();await voice.connect('ws://local','new');
    const currentRoom=voice.room,currentTrack=voice.micTrack;
    assert.equal(voice.status,'live',phase);
    gate.resolve(sdk);await old;
    oldRoom?.events.get('disconnect')?.();
    oldRoom?.events.get('play')?.();
    assert.equal(voice.room,currentRoom,phase);assert.equal(voice.micTrack,currentTrack,phase);
    assert.equal(voice.status,'live');assert.equal(currentTrack.stopped,0);
    for(const t of tracks)if(t!==currentTrack)assert(t.stopped>0,phase);
    await voice.disconnect();
  }
});

test('a superseded microphone monitor stops its late stream without altering the new monitor',async()=>{
  const captures=[deferred(),deferred()];let call=0;
  class AudioContext{
    resume(){return Promise.resolve();}close(){}createMediaStreamSource(){return{connect(){}};}
    createAnalyser(){return{fftSize:512};}
  }
  const {VoiceTransport}=load({navigator:{mediaDevices:{getUserMedia:()=>captures[call++].promise}},window:{AudioContext}});
  const voice=new VoiceTransport();voice.startMicMonitor();voice.stopMicMonitor();voice.startMicMonitor();
  const stream=()=>({stopped:0,getTracks(){return[{stop:()=>this.stopped++}];}});
  const old=stream(),current=stream();captures[1].resolve(current);await flush();
  captures[0].resolve(old);await flush();
  assert.equal(old.stopped,1);assert.equal(current.stopped,0);assert.equal(voice._monStream,current);
  assert.equal(voice.monitorActive(),true);voice.stopMicMonitor();assert.equal(current.stopped,1);
});

test('stale playback, mute and VOX callbacks cannot touch a new connection',async()=>{
  const {VoiceTransport}=load();const voice=new VoiceTransport();
  const audio=deferred();voice.room={startAudio:()=>audio.promise};
  let plays=0;const unlock=voice.unlockPlayback();
  voice.room={canPlaybackAudio:false};voice._generation++;
  voice._audioEls.set('new',{play(){plays++;}});audio.resolve();await unlock;assert.equal(plays,0);
  const unmute=deferred();const old={stopped:0,unmute:()=>unmute.promise,stop(){this.stopped++;}};
  voice.micTrack=old;voice.setMicEnabled(true);voice._generation++;voice.micTrack={};
  unmute.resolve();await flush();assert.equal(old.stopped,1);
  let callback,ticks=0;const {VoiceTransport:V}=load({requestAnimationFrame:fn=>{callback=fn;return 1;}});
  const v=new V();v._voxTick=()=>ticks++;v.setVoxEnabled(true);const stale=callback;
  v.setVoxEnabled(false);v.setVoxEnabled(true);stale();assert.equal(ticks,0);
});
