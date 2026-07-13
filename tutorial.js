// ====================================================================================================
// Interactive Flight-Controls Tutorial — Call Sign Mamba
// ----------------------------------------------------------------------------------------------------
// A step-by-step, hands-on flight school that runs as its own gameplay mode (mission.tutorial). The
// player flies the real ship in the real scene; this controller walks them through each control ONE
// STEP AT A TIME via an on-screen instruction banner, watching for the actual input/event that
// satisfies the current step before advancing.
//
// Flow:
//   1. Intro VO (tutorialow1, then tutorialow2 0.3s later) while the player learns to fly.
//   2. Movement steps  — pitch (W/S), roll (A/D), yaw (Q/E), boost, view toggle.
//   3. Gunnery steps   — fire lasers, then destroy stationary cargo containers (target practice).
//   4. Targeting steps — lock a target, hold the lock to arm a missile, FIRE the missile.
//   5. Defense step    — deploy chaff.
//   6. After 10 containers destroyed: tutorialow3 VO, then 3 enemy fighters warp in for a live
//      dogfight. Final step clears once all three are down -> tutorial complete.
//
// main.js owns the scene, input, spawning and audio; it feeds this controller per-frame `update(dt)`
// plus discrete event notifications (key pressed, container/fighter destroyed, fired, locked, etc.).
// The controller is deliberately decoupled: it only reads/writes the banner DOM and calls back into
// host hooks supplied at construction.
// ====================================================================================================

import { bindLabel } from './settings.js';

// Banner DOM ids (defined in index.html).
const BANNER_ID = 'tutBanner';
const BANNER_STEP_ID = 'tutBannerStep';
const BANNER_TITLE_ID = 'tutBannerTitle';
const BANNER_BODY_ID = 'tutBannerBody';
const BANNER_HINT_ID = 'tutBannerHint';
const BANNER_PROGRESS_ID = 'tutBannerProgress';

const TUTORIAL_VO = {
  intro1: 'assets/audio/voice/tutorial/tutorialow1.mp3',
  intro2: 'assets/audio/voice/tutorial/tutorialow2.mp3',
  combat: 'assets/audio/voice/tutorial/tutorialow3.mp3',
  end1: 'assets/audio/voice/tutorial/tutorialdone1.mp3',
  end2: 'assets/audio/voice/tutorial/tutorialdone2.mp3'
};

const CONTAINERS_TO_CLEAR = 10;   // destroy this many cargo containers before the fighters warp in
const FIGHTERS_TO_CLEAR = 3;      // enemy fighters that warp in for the closing dogfight

