// ---------------------------------------------------------------------------
// Localized, time-synced caption system.
//
// Replaces the old "one text block per clip" approach with phrase-level cues that
// are driven off the ACTUAL audio playback position (HTMLMediaElement.currentTime),
// so subtitles surface in sync with the voice-over and self-correct on stall/skip.
//
// LOCALIZATION
//   Caption data lives in LOCALES[lang]. Each locale maps a clip's asset URL to a
//   { speaker, cues } entry, where `cues` is an ordered list of timed segments:
//       { start, end, t }   // seconds relative to clip start; `t` is the line text
//   `setLocale('es')` swaps the whole table; lines a locale doesn't translate fall
//   back to English so nothing spoken ever goes silent.
//
// SYNC MODEL
//   captions.attach(url, audioEl) binds to the real <audio> element and, every frame
//   (and on timeupdate), shows the cue whose [start,end) window contains currentTime.
//   No cue active -> nothing shown. This keeps captions phrase-accurate even if the
//   browser delays/stalls playback, and a skip/stop clears them instantly.
// ---------------------------------------------------------------------------

// Speaker tags reused across locales so translations only restate the spoken text.
const SP = { OVERWATCH: 'OVERWATCH', SLICK: 'SLICK', OG: 'O.G.', SCAAVI: 'SCAAVI', COMMS: 'COMMS' };

// Build a single-cue entry from a whole line, auto-timed across a clip of `dur` seconds
// (used when we only have the full line, not hand-split phrase timings).
function whole(speaker, text, dur = 0) {
  return { speaker, cues: [{ start: 0, end: dur || 9999, t: text }] };
}
// Build a multi-cue entry from [startSec, text] pairs. Each cue runs until the next
// cue's start (the last runs to the end of the clip).
function timed(speaker, segments, dur = 0) {
  const cues = segments.map(([start, t], i) => ({
    start,
    end: i + 1 < segments.length ? segments[i + 1][0] : (dur || start + 6),
    t,
  }));
  return { speaker, cues };
}

// --- ENGLISH (base locale) -------------------------------------------------------
// Phrase timings are authored to track the cadence of each VO clip. Longer briefing
// lines are split into 2-3 cues so the caption advances with the speech instead of
// dumping the whole sentence at once.
const EN = {
  // Overwatch intro briefing (~8s) — split into three beats.
  'assets/audio/voice/overwatch/eeac731a_60bac1d3-b_v2.mp3': timed(SP.OVERWATCH, [
    [0.0, 'Mamba, this is Overwatch.'],
    [2.4, 'Hammer Squadron is cleared hot —'],
    [4.8, 'watch your six and bring them home.'],
  ], 8.0),

  // Mission 1 briefing / debrief.
  'assets/audio/voice/overwatch/mission1.mp3': timed(SP.OVERWATCH, [
    [0.0, 'Hostiles inbound.'],
    [1.8, 'Engage the enemy fighters and hold the line, Mamba.'],
  ], 4.6),
  'assets/audio/voice/overwatch/mission1done.mp3': timed(SP.OVERWATCH, [
    [0.0, 'Skies are clear. Good shooting, Mamba —'],
    [2.6, 'jump to the rendezvous and refit.'],
  ], 5.0),

  // Mission 2 briefing — one short line per clip, so each is a single tight cue.
  'assets/audio/voice/overwatch/mission2b/minssion2b1.mp3': whole(SP.OVERWATCH, 'Mamba, we have a new tasking. Listen up.'),
  'assets/audio/voice/overwatch/mission2b/mission2b2.mp3': whole(SP.OVERWATCH, 'An enemy Dreadnought is shielded by a pair of generators.'),
  'assets/audio/voice/overwatch/mission2b/mission2b3.mp3': whole(SP.OVERWATCH, 'Those shields are too strong to punch through directly.'),
  'assets/audio/voice/overwatch/mission2b/mission2b4.mp3': whole(SP.OVERWATCH, 'Take down both shield generators to drop its protection.'),
  'assets/audio/voice/overwatch/mission2b/mission2b5.mp3': whole(SP.OVERWATCH, 'Slick and O.G. will run strafing passes on the generators.'),
  'assets/audio/voice/overwatch/mission2b/mission2b6.mp3': whole(SP.OVERWATCH, 'Cover your wingmen and keep the fighters off their backs.'),
  'assets/audio/voice/overwatch/mission2b/mission2b7.mp3': whole(SP.OVERWATCH, 'Once the shields are down, hit the Dreadnought with everything you have.'),
  'assets/audio/voice/overwatch/mission2b/mission2b8.mp3': whole(SP.OVERWATCH, 'Hammer Squadron, you are cleared to engage. Good hunting.'),
  'assets/audio/voice/overwatch/mission2b/mission-end/overwatchm2final1.mp3': whole(SP.OVERWATCH, 'The Dreadnought is breaking up — outstanding work, Hammer Squadron.'),
  'assets/audio/voice/overwatch/mission2b/mission-end/overwatchm2final2.mp3': whole(SP.OVERWATCH, 'Form up and stand by for your next jump, Mamba.'),

  // Wingman comms.
  'assets/audio/voice/mission-2/slickm2intro.mp3': whole(SP.SLICK, "Mamba, Slick here — on your wing and ready to rumble."),
  'assets/audio/voice/mission-2/ogintrom2.mp3': whole(SP.OG, "O.G. forming up. Let's take these generators apart."),
  'assets/audio/voice/mission-2/dreaddownm2.mp3': whole(SP.SLICK, 'That Dreadnought is going down! Nice work, Mamba!'),
  'assets/audio/voice/mission-2/slickm2struggle.mp3': whole(SP.SLICK, "I've got one on me — could use a hand over here!"),
  'assets/audio/voice/mission-2/slickhitm2.mp3': whole(SP.SLICK, "I'm hit! Taking fire — break them off me!"),
  'assets/audio/voice/mission-2/oghangonslick.mp3': whole(SP.OG, "Hang on, Slick — I'm coming around!"),
  'assets/audio/voice/mission-2/ogtheykeepcomingm2.mp3': whole(SP.OG, 'They just keep coming! Stay sharp, Mamba!'),

  // Scaavi alert.
  'assets/audio/voice/scaavi/scaavishieldsfailing.mp3': whole(SP.SCAAVI, 'Shields are failing — get me some breathing room!'),
};

