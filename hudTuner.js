// ---------------------------------------------------------------------------
// HUD layout tuner (DEV) — direct-manipulation edition.
//
// A live editor for repositioning/resizing the three cockpit dashboard overlays
// (System Power, Targeting Scope, Target Data) by MOUSE:
//   - Left-drag anywhere on the selected overlay to MOVE it (drag & drop).
//   - Hold SHIFT and drag to RESIZE the selected overlay instead.
//   - Press 1 / 2 / 3 (or click a row) to cycle which overlay is selected.
//   - An on-panel Exit button (or K) closes the tuner and restores flight.
// The selected overlay gets a highlighted outline so it's obvious what you're
// editing. Purely a development aid — it only mutates inline styles on the live
// elements and never touches gameplay. main.js gates all flight input while it's
// open (see hudTuner.on / onToggle).
// ---------------------------------------------------------------------------

const $ = id => document.getElementById(id);

// Each tunable panel: the live element, which horizontal edge anchors it (left vs right),
// and a friendly label. Values are read/written as viewport percentages to match the CSS.
const PANELS = [
  { id: 'sys',          label: 'System Power',    sel: '.sys',         edge: 'left' },
  { id: 'targetScope',  label: 'Targeting Scope', sel: '#targetScope', edge: 'centerX', noHeight: true, vCenter: true },
  { id: 'target',       label: 'Target Data',     sel: '.target',      edge: 'right' },
];

export class HudTuner {
  constructor() {
    this.on = false;
    this.sel = 0;            // index into PANELS
    this.box = null;         // the control panel element
    this.outline = null;     // highlight ring drawn over the selected overlay
    this.onToggle = null;    // host hook: fired on open/close so flight input can freeze
    // Active mouse drag state.
    this._drag = null;       // { mode:'move'|'resize', startX, startY, geom }
    this._build();
    // Global mouse listeners (only act while a drag is in progress / tuner open).
    window.addEventListener('mousedown', e => this._onDown(e), true);
    window.addEventListener('mousemove', e => this._onMove(e), true);
    window.addEventListener('mouseup',  e => this._onUp(e),   true);
    window.addEventListener('resize', () => { if (this.on) this._refresh(); });
    // Re-apply any saved layout for the starting cockpit so tuned positions survive a page reload
    // (they're stored per cockpit in localStorage on every drag — see _persist / _restoreForCockpit).
    this.syncCockpit();
  }

  // localStorage key for a given cockpit + panel. Layouts are saved PER cockpit frame so each ship
  // keeps its own tuned positions across reloads without a bake step.
  _storeKey(cockpit, panelId) { return `hudTuner:${cockpit}:${panelId}`; }

  // Persist one panel's current geometry for the active cockpit. Called at the end of every drag so
  // what you dragged is exactly what re-appears on the next launch (no inline-vs-CSS drift).
  _persist(p) {
    try {
      const g = this._read(p);
      if (!g) return;
      localStorage.setItem(this._storeKey(this._cockpitKey(), p.id), JSON.stringify(g));
    } catch {}
  }

  // Re-apply every saved panel layout for the CURRENT cockpit (if any). Called on construction and
  // whenever the active cockpit changes, so switching ships restores that frame's tuned layout.
  syncCockpit() {
    for (const p of PANELS) {
      let raw = null;
      try { raw = localStorage.getItem(this._storeKey(this._cockpitKey(), p.id)); } catch {}
      const el = this._el(p);
      if (!el) continue;
      if (raw) {
        try { this._apply(p, JSON.parse(raw)); continue; } catch {}
      }
      // No saved override for this cockpit → clear any inline styles so the CSS block takes over.
      el.style.top = el.style.left = el.style.right = el.style.width = el.style.height = '';
    }
    if (this.on) this._refresh();
  }

  // Wipe the saved layout for the active cockpit and fall back to the CSS block (tuner reset button).
  _resetCockpit() {
    for (const p of PANELS) {
      try { localStorage.removeItem(this._storeKey(this._cockpitKey(), p.id)); } catch {}
    }
    this.syncCockpit();
    this._flashSave('Layout reset to CSS default for this cockpit ✓');
  }

  _el(p) { return document.querySelector(p.sel); }