export class TutorialController {
  // hooks: {
  //   playVO(url, vol?, onDone?), flash(text),
  //   spawnContainers(count), spawnFighters(count),
  //   clearTargets(), onComplete(), bindLabel(actionId)
  // }
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.active = false;
    this.steps = [];
    this.stepIndex = 0;
    this.stepT = 0;            // seconds the current step has been showing
    this.holdT = 0;           // generic accumulator for "hold an input for N seconds" steps
    this.containersDestroyed = 0;
    this.fightersDestroyed = 0;
    this.fightersSpawned = false;
    this.fightersAlive = 0;        // live tutorial bandits currently in the fight
    this.graduating = false;       // true once the first wave is cleared: end VO + hyperspace prompt up
    this.hyperReady = false;       // true once the end VO finishes and H is accepted to finish
    this._introTimer = null;
    this._chaffRefireT = 0;        // re-fire timer for the chaff lesson (fresh missile if ignored)
    // Live input/event flags, set by notify* and consumed by step conditions.
    this.flags = {
      aim: false, throttle: false, roll: false, boost: false, view: false,
      fired: false, cycled: false, selected: false, locked: false, missileFired: false, chaff: false,
      // Power diversion: the player must divert to each system once, then reset the reactor balance.
      routeShields: false, routeWeapons: false, routeEngines: false, resetPower: false
    };
    // NOTE: do not assign `this._banner` here — `_banner()` is a prototype METHOD (returns the
    // banner element). An instance property of the same name would shadow it and break `_banner()`.
  }

  // ---- Lifecycle ----------------------------------------------------------------------------------
  start() {
    this.active = true;
    this.stepIndex = 0;
    this.stepT = 0;
    this.holdT = 0;
    this.containersDestroyed = 0;
    this.fightersDestroyed = 0;
    this.fightersSpawned = false;
    this.fightersAlive = 0;
    this.graduating = false;
    this.hyperReady = false;
    this._resetFlags();
    this._buildSteps();
    this._showBanner();
    this._renderStep();
    // Intro VO: play line 1, then 0.3s AFTER it finishes, play line 2 (sequential, no overlap).
    if (this.hooks.playVO) {
      this.hooks.playVO(TUTORIAL_VO.intro1, 0.95, () => {
        this._introTimer = setTimeout(() => {
          if (this.active && this.hooks.playVO) this.hooks.playVO(TUTORIAL_VO.intro2, 0.95);
        }, 300);
      });
    }
    // Seed the first batch of target practice containers right away so the player has something to
    // shoot the moment the gunnery steps come up (they're already adrift while movement is taught).
    if (this.hooks.spawnContainers) this.hooks.spawnContainers(CONTAINERS_TO_CLEAR);
  }

  stop() {
    this.active = false;
    if (this._introTimer) { clearTimeout(this._introTimer); this._introTimer = null; }
    this._hideBanner();
  }

  _resetFlags() {
    for (const k of Object.keys(this.flags)) this.flags[k] = false;
  }

  // ---- Event notifications (called from main.js) --------------------------------------------------
  notifyAxis(axis) { if (axis && this.flags[axis] !== undefined) this.flags[axis] = true; }   // 'aim'|'throttle'|'roll'
  notifyBoost() { this.flags.boost = true; }
  notifyView() { this.flags.view = true; }
  notifyFired() { this.flags.fired = true; }
  notifyTargetSelected() { this.flags.selected = true; this.flags.locked = true; }   // T — closest target
  notifyTargetCycled() { this.flags.cycled = true; this.flags.locked = true; }       // R — cycle targets
  notifyLocked() { this.flags.locked = true; }
  notifyMissileFired() { this.flags.missileFired = true; }
  notifyChaff() { this.flags.chaff = true; }
  // Power routing lessons: main.js reports which system the player just diverted power into, and a
  // reactor reset when they press the Reset Power key. `system` is 'shields' | 'weapons' | 'engines'.
  notifyRoute(system) {
    if (system === 'shields') this.flags.routeShields = true;
    else if (system === 'weapons') this.flags.routeWeapons = true;
    else if (system === 'engines') this.flags.routeEngines = true;
  }
  notifyResetPower() { this.flags.resetPower = true; }

  notifyContainerDestroyed() {
    if (!this.active) return;
    this.containersDestroyed++;
    if (this.hooks.flash) this.hooks.flash(`TARGET DESTROYED · ${this.containersDestroyed}/${CONTAINERS_TO_CLEAR}`);
  }
  notifyFighterDestroyed() {
    if (!this.active) return;
    this.fightersDestroyed++;
    this.fightersAlive = Math.max(0, this.fightersAlive - 1);
    // GRADUATION: once the closing dogfight is won and the player is in the "press H" hold, killing
    // the LAST remaining bandit without having jumped spawns another wave of 3 — the fight keeps
    // coming until the player chooses to enter hyperspace.
    if (this.graduating && !this.hyperReady && this.fightersAlive <= 0) {
      this._sendReinforcements();
    }
  }

  // Spawn another wave of 3 fighters and track them as alive.
  _sendReinforcements(n = FIGHTERS_TO_CLEAR) {
    if (this.hooks.spawnFighters) {
      this.hooks.spawnFighters(n);
      this.fightersAlive += n;
    }
  }

  // The player pressed the Hyperspace key during the graduation hold — jump to lightspeed. Instead
  // of ending the tutorial outright, the host drops the ship into a held warp tunnel and shows the
  // post-tutorial menu (Continue / Options / Main Menu / Exit). The tutorial controller stands down
  // here; the host owns the menu and whatever happens next.
  notifyHyperspace() {
    if (!this.active || !this.graduating || this.hyperReady) return;
    this.hyperReady = true;
    if (this.hooks.hideHyperPrompt) this.hooks.hideHyperPrompt();
    if (this.hooks.flash) this.hooks.flash('JUMPING TO LIGHTSPEED');
    // Park the tutorial machine but stay "active" enough not to re-trigger; the host takes over.
    if (this.hooks.onHyperspace) this.hooks.onHyperspace();
    else this._complete();   // fallback: if no host handler, finish to menu as before
  }

  // ---- Step definitions ---------------------------------------------------------------------------
  // Each step: { id, title, body(), hint(), done(), onEnter?(), once? }
  // - body()/hint() are re-evaluated every render so prompts pick up live key bindings.
  // - done() returns true when the player has satisfied the step.
  _buildSteps() {
    const L = (a) => (this.hooks.bindLabel ? this.hooks.bindLabel(a) : bindLabel(a));
    this.steps = [
      {
        id: 'aim',
        title: 'AIM — POINT YOUR NOSE',
        body: () => 'Move your <b>mouse</b> to aim. The reticle follows the cursor — your nose pitches and yaws to where you point.',
        hint: () => 'Steer with the mouse. Gentle inputs hold a steadier line.',
        done: () => this.flags.aim
      },
      {
        id: 'throttle',
        title: 'THROTTLE — SPEED UP / SLOW DOWN',
        body: () => `Work the throttle. Hold <kbd>${L('thrust')}</kbd> to accelerate and <kbd>${L('reverse')}</kbd> to brake.`,
        hint: () => 'Keep moving — a still fighter is an easy kill.',
        done: () => this.flags.throttle
      },
      {
        id: 'roll',
        title: 'ROLL — BANK LEFT / RIGHT',
        body: () => `Now <b>roll</b> the ship. Press <kbd>${L('strafeLeft')}</kbd> and <kbd>${L('strafeRight')}</kbd> to bank your wings over.`,
        hint: () => 'Roll into a turn, then pull with the mouse — that\'s how you turn hard.',
        done: () => this.flags.roll
      },
      {
        id: 'boost',
        title: 'BOOST — BURN FOR SPEED',
        body: () => `Punch the throttle. Hold <kbd>${L('boost')}</kbd> for a burst of <b>boost</b> speed.`,
        hint: () => 'Boost closes distance fast — and helps you break off when things get hot.',
        done: () => this.flags.boost
      },
      {
        id: 'view',
        title: 'VIEW — COCKPIT / CHASE',
        body: () => `Switch your view. Press <kbd>${L('toggleView')}</kbd> to toggle between <b>cockpit</b> and <b>chase</b> cam.`,
        hint: () => 'Fly in whichever view reads best for you — combat works in both.',
        done: () => this.flags.view
      },
      {
        // POWER DIVERSION — the reactor totals 100% and you shift it between three systems on the fly.
        // Taught as one combined step: divert to each system once to feel the trade-off, then reset.
        id: 'power',
        title: 'POWER — DIVERT THE REACTOR',
        body: () => `Your reactor always totals 100%, split across three systems. Divert it on the fly:<br>` +
          `<kbd>${L('routeShields')}</kbd> → <b>Shields</b> (${this.flags.routeShields ? '✓' : 'faster recharge, tougher charges'}) &nbsp; ` +
          `<kbd>${L('routeWeapons')}</kbd> → <b>Weapons</b> (${this.flags.routeWeapons ? '✓' : 'more fire rate, hotter bolts'}) &nbsp; ` +
          `<kbd>${L('routeEngines')}</kbd> → <b>Engines</b> (${this.flags.routeEngines ? '✓' : 'top speed, tighter turns'})<br>` +
          `Tap <b>each one</b> now — power pulls evenly from the other two.`,
        hint: () => 'Dump power to shields when you\'re taking fire, to engines to run down a bandit, to weapons for the kill.',
        done: () => this.flags.routeShields && this.flags.routeWeapons && this.flags.routeEngines
      },
      {
        id: 'resetPower',
        title: 'POWER — RESET THE BALANCE',
        body: () => `When the fight changes, snap back to an even split fast. Press <kbd>${L('resetPower')}</kbd> to <b>reset all systems</b> to the default 33 / 33 / 33.`,
        hint: () => 'One key rebalances the whole reactor — your instant "back to neutral" in a scramble.',
        done: () => this.flags.resetPower
      },
      {
        id: 'fire',
        title: 'GUNS — OPEN FIRE',
        body: () => `Time to shoot. Press <kbd>${L('fire')}</kbd> to fire your <b>lasers</b>. Bolts converge on the reticle.`,
        hint: () => 'Cargo containers are drifting ahead — line one up.',
        done: () => this.flags.fired
      },
      {
        // Taught EARLY (before the kill-everything practice) because picking and cycling targets is
        // core to combat — locking, missiles and the scope all key off the selected contact.
        id: 'select',
        title: 'TARGETING — SELECT CLOSEST',
        body: () => `Press <kbd>${L('lockTarget')}</kbd> to <b>select the closest contact</b>. The targeting computer frames it and drives your scope.`,
        hint: () => 'Always know what you\'re pointed at — selecting closest is your fastest pick.',
        // Make sure there's something to select even if the player jumped the gun on guns.
        onEnter: () => { if (this.hooks.replenishTargets) this.hooks.replenishTargets(); },
        done: () => this.flags.selected
      },
      {
        id: 'cycle',
        title: 'TARGETING — CYCLE CONTACTS',
        body: () => `Now press <kbd>${L('cycleTarget')}</kbd> to <b>cycle</b> through every contact on the board. Stop on whichever one you want to kill.`,
        hint: () => 'In a furball, cycle to pick your shot — don\'t just chase the nearest.',
        onEnter: () => { if (this.hooks.replenishTargets) this.hooks.replenishTargets(); },
        done: () => this.flags.cycled
      },
      {
        id: 'missile',
        title: 'MISSILES — LOCK & FIRE',
        body: () => `With a contact selected and framed in the reticle, a <b>missile lock</b> arms. Press <kbd>${L('fireMissile', true)}</kbd> to launch a <b>guided missile</b>.`,
        hint: () => 'Keep the target in your sights until MISSILE LOCK flashes, then fire.',
        // Guarantee a live target to lock & kill, even after the player cleared a few practising guns.
        onEnter: () => { if (this.hooks.replenishTargets) this.hooks.replenishTargets(); },
        done: () => this.flags.missileFired
      },
      {
        id: 'targets',
        title: 'TARGET PRACTICE',
        body: () => `Clean up the drifting <b>cargo containers</b>. Knock out <b>${CONTAINERS_TO_CLEAR}</b> total to prove your aim.`,
        hint: () => `Containers cleared: <b>${this.containersDestroyed}/${CONTAINERS_TO_CLEAR}</b>`,
        // Top the field back up so there are always containers to finish the count on.
        onEnter: () => { if (this.hooks.replenishTargets) this.hooks.replenishTargets(); },
        done: () => this.containersDestroyed >= CONTAINERS_TO_CLEAR
      },
      {
        id: 'warpin',
        title: 'CONTACTS INBOUND',
        body: () => 'Real hostiles are jumping in. <b>Three enemy fighters</b> — one is launching a missile at you from range.',
        hint: () => 'Stay loose. A missile is on its way — get ready to spoof it.',
        // The combat VO + scripted fighter warp-in fire on enter. The far "shooter" then launches one
        // guided missile at the player; this step holds the banner until that missile is actually in
        // the air, so the chaff lesson that follows always has a real threat to break.
        onEnter: () => {
          if (this.hooks.playVO) this.hooks.playVO(TUTORIAL_VO.combat, 0.95);
          if (!this.fightersSpawned && this.hooks.spawnFighters) {
            this.fightersSpawned = true;
            // Small delay so the VO and "contacts inbound" banner land before they materialize.
            setTimeout(() => {
              if (this.active) { this.hooks.spawnFighters(FIGHTERS_TO_CLEAR, { scripted: true }); this.fightersAlive += FIGHTERS_TO_CLEAR; }
            }, 1200);
          }
        },
        // Advance only once the scripted missile is genuinely inbound (so chaff has a reason), with a
        // generous fallback so the tutorial can never wedge if the shot is somehow missed.
        done: () => (this.hooks.missileIncoming && this.hooks.missileIncoming()) || this.stepT >= 7.0
      },
      {
        id: 'chaff',
        title: 'DEFENSE — DEPLOY CHAFF',
        body: () => `A missile is inbound. Press <kbd>${L('chaff')}</kbd> now to drop <b>chaff</b> and break its lock.`,
        hint: () => 'Watch the MISSILE INBOUND warning — chaff decoys the seeker so it loses you.',
        onEnter: () => { this._chaffRefireT = 0; },
        // Keep the lesson honest: if the player never chaffs and the threat fizzles (missile hits,
        // expires, or gets decoyed away without their input), the shooter fires ANOTHER missile and
        // we re-prompt. This repeats until the player actually deploys chaff.
        onUpdate: (dt) => {
          if (this.flags.chaff) return;   // lesson satisfied — stop re-firing
          const incoming = this.hooks.missileIncoming && this.hooks.missileIncoming();
          if (incoming) { this._chaffRefireT = 0; return; }   // a live threat is up; let them react
          // No missile in the air and they haven't chaffed yet — count up, then fire a fresh one.
          this._chaffRefireT += dt;
          if (this._chaffRefireT >= 1.6) {
            this._chaffRefireT = 0;
            if (this.hooks.fireTutorialMissile) this.hooks.fireTutorialMissile();
            if (this.hooks.flash) this.hooks.flash('ANOTHER MISSILE INBOUND · DEPLOY CHAFF');
          }
        },
        done: () => this.flags.chaff
      },
      {
        id: 'dogfight',
        title: 'DOGFIGHT — SPLASH THE BANDITS',
        body: () => 'Now finish it. Destroy all three enemy fighters to complete flight school.',
        hint: () => `Bandits down: <b>${this.fightersDestroyed}/${FIGHTERS_TO_CLEAR}</b>`,
        // Clearing the first wave doesn't END the tutorial — it GRADUATES into the free-flight hold:
        // the end VO plays, the "press H to enter hyperspace" prompt appears, and reinforcements keep
        // jumping in until the player presses H.
        done: () => this.fightersDestroyed >= FIGHTERS_TO_CLEAR,
        onDone: () => this._enterGraduation()
      }
    ];
  }

  // First dogfight wave cleared: play the graduation VO and raise the hyperspace prompt. The fight
  // stays live — killing the last bandit spawns another wave until the player jumps out with H.
  _enterGraduation() {
    if (this.graduating) return;
    this.graduating = true;
    if (this.hooks.flash) this.hooks.flash('FLIGHT SCHOOL COMPLETE · JUMP WHEN READY');
    if (this.hooks.playVO) {
      // Play the first line, then 0.3s after it ends, play the second.
      this.hooks.playVO(TUTORIAL_VO.end1, 0.95, () => {
        setTimeout(() => {
          if (this.active && this.graduating && this.hooks.playVO) {
            this.hooks.playVO(TUTORIAL_VO.end2, 0.95);
          }
        }, 300);
      });
    }
    // Show the hyperspace prompt only after the end VO has had a beat to land.
    setTimeout(() => {
      if (this.active && this.graduating && !this.hyperReady && this.hooks.showHyperPrompt) {
        this.hooks.showHyperPrompt();
      }
    }, 900);
  }

  // ---- Per-frame update ---------------------------------------------------------------------------
  update(dt) {
    if (!this.active) return;
    this.stepT += dt;
    // Once graduating, the step machine is parked: the player free-flies, fights reinforcement
    // waves, and the only way out is pressing H (notifyHyperspace). No step advances here.
    if (this.graduating) return;
    const step = this.steps[this.stepIndex];
    if (!step) return;
    // Re-render the body/hint each frame so live counters (containers/fighters) stay current and the
    // key labels reflect any rebinds made mid-session.
    this._renderDynamic(step);
    // Optional per-frame step logic (e.g. the chaff step re-firing a missile if the player ignores it).
    if (step.onUpdate) step.onUpdate(dt);
    if (step.done && step.done()) {
      this._advance();
    }
  }

  _advance() {
    const step = this.steps[this.stepIndex];
    const finishing = this.stepIndex >= this.steps.length - 1;
    // A step can opt OUT of plain completion by providing onDone (e.g. the closing dogfight, which
    // graduates into the free-flight hyperspace hold instead of ending the tutorial outright).
    if (step && step.onDone) {
      this._hideBanner();
      step.onDone();
      return;
    }
    if (finishing) {
      this._complete();
      return;
    }
    this.stepIndex++;
    this.stepT = 0;
    this.holdT = 0;
    const next = this.steps[this.stepIndex];
    if (next && next.onEnter) next.onEnter();
    this._renderStep();
  }

  _complete() {
    if (this.hooks.flash) this.hooks.flash('FLIGHT SCHOOL COMPLETE');
    this.stop();
    if (this.hooks.onComplete) this.hooks.onComplete();
  }

  // ---- Banner rendering ---------------------------------------------------------------------------
  _banner() { return document.getElementById(BANNER_ID); }

  _showBanner() {
    const el = this._banner();
    if (el) el.classList.add('show');
  }
  _hideBanner() {
    const el = this._banner();
    if (el) el.classList.remove('show');
  }

  _renderStep() {
    const step = this.steps[this.stepIndex];
    if (!step) return;
    const stepEl = document.getElementById(BANNER_STEP_ID);
    const titleEl = document.getElementById(BANNER_TITLE_ID);
    const progEl = document.getElementById(BANNER_PROGRESS_ID);
    if (stepEl) stepEl.textContent = `STEP ${this.stepIndex + 1} / ${this.steps.length}`;
    if (titleEl) titleEl.textContent = step.title || '';
    if (progEl) {
      // A little segmented progress strip across the whole tutorial.
      progEl.innerHTML = this.steps.map((_, i) =>
        `<i class="${i < this.stepIndex ? 'done' : i === this.stepIndex ? 'cur' : ''}"></i>`).join('');
    }
    this._renderDynamic(step);
    // Pop the banner so a new step visibly "lands".
    const el = this._banner();
    if (el) { el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
  }

  _renderDynamic(step) {
    const bodyEl = document.getElementById(BANNER_BODY_ID);
    const hintEl = document.getElementById(BANNER_HINT_ID);
    if (bodyEl) bodyEl.innerHTML = step.body ? step.body() : '';
    if (hintEl) hintEl.innerHTML = step.hint ? step.hint() : '';
  }
}
