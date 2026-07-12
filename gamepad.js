// ---- Gamepad support (PS3 / DualShock-style and standard-mapping pads) ----------------------
// The flight model is mouse + key driven: `mouse.x/.y` is a steering OFFSET (pitch/yaw rate) and
// the held-key Set drives bound actions (thrust/fire/boost/etc.). To support a controller without
// rewriting any of that, this module reads navigator.getGamepads() each frame and:
//   - writes the RIGHT stick into the same steering-offset the mouse uses (pitch/yaw) — it replaces
//     the mouse, and is inverted on Y by default (toggleable from the Controls menu),
//   - treats the LEFT stick as W/S/A/D: injects the bound thrust/reverse/strafe keys by deflection,
//   - injects SYNTHETIC key codes (e.g. 'KeyW') into the held-key Set for the triggers/face buttons,
//     so they pass straight through the existing bindings + held() checks,
//   - reports edge-triggered presses for one-shot actions (missile, view, route, etc.).
//
// Default mapping: LEFT stick = move (WASD), RIGHT stick = aim (mouse), R2 = fire lasers,
// L2 = fire missiles.
//
// We use the Standard Gamepad mapping (buttons[]/axes[] indices) which Chrome/Edge apply to the
// PS3 controller. Axes: 0=LX 1=LY 2=RX 3=RY. Buttons of interest: 0 A/✕, 1 B/○, 2 X/□, 3 Y/△,
// 4 LB/L1, 5 RB/R1, 6 LT/L2, 7 RT/R2, 8 Back/Select, 9 Start, 10 L3, 11 R3, 12-15 dpad.

const DEADZONE = 0.18;          // stick deadzone so a centred stick reads as zero
const STEER_GAIN = 1.25;        // how hard a full stick deflection steers (matches mouse offset clamp range)

// Apply a radial deadzone + light response curve to a stick axis value.
function curve(v) {
  const a = Math.abs(v);
  if (a < DEADZONE) return 0;
  // Rescale past the deadzone to 0..1 and square for finer control near centre.
  const t = (a - DEADZONE) / (1 - DEADZONE);
  return Math.sign(v) * t * t;
}

export class GamepadInput {
  constructor() {
    this.connected = false;     // true while at least one pad is attached
    this.index = null;          // active pad index
    this._prevButtons = [];     // last frame's pressed-state per button (for edge detection)
    this._justPressed = new Set(); // button indices that went down THIS frame
    this._ownedKeys = new Set();   // synthetic keys the PAD added (so it only ever deletes its own)
    this._label = '';
    this._sawIdle = false;         // pad must be observed fully idle once before it can drive input

    window.addEventListener('gamepadconnected', e => {
      this.index = e.gamepad.index;
      this.connected = true;
      this._label = e.gamepad.id || 'Gamepad';
      this.onConnect?.(this._label);
    });
    window.addEventListener('gamepaddisconnected', e => {
      if (e.gamepad.index === this.index) {
        this.connected = false; this.index = null; this._prevButtons = []; this._sawIdle = false;
        this.onDisconnect?.();
      }
    });
  }

  // Human-readable name of the active pad (for the settings reference panel).
  get label() { return this._label; }

  // Read-only live snapshot of the active pad, for the settings visualizer. Does NOT mutate any
  // steering/key state — purely for display. Returns null when no pad is connected.
  // `buttons` is a bool[] of pressed-state; `axes` is the raw float[] (LX,LY,RX,RY,...).
  readState() {
    const pad = this._resolvePad();
    if (!pad) return null;
    const btn = pad.buttons || [];
    const buttons = btn.map(b => !!(b && (b.pressed || b.value > 0.5)));
    const values = btn.map(b => (b ? b.value : 0));
    return { buttons, values, axes: Array.from(pad.axes || []), label: this._label };
  }

  // Release every synthetic key the pad currently holds. Called when leaving active flight so a
  // held trigger can't stick on — and it ONLY clears keys the pad itself added, never the keyboard's.
  releaseAll(keys) {
    for (const code of this._ownedKeys) keys.delete(code);
    this._ownedKeys.clear();
  }

  // Fire a short haptic rumble on the active pad. `strength` (0..1) scales intensity, `ms` is the
  // pulse length. Used for collision/impact feedback. Tries the modern vibrationActuator.playEffect
  // ('dual-rumble') first, falling back to the older hapticActuators pulse API; both are wrapped in
  // try/catch and silently no-op when the pad/browser doesn't support haptics (so it's always safe).
  rumble(strength = 0.6, ms = 160) {
    const pad = this._resolvePad();
    if (!pad) return;
    const s = Math.max(0, Math.min(1, strength));
    try {
      if (pad.vibrationActuator && pad.vibrationActuator.playEffect) {
        pad.vibrationActuator.playEffect('dual-rumble', {
          duration: ms, startDelay: 0,
          strongMagnitude: s, weakMagnitude: Math.min(1, s * 0.8)
        });
        return;
      }
    } catch {}
    try {
      const acts = pad.hapticActuators;
      if (acts && acts.length && acts[0].pulse) acts[0].pulse(s, ms);
    } catch {}
  }

