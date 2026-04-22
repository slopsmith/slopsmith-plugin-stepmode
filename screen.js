// Step Mode plugin for Slopsmith
//
// Rocksmith-1-style practice mode: the highway freezes at each chart note until
// the player hits it (via notedetect) or presses Space. Lets the user work
// through fast solos at their own pace without losing audio/visual sync.
//
// Implements slopsmith#52.
//
// Interop:
//   - Hit-based advance uses the `notedetect:hit` CustomEvent dispatched by
//     slopsmith-plugin-notedetect (v1.1+). If notedetect isn't installed or
//     enabled, Space is the only advance mechanism — the waiting HUD updates
//     its hint text accordingly.
//   - Speed slider is preserved across pauses: we pause/resume the <audio>
//     element, and HTMLAudioElement keeps `playbackRate` across pause/play.

(function () {
    'use strict';

    // ── State machine ────────────────────────────────────────────────────
    // IDLE     — Step Mode toggled off; plugin is passive
    // WATCHING — toggled on, audio playing, RAF scanning for next note
    // PAUSED   — audio paused, waiting for hit / Space
    const STATE_IDLE = 0;
    const STATE_WATCHING = 1;
    const STATE_PAUSED = 2;

    let state = STATE_IDLE;
    let enabled = false;       // set by the toggle button
    let rafHandle = null;
    let chartEvents = [];      // unified sorted list of {t, notes:[{s,f}]} (notes + chords)
    let chartCacheKey = null;  // invalidated when notes/chords count changes
    let waitingFor = null;     // current event (when PAUSED)
    let btn = null;            // toggle button element
    let hudEl = null;          // waiting overlay

    // Pause 50 ms BEFORE the chart note so the user never hears the note's
    // attack clipped. Smaller values risk audible truncation; larger values
    // make the stop feel sluggish.
    const PAUSE_LOOKAHEAD_SEC = 0.05;

    // ── Helpers ──────────────────────────────────────────────────────────

    function getAudio() { return document.getElementById('audio'); }

    function isPlayerActive() {
        const p = document.getElementById('player');
        return !!(p && p.classList.contains('active'));
    }

    function rebuildChartEvents() {
        // Combine single notes and chords into one sorted list. A chord's
        // `notes` array carries every member; a solo note has a single-
        // element `notes`. Muted notes are skipped (they have no pitch to
        // match against and would hang step-mode forever).
        const events = [];
        const notes = (typeof highway !== 'undefined' && highway.getNotes) ? (highway.getNotes() || []) : [];
        const chords = (typeof highway !== 'undefined' && highway.getChords) ? (highway.getChords() || []) : [];

        for (const n of notes) {
            if (n.mt) continue;
            events.push({ t: n.t, notes: [{ s: n.s, f: n.f }] });
        }
        for (const c of chords) {
            const cnotes = (c.notes || []).filter(cn => !cn.mt).map(cn => ({ s: cn.s, f: cn.f }));
            if (cnotes.length === 0) continue;
            events.push({ t: c.t, notes: cnotes });
        }
        events.sort((a, b) => a.t - b.t);
        chartEvents = events;
        chartCacheKey = `${notes.length}-${chords.length}`;
    }

    function rebuildIfChartChanged() {
        // Cheap sentinel — rebuild only if the array lengths shifted (new
        // arrangement, new song, retuned chart). Avoids scanning the full
        // chart every RAF tick.
        const notes = (typeof highway !== 'undefined' && highway.getNotes) ? (highway.getNotes() || []) : [];
        const chords = (typeof highway !== 'undefined' && highway.getChords) ? (highway.getChords() || []) : [];
        const key = `${notes.length}-${chords.length}`;
        if (key !== chartCacheKey) rebuildChartEvents();
    }

    function findNextEvent(t) {
        // Binary search: first event with .t >= t.
        let lo = 0, hi = chartEvents.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (chartEvents[mid].t < t) lo = mid + 1;
            else hi = mid;
        }
        return lo < chartEvents.length ? chartEvents[lo] : null;
    }

    // ── Pitch-name formatting for the HUD ────────────────────────────────
    // Duplicated from notedetect rather than depending on its internals —
    // step-mode should work even if notedetect isn't installed (Space-only
    // mode), so we can't rely on notedetect's helpers.
    const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const OPEN_MIDI_GUITAR_6 = [40, 45, 50, 55, 59, 64];
    const OPEN_MIDI_GUITAR_7 = [35, 40, 45, 50, 55, 59, 64];
    const OPEN_MIDI_BASS_4 = [28, 33, 38, 43];
    const OPEN_MIDI_BASS_5 = [23, 28, 33, 38, 43];

    function stringFretToName(s, f, arrangement, tuning, capo) {
        const isBass = /bass/i.test(String(arrangement || ''));
        const stringCount = Array.isArray(tuning) ? tuning.length : (isBass ? 4 : 6);
        let openArr;
        if (isBass) openArr = stringCount === 5 ? OPEN_MIDI_BASS_5 : OPEN_MIDI_BASS_4;
        else openArr = stringCount === 7 ? OPEN_MIDI_GUITAR_7 : OPEN_MIDI_GUITAR_6;
        if (s < 0 || s >= openArr.length) return '?';
        const offset = (Array.isArray(tuning) && tuning[s] !== undefined) ? tuning[s] : 0;
        const midi = openArr[s] + offset + (capo || 0) + f;
        const pc = ((midi % 12) + 12) % 12;
        const octave = Math.floor(midi / 12) - 1;
        return `${PITCH_NAMES[pc]}${octave}`;
    }

    // ── Waiting HUD overlay ──────────────────────────────────────────────

    function ensureHUD() {
        if (hudEl && document.body.contains(hudEl)) return;
        const player = document.getElementById('player');
        if (!player) return;
        hudEl = document.createElement('div');
        hudEl.id = 'sm-waiting-hud';
        hudEl.className = 'absolute z-[25] pointer-events-none hidden';
        hudEl.style.cssText = 'top:40%;left:50%;transform:translate(-50%,-50%);';
        hudEl.innerHTML = `
            <div class="bg-dark-700/95 border-2 border-yellow-500/70 rounded-2xl px-6 py-4 shadow-2xl text-center backdrop-blur-sm animate-pulse">
                <div class="text-yellow-400 text-xs uppercase tracking-wide mb-1">▶ Step Mode — Waiting for</div>
                <div class="sm-waiting-note text-white text-3xl font-bold"></div>
                <div class="sm-waiting-hint text-gray-400 text-xs mt-2">Play the note or press Space</div>
            </div>
        `;
        player.appendChild(hudEl);
    }

    function showWaitingHUD(ev) {
        ensureHUD();
        if (!hudEl) return;
        const noteEl = hudEl.querySelector('.sm-waiting-note');
        const hintEl = hudEl.querySelector('.sm-waiting-hint');
        if (noteEl) {
            const info = (typeof highway !== 'undefined' && highway.getSongInfo) ? (highway.getSongInfo() || {}) : {};
            if (ev.notes.length === 1) {
                const { s, f } = ev.notes[0];
                const name = stringFretToName(s, f, info.arrangement, info.tuning, info.capo);
                noteEl.textContent = `${name} · string ${s} fret ${f}`;
            } else {
                noteEl.textContent = `chord · ${ev.notes.length} notes`;
            }
        }
        if (hintEl) {
            const nd = window.noteDetect;
            const ndActive = nd && typeof nd.isEnabled === 'function' && nd.isEnabled();
            hintEl.textContent = ndActive
                ? 'Play the note or press Space to skip'
                : 'Press Space to advance (enable Note Detection for hit-based advance)';
        }
        hudEl.classList.remove('hidden');
    }

    function hideWaitingHUD() {
        if (hudEl) hudEl.classList.add('hidden');
    }

    // ── Toggle button ────────────────────────────────────────────────────

    function ensureButton() {
        // Re-inject if the button is missing (or was never injected — the
        // #player-controls div exists in the initial DOM so this succeeds at
        // load time, but re-injection keeps us resilient to player-DOM
        // rewrites).
        if (btn && document.body.contains(btn)) return;
        const existing = document.getElementById('btn-stepmode');
        if (existing) { btn = existing; return; }
        const controls = document.getElementById('player-controls');
        if (!controls) return;
        btn = document.createElement('button');
        btn.id = 'btn-stepmode';
        btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
        btn.textContent = 'Step';
        btn.title = 'Step Mode — pause at each note until played';
        btn.onclick = toggleEnabled;
        // Insert before the last-child (typically the Close button) so new
        // buttons stack consistently with notedetect's Detect + gear.
        const closeBtn = controls.querySelector('button:last-child');
        if (closeBtn) controls.insertBefore(btn, closeBtn);
        else controls.appendChild(btn);
        updateButton();
    }

    function updateButton() {
        if (!btn) return;
        if (enabled) {
            btn.className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
            btn.textContent = 'Step \u2713';
        } else {
            btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-500 transition';
            btn.textContent = 'Step';
        }
    }

    // ── RAF watch ────────────────────────────────────────────────────────

    function startWatch() {
        stopWatch();
        const audio = getAudio();
        if (!audio) return;
        state = STATE_WATCHING;
        const tick = () => {
            if (!enabled || state === STATE_IDLE) { rafHandle = null; return; }
            if (state === STATE_PAUSED) {
                // Holding — keep the RAF ticking so we can transition out of
                // PAUSED via `advance()` + restart the watch. (We could stop
                // the RAF here and restart on advance; the current shape is
                // simpler and the per-frame cost of the early-return is nil.)
                rafHandle = requestAnimationFrame(tick);
                return;
            }
            if (audio.paused) {
                // User manually paused outside step-mode — let them; we'll
                // pick up on the next note once they resume.
                rafHandle = requestAnimationFrame(tick);
                return;
            }
            const t = audio.currentTime;
            rebuildIfChartChanged();
            const next = findNextEvent(t);
            if (next && t >= next.t - PAUSE_LOOKAHEAD_SEC) {
                pauseOn(next);
            }
            rafHandle = requestAnimationFrame(tick);
        };
        rafHandle = requestAnimationFrame(tick);
    }

    function stopWatch() {
        if (rafHandle) {
            cancelAnimationFrame(rafHandle);
            rafHandle = null;
        }
    }

    // ── State transitions ────────────────────────────────────────────────

    function pauseOn(event) {
        const audio = getAudio();
        if (!audio) return;
        audio.pause();
        state = STATE_PAUSED;
        waitingFor = event;
        showWaitingHUD(event);
    }

    function advance() {
        const audio = getAudio();
        if (!audio) return;
        state = STATE_WATCHING;
        waitingFor = null;
        hideWaitingHUD();
        // playbackRate survives across pause/play, so the user's speed-slider
        // setting (0.5×, 1×, etc.) is preserved without us touching it.
        audio.play().catch(() => { /* autoplay-policy or user cancelled */ });
    }

    // ── Event handlers ───────────────────────────────────────────────────

    function onNoteDetectHit(e) {
        if (!enabled || state !== STATE_PAUSED || !waitingFor) return;
        const hit = e.detail;
        if (!hit || !hit.note) return;
        // Chord rule for v1: any matching string/fret within the waited
        // chord counts as advance. MikeShiner's preference (#52 thread)
        // over "all notes required", to keep the UX forgiving.
        const match = waitingFor.notes.some(wn =>
            wn.s === hit.note.s && wn.f === hit.note.f
        );
        // Cross-check the hit was for OUR waited time — a hit scored
        // against a nearby chart note (common when playing fast
        // passages) shouldn't advance the wrong event. 0.5 s window
        // comfortably covers notedetect's default timing tolerance.
        const timeOK = Math.abs((hit.noteTime || 0) - waitingFor.t) < 0.5;
        if (match && timeOK) advance();
    }

    function onKeydownCapture(e) {
        // Capture-phase listener so we run BEFORE core's bubble-phase
        // keydown handler at static/app.js:1059. When we're in PAUSED
        // state, Space advances step-mode and we stop propagation so
        // core's togglePlay doesn't also fire. Otherwise we pass through
        // and Space does its normal play/pause toggle.
        if (!enabled) return;
        if (e.code !== 'Space') return;
        if (state !== STATE_PAUSED) return;
        if (!isPlayerActive()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        advance();
    }

    function onSeeked() {
        if (!enabled) return;
        // User seeked — the event they were waiting for may now be in
        // the past or irrelevant. Clear any wait, re-arm the watch from
        // the new time.
        if (state === STATE_PAUSED) {
            hideWaitingHUD();
            waitingFor = null;
        }
        state = STATE_WATCHING;
        startWatch();
    }

    function onArrangementChanged() {
        // Chart changed; re-scan. If we were paused on an event that
        // no longer exists in the new arrangement's chart, drop it.
        rebuildChartEvents();
        if (state === STATE_PAUSED) {
            hideWaitingHUD();
            waitingFor = null;
            state = STATE_WATCHING;
        }
    }

    // ── Enable / disable ────────────────────────────────────────────────

    function toggleEnabled() {
        if (enabled) disable();
        else enable();
    }

    function enable() {
        enabled = true;
        ensureHUD();
        ensureButton();
        rebuildChartEvents();
        startWatch();
        updateButton();
    }

    function disable() {
        enabled = false;
        stopWatch();
        if (state === STATE_PAUSED) {
            // Release any pause we caused so audio resumes.
            const audio = getAudio();
            if (audio) audio.play().catch(() => {});
        }
        state = STATE_IDLE;
        waitingFor = null;
        hideWaitingHUD();
        updateButton();
    }

    // ── playSong hook (idempotent across re-evaluations) ────────────────

    function installPlaySongHook() {
        const orig = window.playSong;
        if (typeof orig !== 'function') {
            // playSong may not exist yet on first script run. Retry a
            // bounded number of times. Same pattern as notedetect post-
            // factory-refactor (#17); keeps us HMR-safe and tolerant of
            // unusual load orders.
            if ((installPlaySongHook._retries = (installPlaySongHook._retries || 0) + 1) < 20) {
                setTimeout(installPlaySongHook, 50);
            }
            return;
        }
        if (orig._stepmodeWrapped) return;
        const wrapper = async function (...args) {
            const ret = await orig.apply(this, args);
            // After a song loads: make sure our button is still in the
            // player-controls row (in case slopsmith rebuilt it), and
            // re-scan the chart. Step-mode's enabled flag persists
            // across songs on purpose — if a user had it on for song
            // A and loads song B, they keep it on for B.
            ensureButton();
            onArrangementChanged();
            return ret;
        };
        wrapper._stepmodeWrapped = true;
        window.playSong = wrapper;
    }

    // ── Bootstrap ───────────────────────────────────────────────────────

    window.addEventListener('notedetect:hit', onNoteDetectHit);
    document.addEventListener('keydown', onKeydownCapture, { capture: true });

    const audioEl = getAudio();
    if (audioEl) audioEl.addEventListener('seeked', onSeeked);

    if (window.slopsmith && typeof window.slopsmith.on === 'function') {
        window.slopsmith.on('arrangement:changed', onArrangementChanged);
    }

    installPlaySongHook();
    ensureButton();
})();
