import test from 'node:test';
import assert from 'node:assert/strict';
import {ArenaRoom} from '../rooms/ArenaRoom.js';
import {ArenaState, Ship, Bolt, Missile} from '../rooms/schema.js';
import {CapitalAssault} from '../rooms/CapitalAssault.js';

function fixture(mode) {
  const room = Object.create(ArenaRoom.prototype);
  Object.defineProperty(room, 'roomId', { value: 'regression' });
  room.state = new ArenaState();
  room.state.mode = mode;
  room.state.matchState = 'live';
  room.sim = new Map();
  room.events = [];
  room.broadcast = (type, data) => room.events.push({type, data});
  room._now = 10;
  room.capitalAssault = new CapitalAssault(room);
  return room;
}

function ship(room, id, team, pos = 0) {
  const pilot = new Ship();
  Object.assign(pilot, {name:id, team, px:pos, alive:true, hull:100, shields:0, missiles:1, maxMissiles:5});
  room.state.ships.set(id, pilot);
  room.sim.set(id, {pos:{x:pos,y:0,z:0}, vel:{x:0,y:0,z:0}, killStreak:0, maxMissiles:5, firepower:1});
  return pilot;
}

test('wingmate collision reports the death without personal, team or resupply credit', () => {
  const room=fixture('ctc');
  const victim=ship(room,'victim',0), other=ship(room,'wingmate',0,4);
  room._collideCd=new Map();
  victim.hull=1;
  room.resolveShipCollisions();
  const kill=room.events.find(e=>e.type==='kill').data;
  assert.deepEqual([victim.deaths,other.kills,room.state.blueKills,kill.credited,kill.missileResupply],[1,0,0,false,0]);
});

test('missile messages report only real grants in FFA and in team play', () => {
  for(const [mode,reward] of [['ffa',2],['ctc',3]]){
    const room=fixture(mode), attacker=ship(room,'pilot',0);
    for(let i=1;i<=reward*2;i++){
      const id='opponent'+i;
      room.killShip(id,ship(room,id,mode==='ffa'?0:1),'pilot');
      const kill=room.events.at(-1).data;
      assert.equal(kill.credited,true);
      assert.equal(kill.missileResupply,i===reward?1:0);
      if(i===reward){assert.equal(attacker.missiles,2);attacker.missiles=attacker.maxMissiles;}
    }
  }
});

test('capital weapons retain their faction identity without pilot credit', () => {
  for(const team of [0,1]){
    const room=fixture('csa'), victim=ship(room,'pilot',1-team);
    room.killShip('pilot',victim,'cap:'+team);
    const k=room.events.at(-1).data;
    assert.equal(k.killerTeam,team);assert.match(k.killerName,/CAPITAL CANNON/);
    assert.equal(k.credited,false);assert.equal(room.state.blueKills+room.state.redKills,0);
  }
});

test('end of round freezes combat, respawns and projectiles; tied leaders are sent with score', () => {
  const room=fixture('ffa'), a=ship(room,'ALPHA',0), b=ship(room,'BRAVO',0);
  a.kills=b.kills=4;a.alive=false;a.hull=0;
  room.state.bolts.set('last',new Bolt());room.state.missiles.set('last',new Missile());
  room.endMatch();
  const e=room.events.at(-1).data;
  assert.deepEqual([e.winnerName,e.winnerKills,e.tiedNames],['',4,['ALPHA','BRAVO']]);
  const before=JSON.stringify(room.state.toJSON());
  for(let i=0;i<120;i++){room.tick();room.tryFire('BRAVO');room.tryFireMissile('BRAVO','ALPHA');}
  assert.equal(JSON.stringify(room.state.toJSON()),before);
  assert.equal(room.state.bolts.size+room.state.missiles.size,0);
});

function shoot(ctrl, source, direction, targetTeam, missile) {
  const step = (missile?300:520)/30;
  let p=source;
  for(let i=0;i<120;i++){
    const end={x:p.x+step*direction.x,y:p.y+step*direction.y,z:p.z+step*direction.z};
    const shot={team:1-targetTeam,owner:'pilot',px:p.x,py:p.y,pz:p.z};
    const hit=missile?ctrl.testMissileHit(shot,p.x,p.y,p.z,end.x,end.y,end.z):ctrl.testBoltHit(shot,end.x,end.y,end.z);
    if(hit)return true;
    p=end;
  }
  return false;
}

test('both capitals expose default and authored generators to direct front-surface fire', () => {
  for(const authored of [false,true])for(const team of [0,1])for(const missile of [false,true]){
    const room=fixture('csa'), ctrl=room.capitalAssault;
    if(authored)assert.equal(ctrl.acceptManifest(team,{turrets:[],shieldgens:[
      {id:'dorsal',pos:[0,19,38],radius:9},{id:'ventral',pos:[0,-19,-38],radius:9}
    ]}),true);
    ctrl.setup();
    const gens=[...ctrl._emp.values()].filter(e=>e.capTeam===team&&e.kind==='shieldgen');
    assert.equal(gens.length,2);
    for(const gen of gens){
      const p=gen.worldPos, sign=gen.normalWorld.y>=0?1:-1;
      for(const range of [250,350]){
        const prev=gen.e.hp;
        assert.equal(shoot(ctrl,{...p,y:p.y+sign*range},{x:0,y:-sign,z:0},team,missile),true);
        assert.ok(gen.e.hp<prev);
      }
    }
    const c=room.baseCenter(team);
    const direction=ctrl._caps[team].right;
    const pose=ctrl._caps[team];
    const start={x:c.x+pose.zAxis.x*pose.len*0.35-direction.x*350,y:c.y,z:c.z+pose.zAxis.z*pose.len*0.35-direction.z*350};
    assert.equal(shoot(ctrl,start,direction,team,missile),true);
    assert.ok(room.events.some(e=>e.type==='capShieldDeflect'));
    assert.equal(room.state[team===0?'blueCapHull':'redCapHull'],100);
    // Once exposed, an ordinary broadside damages the hull.
    for(const e of ctrl._emp.values()) if(e.capTeam===team)e.e.alive=false;
    shoot(ctrl,start,direction,team,missile);
    assert.ok(room.state[team===0?'blueCapHull':'redCapHull']<100);
  }
});