  // Find the first connected pad if we don't have one yet (covers pads already plugged in before
  // load, which only surface once a button is pressed and getGamepads() is polled).
  _resolvePad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (this.index != null && pads[this.index]) return pads[this.index];
    for (const p of pads) {
      // Only adopt a pad that looks REAL: connected, with a button array and a recognizable id or
      // standard mapping. Some browsers (especially inside an iframe preview) expose a zero-state
      // phantom pad entry; adopting it would flip `connected` on and let the poll's synthetic-key
      // release start clobbering real keyboard holds. Ignore those ghosts.
      if (p && p.connected && p.buttons && p.buttons.length && (p.mapping === 'standard' || (p.id && p.id.trim()))) {
        this.index = p.index; this.connected = true;
        if (!this._label) { this._label = p.id || 'Gamepad'; this.onConnect?.(this._label); }
        return p;
      }
    }
    return null;
  }

  // Poll once per frame. `aim` is the live steering-offset object (the same {x,y} the mouse writes);
  // `keys` is the held-key Set. We mutate both so the existing flight model picks up controller input
  // with zero changes elsewhere. `bindingFor(action)` returns the first KeyboardEvent.code bound to
  // an action, so synthetic presses honour the player's actual keybindings.
  // Returns true if the controller produced any steering this frame (so the mouse recenter can be
  // skipped, otherwise it would fight the stick back to centre).
  poll(aim, keys, bindingFor, opts = {}) {
    const pad = this._resolvePad();
    this._justPressed.clear();
    if (!pad) return false;

    const ax = pad.axes || [];
    const btn = pad.buttons || [];
    const down = i => !!(btn[i] && (btn[i].pressed || btn[i].value > 0.5));
    // Analog triggers (L2/R2) are pressure axes that can REST at a small nonzero value (or report a
    // spurious `pressed` on some pads/phantom standard mappings in an iframe). Treat them as held only
    // when clearly squeezed PAST a firm threshold — never off a stray resting value — so the fire
    // trigger can't latch on with no real input. Falls back to `down()` if the pad exposes no value.
    const TRIGGER_ON = 0.55;
    const triggerDown = i => {
      const b = btn[i];
      if (!b) return false;
      if (typeof b.value === 'number') return b.value > TRIGGER_ON;
      return !!b.pressed;
    };

    // ---- Edge detection for one-shot buttons (triggers use the firm analog threshold) ----
    for (let i = 0; i < btn.length; i++) {
      const now = (i === 6 || i === 7) ? triggerDown(i) : down(i);
      if (now && !this._prevButtons[i]) this._justPressed.add(i);
      this._prevButtons[i] = now;
    }

    // ---- Real-activity gate (anti-phantom / anti-stuck-trigger) ----
    // Some browsers expose a ghost "standard" pad inside an iframe whose axes/buttons report stale,
    // non-zero RESTING values (e.g. a trigger sitting at value 1, or a stick pinned off-centre). That
    // would silently drive thrust/fire forever with no human input. We refuse to inject ANY held key
    // until the pad proves it's real by going from idle -> active at least once: every button fully
    // released (incl. triggers under a low threshold) AND both sticks centred. Until that idle frame
    // is observed, the pad's held-action output is suppressed.
    const TRIGGER_IDLE = 0.2, STICK_IDLE = 0.3;
    let anyButtonHeld = false;
    for (let i = 0; i < btn.length; i++) {
      const b = btn[i];
      if (!b) continue;
      const v = (typeof b.value === 'number') ? b.value : (b.pressed ? 1 : 0);
      if (b.pressed || v > TRIGGER_IDLE) { anyButtonHeld = true; break; }
    }
    const sticksCentred =
      Math.abs(ax[0] || 0) < STICK_IDLE && Math.abs(ax[1] || 0) < STICK_IDLE &&
      Math.abs(ax[2] || 0) < STICK_IDLE && Math.abs(ax[3] || 0) < STICK_IDLE;
    if (!anyButtonHeld && sticksCentred) this._sawIdle = true;
    // Until the pad has been seen fully idle once, treat it as not-yet-trusted: don't drive movement
    // or fire from it (so a phantom/stuck pad can never auto-fire). Steering still self-zeroes below.
    const trusted = !!this._sawIdle;

    // ---- Aim/steer: RIGHT stick -> pitch/yaw offset (same channel as the mouse) ----
    // The right stick replaces the mouse: it writes the live steering offset. Inverted on Y by
    // default (classic flight-stick feel) — both axes are toggleable from the Controls menu.
    const rx = curve(ax[2] || 0);
    const ry = curve(ax[3] || 0);
    const invX = opts.invertX ? -1 : 1;
    const invY = opts.invertY ? -1 : 1;
    // Per-axis sensitivity multipliers (1.0 == the original feel), from the Controls menu.
    const sensX = opts.sensX != null ? opts.sensX : 1;
    const sensY = opts.sensY != null ? opts.sensY : 1;
    let steered = false;
    if (trusted && (rx || ry)) {
      // Write an absolute offset (not incremental) so the stick position maps directly to turn rate,
      // and clamp to the same range the mouse uses. Gated by `trusted` so a phantom pad with a pinned
      // stick can't steer before the player ever touches the controller.
      aim.x = Math.max(-1.4, Math.min(1.4, rx * STEER_GAIN * sensX * invX));
      aim.y = Math.max(-1.4, Math.min(1.4, ry * STEER_GAIN * sensY * invY));
      steered = true;
    }

    // ---- Held-action binder ----
    // CRITICAL: only DELETE a key the controller itself added (tracked in _ownedKeys). Otherwise an
    // un-pressed controller button would delete the matching key every frame and clobber the player's
    // KEYBOARD hold (e.g. the pad's idle R2 wiping out a held W). We never remove a key the keyboard owns.
    // `kbHeld` is the set of keys the PHYSICAL keyboard is holding right now. The pad must NEVER
    // delete one of those, even if it had previously claimed ownership of that code — otherwise an
    // idle/phantom pad releasing its synthetic thrust wipes a real, still-held W (the root cause of
    // the "thrust randomly drops" bug). We only ever remove a synthetic key the pad owns AND that the
    // keyboard is not currently holding.
    const kbHeld = opts.kbHeld;
    const bind = (action, isDown) => {
      const code = bindingFor(action);
      if (!code) return;
      if (isDown) { keys.add(code); this._ownedKeys.add(code); }
      else if (this._ownedKeys.has(code)) {
        this._ownedKeys.delete(code);
        if (!(kbHeld && kbHeld.has(code))) keys.delete(code);
      }
    };

    // ---- Movement: LEFT stick acts as W/S/A/D (thrust/reverse/strafe-left/strafe-right) ----
    // The left stick is treated like the WASD keys: deflect up = thrust, down = reverse, left/right
    // = strafe. We use a slightly larger movement deadzone than the analog aim curve so a near-centred
    // stick doesn't dribble thrust, then inject the bound movement keys just like the keyboard.
    const MOVE_DZ = 0.45;
    const lx = ax[0] || 0;
    const ly = ax[1] || 0;
    bind('thrust',      trusted && ly < -MOVE_DZ);   // stick up    -> W
    bind('reverse',     trusted && ly >  MOVE_DZ);   // stick down  -> S
    bind('strafeLeft',  trusted && lx < -MOVE_DZ);   // stick left  -> A
    bind('strafeRight', trusted && lx >  MOVE_DZ);   // stick right -> D

    // ---- Fire: RIGHT trigger (R2, button 7) fires lasers; LEFT trigger handled as a one-shot below.
    // Uses the firm analog threshold so a resting/jittery trigger can NEVER auto-fire, and is gated by
    // the real-activity check so a phantom/stuck pad can't drive it before the player ever touches it.
    bind('fire', trusted && triggerDown(7));

    // ---- Boost: hold R3/L3 stick-click — a comfortable afterburner hold ----
    bind('boost', trusted && (down(11) || down(10)));

    // Until the pad is trusted, suppress one-shot edges too (so a phantom can't fire a missile or
    // flip a power route before the player has touched the controller).
    if (!trusted) this._justPressed.clear();

    this._connectedNow = pad.connected;
    return steered;
  }

  // Edge-triggered one-shots for THIS frame. Call after poll(). Returns an object the caller maps
  // to its discrete actions (missile, view toggle, power routes, target lock/cycle, chaff, pause).
  pressed() {
    const jp = this._justPressed;
    return {
      missile:   jp.has(6) || jp.has(1), // L2 trigger (primary) or B / ○ -> fire missile
      view:      jp.has(3),          // Y / △  -> toggle view
      chaff:     jp.has(2),          // X / □  -> deploy chaff
      lockTarget: jp.has(9),         // Start  -> lock nearest
      cycleTarget: jp.has(8),        // Select -> cycle target
      routeShields: jp.has(14) || jp.has(4),  // dpad-left  / L1 -> shields
      routeWeapons: jp.has(0),       // A / ✕      -> weapons
      routeEngines: jp.has(15) || jp.has(5),  // dpad-right / R1 -> engines
    };
  }
}