  // The --hud-u unit (px) the HUD text scales on, read live from :root. Panel width/height are
  // tracked/written in MULTIPLES of this unit so the box scales on the same curve as its text; the
  // CSS uses calc(var(--hud-u) * n), so the readout n's paste straight back in.
  _hudU() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--hud-u');
    const px = parseFloat(v);
    return (isFinite(px) && px > 0) ? px : 14;   // sane fallback if the var can't be read
  }

  // Parse an inline width/height value back into --hud-u multiples so a drag's intended size round-
  // trips even when the flex content would clamp the measured box. Handles the two forms we ever
  // write: "calc(var(--hud-u) * n)" (→ n) and a plain "NNpx" (→ NN/u). Returns null for anything
  // else (e.g. empty string) so the caller falls back to the measured rect.
  _unitFromStyle(val, u) {
    if (!val) return null;
    const m = /\*\s*([0-9.]+)\s*\)/.exec(val);          // calc(var(--hud-u) * n)
    if (m) { const n = parseFloat(m[1]); return isFinite(n) ? n : null; }
    const px = /([0-9.]+)px/.exec(val);                  // fallback: raw px
    if (px) { const n = parseFloat(px[1]); return (isFinite(n) && u > 0) ? n / u : null; }
    return null;
  }

  // Read a panel's current geometry. Position (top/left/right/centerX) is in viewport %; the box
  // dimensions (width/height) are in --hud-u units so they synchronize with the text scaling.
  _read(p) {
    const el = this._el(p);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    // vCenter panels use transform:translate(-50%,-50%), so their CSS `top` is the element's
    // CENTER, not its top edge. Read/write the center for those so the value round-trips exactly.
    const top = p.vCenter ? ((r.top + r.height / 2) / vh) * 100 : (r.top / vh) * 100;
    // Box dimensions are in --hud-u units so the frame scales on the same curve as the text inside.
    // IMPORTANT: prefer the element's INLINE style width/height (the value we set on drag) over the
    // measured rect. The panels are flex containers with nowrap content, so getBoundingClientRect()
    // can be clamped UP to the content's min-width — measuring back would silently discard a shrink
    // and make "resize smaller" look like it never saved. Reading the intended calc() value round-
    // trips the drag exactly; we only fall back to the measured rect when there's no inline size.
    const u = this._hudU();
    const width = this._unitFromStyle(el.style.width, u) ?? (r.width / u);
    const height = this._unitFromStyle(el.style.height, u) ?? (r.height / u);
    let h = {};
    if (p.edge === 'left') h.left = (r.left / vw) * 100;
    else if (p.edge === 'right') h.right = ((vw - r.right) / vw) * 100;
    else h.centerX = ((r.left + r.width / 2) / vw) * 100;
    return { top, width, height, ...h };
  }

  // Apply a geometry object back to the element via inline styles. Position in %; width/height as
  // calc(var(--hud-u) * n) so the inline style matches the em-based CSS scaling model.
  _apply(p, g) {
    const el = this._el(p);
    if (!el) return;
    el.style.top = g.top.toFixed(2) + '%';
    el.style.width = `calc(var(--hud-u) * ${g.width.toFixed(2)})`;
    if (!p.noHeight && g.height != null) el.style.height = `calc(var(--hud-u) * ${g.height.toFixed(2)})`;
    if (p.edge === 'left') { el.style.left = g.left.toFixed(2) + '%'; el.style.right = 'auto'; }
    else if (p.edge === 'right') { el.style.right = g.right.toFixed(2) + '%'; el.style.left = 'auto'; }
    else if (p.edge === 'centerX') { el.style.left = g.centerX.toFixed(2) + '%'; }
  }

  // Update the readout text + selection highlight in the control box, and reposition the outline.
  // Dimension readouts print as "×n" (--hud-u multiples) so they paste straight into the CSS calc().
  _refresh() {
    if (!this.box) return;
    const ck = $('ht-cockpit');
    if (ck) ck.textContent = `cockpit: ${this._cockpitKey()}`;
    PANELS.forEach((p, i) => {
      const row = $('ht-row-' + p.id);
      if (row) row.classList.toggle('sel', i === this.sel);
      const g = this._read(p);
      const out = $('ht-val-' + p.id);
      if (g && out) {
        const edge = p.edge === 'left' ? `left:${g.left.toFixed(1)}%`
                   : p.edge === 'right' ? `right:${g.right.toFixed(1)}%`
                   : `center:${g.centerX.toFixed(1)}%`;
        const dims = p.noHeight ? `w:×${g.width.toFixed(1)}`
                   : `w:×${g.width.toFixed(1)} · h:×${g.height.toFixed(1)}`;
        out.textContent = `top:${g.top.toFixed(1)}% · ${edge} · ${dims}`;
      }
    });
    this._positionOutline();
  }

  // Draw the highlight ring over the currently selected overlay so it's obvious what's being edited.
  _positionOutline() {
    if (!this.outline) return;
    const el = this._el(PANELS[this.sel]);
    if (!el) { this.outline.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    this.outline.style.display = 'block';
    this.outline.style.left = r.left + 'px';
    this.outline.style.top = r.top + 'px';
    this.outline.style.width = r.width + 'px';
    this.outline.style.height = r.height + 'px';
  }

  _select(i) {
    this.sel = ((i % PANELS.length) + PANELS.length) % PANELS.length;
    this._refresh();
  }

  // The active cockpit's layout key (set on <body data-cockpit> by applyCockpitForShip in main.js).
  // Frame "a" is the default/base layout, so its snapshot uses the bare selectors; every other frame
  // gets cockpit-scoped selectors so its block is independent. Falls back to 'a' if unset.
  _cockpitKey() { return document.body?.dataset?.cockpit || 'a'; }

  // Capture the current layout of every panel as a copy-paste-ready CSS snapshot. Position values
  // are viewport %; box dimensions are printed as calc(var(--hud-u) * n) to match the em-based CSS.
  // Selectors are scoped to the ACTIVE cockpit frame (body[data-cockpit="KEY"] .sys, etc.) so each
  // ship's frame is tuned independently — frame "a" stays as the bare base rules. The snapshot is
  // copied to the clipboard AND logged to the console, then a confirmation flashes in the panel.
  // Paste it back to Rosie to bake it into the matching PER-COCKPIT block in index.html.
  _exportLayout() {
    const key = this._cockpitKey();
    const scope = key === 'a' ? '' : `body[data-cockpit="${key}"] `;
    const lines = [`/* HUD LAYOUT SNAPSHOT — cockpit "${key}" — paste to Rosie to save into index.html */`];
    for (const p of PANELS) {
      const g = this._read(p);
      if (!g) continue;
      const parts = [`top:${g.top.toFixed(2)}%`];
      if (p.edge === 'left') parts.push(`left:${g.left.toFixed(2)}%`);
      else if (p.edge === 'right') parts.push(`right:${g.right.toFixed(2)}%`);
      else parts.push(`left:${g.centerX.toFixed(2)}% /* center */`);
      parts.push(`width:calc(var(--hud-u) * ${g.width.toFixed(2)})`);
      if (!p.noHeight) parts.push(`height:calc(var(--hud-u) * ${g.height.toFixed(2)})`);
      lines.push(`${scope}${p.sel} { ${parts.join('; ')}; }`);
    }
    const snapshot = lines.join('\n');
    // Console is ALWAYS a reliable copy path, even when the async Clipboard API is blocked in the
    // sandboxed preview iframe (which can leave writeText() pending and make the button feel frozen).
    console.log(snapshot);
    // Expose the last snapshot for easy manual grab from the console if needed.
    this.lastSnapshot = snapshot;
    // Try a synchronous execCommand('copy') via a temporary textarea first — it can't hang. If that
    // reports success we're done; otherwise fall back to the async API opportunistically (fire and
    // forget, never awaited) so a stuck promise can't lock the UI.
    let copied = this._copySync(snapshot);
    if (!copied) {
      try { navigator.clipboard?.writeText?.(snapshot).then(() => {}, () => {}); } catch {}
    }
    this._flashSave(copied ? 'Layout copied to clipboard ✓ — paste it to Rosie' : 'Layout logged to console ✓ — copy it from there');
  }

  // Synchronous clipboard copy that cannot hang (unlike the async Clipboard API). Returns true on
  // reported success. Uses a temporary off-screen textarea + document.execCommand('copy').
  _copySync(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch {
      return false;
    }
  }

  _flashSave(msg) {
    const el = $('ht-saveMsg');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(this._saveMsgT);
    this._saveMsgT = setTimeout(() => { el.hidden = true; }, 3200);
  }

  _build() {
    // Highlight ring over the selected overlay (added to body, positioned in viewport px).
    const outline = document.createElement('div');
    outline.id = 'htOutline';
    outline.style.display = 'none';
    document.body.appendChild(outline);
    this.outline = outline;

    const box = document.createElement('div');
    box.id = 'hudTuner';
    box.innerHTML = `
      <div class="htHead">HUD LAYOUT TUNER <span class="htHint">1/2/3 select</span><span class="htCockpit" id="ht-cockpit"></span></div>
      ${PANELS.map((p, i) => `
        <div class="htRow" id="ht-row-${p.id}" data-idx="${i}">
          <div class="htName"><span class="htKey">${i + 1}</span> ${p.label}</div>
          <div class="htVal" id="ht-val-${p.id}"></div>
        </div>`).join('')}
      <div class="htTip"><b>Left-drag</b> the highlighted overlay to move it. Hold <b>Shift</b> + drag to resize. When it looks right, hit <b>Save Layout</b> — the snapshot is copied to your clipboard; paste it back to Rosie to bake in.</div>
      <div class="htSaveMsg" id="ht-saveMsg" hidden></div>
      <div class="htFoot"><button data-act="save" class="htSave">💾 SAVE LAYOUT</button><button data-act="reset" class="htReset">↺ RESET</button><button data-act="exit" class="htExit">✕ EXIT (K)</button></div>`;
    document.body.appendChild(box);
    this.box = box;

    // Row click selects that overlay; Save exports the layout; Exit closes the tuner.
    box.addEventListener('click', e => {
      const btn = e.target.closest('button');
      if (btn && btn.dataset.act === 'save') { this._exportLayout(); return; }
      if (btn && btn.dataset.act === 'reset') { this._resetCockpit(); return; }
      if (btn && btn.dataset.act === 'exit') { this.close(); return; }
      const row = e.target.closest('.htRow');
      if (row) this._select(parseInt(row.dataset.idx, 10));
    });
    // Keep clicks on the control box from starting an overlay drag.
    box.addEventListener('mousedown', e => e.stopPropagation());
  }

  // ---- Mouse drag/drop + shift-resize on the selected overlay ----
  // A press ARMS a potential drag; the mode (move vs resize) is locked in at press time from the
  // live Shift state, and NOTHING is applied until the pointer actually moves past a small
  // threshold. That way a plain click never nudges or resizes the panel — it only reacts to a real
  // drag. This fixes the "resizes itself on the first click after releasing Shift" bug.
  _onDown(e) {
    if (!this.on || e.button !== 0) return;
    // Ignore presses on the tuner control box itself (its buttons/rows handle their own clicks).
    if (this.box && this.box.contains(e.target)) return;
    const p = PANELS[this.sel];
    const g = this._read(p);
    if (!g) return;
    this._drag = {
      mode: e.shiftKey ? 'resize' : 'move',   // locked at press time — later Shift changes don't switch it
      startX: e.clientX, startY: e.clientY,
      geom: g,
      active: false,                          // becomes true only once the pointer moves past DRAG_THRESHOLD
    };
    e.preventDefault();
    e.stopPropagation();
  }

  _onMove(e) {
    if (!this.on || !this._drag) return;
    const p = PANELS[this.sel];
    const vw = window.innerWidth, vh = window.innerHeight;
    const dxPx = e.clientX - this._drag.startX;
    const dyPx = e.clientY - this._drag.startY;
    // Don't touch the panel until this is clearly a drag, not a click (avoids a 1px click nudge).
    const DRAG_THRESHOLD = 3;
    if (!this._drag.active && Math.abs(dxPx) < DRAG_THRESHOLD && Math.abs(dyPx) < DRAG_THRESHOLD) {
      e.preventDefault(); e.stopPropagation(); return;
    }
    this._drag.active = true;
    const g = { ...this._drag.geom };
    if (this._drag.mode === 'move') {
      // Position is in viewport %: convert the pixel drag delta to %.
      g.top += (dyPx / vh) * 100;
      if (p.edge === 'left') g.left += (dxPx / vw) * 100;
      else if (p.edge === 'right') g.right -= (dxPx / vw) * 100;   // right-anchored: dragging right reduces the right inset
      else g.centerX += (dxPx / vw) * 100;
    } else {
      // Resize: width/height are in --hud-u units, so convert the pixel drag delta to those units.
      const u = this._hudU();
      g.width = Math.max(2, g.width + dxPx / u);
      if (!p.noHeight) g.height = Math.max(2, (g.height || 0) + dyPx / u);
    }
    this._apply(p, g);
    this._refresh();
    e.preventDefault();
    e.stopPropagation();
  }

  _onUp(e) {
    if (!this._drag) return;
    // Persist the final position/size for this cockpit so the drag survives a reload exactly.
    if (this._drag.active) this._persist(PANELS[this.sel]);
    this._drag = null;
    e.preventDefault();
    e.stopPropagation();
  }

  // Keyboard handling while the tuner is open. Returns true if it consumed the key.
  handleKey(e) {
    if (!this.on) return false;
    switch (e.code) {
      case 'Digit1': case 'Numpad1': this._select(0); break;
      case 'Digit2': case 'Numpad2': this._select(1); break;
      case 'Digit3': case 'Numpad3': this._select(2); break;
      default: return false;
    }
    e.preventDefault();
    return true;
  }

  open()  { if (!this.on) this.toggle(); }
  close() { if (this.on) this.toggle(); }

  toggle() {
    this.on = !this.on;
    this.box.classList.toggle('show', this.on);
    this._drag = null;
    if (this.on) { this._refresh(); }
    else if (this.outline) { this.outline.style.display = 'none'; }
    if (typeof this.onToggle === 'function') this.onToggle(this.on);
  }
}