// Shield-generator destruction barks: many clips, captioned by speaker + an accurate
// paraphrase (first gen = Slick, second gen = O.G.). Filled by the host once it knows
// the clip lists (see registerGenClips).
function _fillGenBarks(table, slickClips, ogClips) {
  for (const u of slickClips || []) table[u] = whole(SP.SLICK, "Generator's down! That's one shield offline!");
  for (const u of ogClips || []) table[u] = whole(SP.OG, 'Second generator is toast — shields are dropping!');
}

// --- SPANISH (example secondary locale; proves the localization layer) -----------
// Only restates spoken text; speakers/timings inherit from the English entry shape
// via the merge in `localeFor`. Lines not present here fall back to English.
const ES = {
  'assets/audio/voice/overwatch/eeac731a_60bac1d3-b_v2.mp3': timed(SP.OVERWATCH, [
    [0.0, 'Mamba, aquí Vigía.'],
    [2.4, 'El Escuadrón Martillo tiene luz verde —'],
    [4.8, 'cuida tu retaguardia y tráelos de vuelta.'],
  ], 8.0),
  'assets/audio/voice/overwatch/mission1.mp3': timed(SP.OVERWATCH, [
    [0.0, 'Hostiles entrantes.'],
    [1.8, 'Enfrenta a los cazas y mantén la línea, Mamba.'],
  ], 4.6),
  'assets/audio/voice/overwatch/mission1done.mp3': whole(SP.OVERWATCH, 'Cielo despejado. Buen disparo, Mamba — salta al punto de reunión.'),
  'assets/audio/voice/mission-2/slickm2intro.mp3': whole(SP.SLICK, 'Mamba, soy Slick — en tu ala y listo para la acción.'),
  'assets/audio/voice/mission-2/ogintrom2.mp3': whole(SP.OG, 'O.G. formando. Vamos a desmantelar esos generadores.'),
  'assets/audio/voice/scaavi/scaavishieldsfailing.mp3': whole(SP.SCAAVI, '¡Los escudos están cayendo — dame algo de espacio!'),
};

const LOCALES = { en: EN, es: ES };

// ---------------------------------------------------------------------------
// Caption controller. Construct once with a render callback:
//   new Captions({
//     render: (speaker, text) => { ...show... },   // text='' => hide
//     enabled: () => settings.subtitles,            // gate (re-checked live)
//   })
// ---------------------------------------------------------------------------
export class Captions {
  constructor({ render, enabled, locale = 'en' } = {}) {
    this._render = render || (() => {});
    this._enabled = enabled || (() => true);
    this._locale = locale;
    this._slickGen = [];
    this._ogGen = [];
    this._el = null;          // currently-attached <audio>
    this._entry = null;       // active caption entry { speaker, cues }
    this._cueIdx = -1;        // index of the cue currently shown (-1 = none)
    this._onTime = null;      // bound timeupdate handler
    this._raf = 0;            // rAF id for the per-frame sync loop
    this._curText = '';       // last text pushed to render (dedupe)
  }

  setLocale(lang) { if (LOCALES[lang]) this._locale = lang; }
  get locale() { return this._locale; }
  availableLocales() { return Object.keys(LOCALES); }

  // Tell the system which clip URLs are the (randomized) shield-generator barks so they
  // get captioned too. Called once from the host after those lists are defined.
  registerGenClips(slickClips, ogClips) {
    this._slickGen = slickClips || [];
    this._ogGen = ogClips || [];
  }

  // Resolve a clip's caption entry for the active locale, falling back to English, then
  // to the gen-bark fill. Returns null when the clip has no caption.
  _lookup(url) {
    const loc = LOCALES[this._locale] || EN;
    if (loc[url]) return loc[url];
    if (EN[url]) return EN[url];
    // Gen barks (kept out of the static tables since the lists live in the host).
    if (this._slickGen.includes(url)) return whole(SP.SLICK, "Generator's down! That's one shield offline!");
    if (this._ogGen.includes(url)) return whole(SP.OG, 'Second generator is toast — shields are dropping!');
    return null;
  }

  // Attach to a freshly-started clip. `audioEl` is the HTMLMediaElement returned by the
  // audio layer; we read its currentTime to drive cue selection. Safe to call with a
  // null/unknown clip (it simply clears any active caption).
  attach(url, audioEl) {
    this.clear();
    if (!this._enabled()) return;
    const entry = this._lookup(url);
    if (!entry || !audioEl) return;
    this._el = audioEl;
    this._entry = entry;
    this._cueIdx = -1;
    // Drive off both timeupdate (coarse, reliable) and rAF (smooth) for tight sync.
    this._onTime = () => this._sync();
    audioEl.addEventListener('timeupdate', this._onTime);
    audioEl.addEventListener('ended', this._onEnded = () => this.clear());
    const loop = () => {
      if (!this._el) return;
      this._sync();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
    this._sync();   // show the opening cue immediately
  }

  // Pick the cue covering the element's current playback time and render it.
  _sync() {
    if (!this._el || !this._entry) return;
    if (!this._enabled()) { this._push('', ''); return; }
    const t = this._el.currentTime || 0;
    const cues = this._entry.cues;
    let idx = -1;
    for (let i = 0; i < cues.length; i++) {
      if (t >= cues[i].start && t < cues[i].end) { idx = i; break; }
    }
    // Before the first cue's start, hold the first line so the caption isn't blank on a
    // slow audio start; after the last cue's end, clear.
    if (idx === -1 && t < cues[0].start) idx = 0;
    if (idx === this._cueIdx) return;
    this._cueIdx = idx;
    if (idx === -1) this._push('', '');
    else this._push(this._entry.speaker, cues[idx].t);
  }

  // Render with dedupe so we don't thrash the DOM every frame.
  _push(speaker, text) {
    if (text === this._curText) return;
    this._curText = text;
    this._render(speaker, text);
  }

  // Detach from the current clip and hide the caption. Call on stop/skip/scene change.
  clear() {
    if (this._el) {
      if (this._onTime) this._el.removeEventListener('timeupdate', this._onTime);
      if (this._onEnded) this._el.removeEventListener('ended', this._onEnded);
    }
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._el = null;
    this._entry = null;
    this._cueIdx = -1;
    this._onTime = null;
    this._onEnded = null;
    this._push('', '');
  }
}
