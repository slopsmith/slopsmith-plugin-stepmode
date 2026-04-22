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

    // Global idempotency guard — a second evaluation of this file (HMR,
    // accidental double <script> tag) would otherwise register duplicate
    // `notedetect:hit` / `keydown` / `seeked` / `arrangement:changed`
    // listeners, and a single keypress or hit would advance step-mode
    // twice. The flag lives on `window` because module scope resets on
    // every evaluation; same pattern we landed in notedetect post-#17.
    if (window.__stepModeInstalled) return;
    window.__stepModeInstalled = true;

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
    let nextEventIdx = 0;      // cursor into chartEvents — the event we're watching for
    let waitingFor = null;     // current event (when PAUSED). Always === chartEvents[nextEventIdx] while paused.
    let btn = null;            // toggle button element
    let hudEl = null;          // waiting overlay
    let audioPlayListenerPending = false; // guard against duplicate one-shot `play` listeners

    // Pause 50 ms BEFORE the chart note so the user never hears the note's
    // attack clipped. Smaller values risk audible truncation; larger values
    // make the stop feel sluggish.
    const PAUSE_LOOKAHEAD_SEC = 0.05;

    // How far past a chart event's time we still treat it as "current"
    // rather than "definitively missed". A RAF hitch (GC, background
    // tab, heavy chart render on neighbour plugins) can jump
    // audio.currentTime 200–500 ms between ticks; without this
    // catch-up window, the cursor-walk in findNextEvent would skip
    // silently past any event whose pause-window was entirely straddled
    // by the hitch, and Step Mode would never pause for that note.
    // 0.5 s is comfortably above typical hitches while staying well
    // under seek granularity — seek jumps are handled separately by
    // onSeeked + resetCursor.
    const EVENT_MISSED_SEC = 0.5;

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
        // Reset the cursor to the right starting point for the current
        // audio time. Linear-from-0 would be O(n) on large charts
        // (1000+ events in a long solo) every time the chart rebuilds.
        resetCursor();
    }

    function resetCursor() {
        // Binary-search for the first event with .t >= current audio
        // time. Called on chart rebuilds, seeks, and song changes — any
        // path where the cursor position is no longer meaningful.
        // O(log n) vs. the linear scan that would otherwise fire on the
        // next findNextEvent call with nextEventIdx=0.
        const audio = getAudio();
        const t = audio ? audio.currentTime : 0;
        let lo = 0, hi = chartEvents.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (chartEvents[mid].t < t) lo = mid + 1;
            else hi = mid;
        }
        nextEventIdx = lo;
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
        // Cursor-based forward scan. `nextEventIdx` points at the event
        // we're currently watching for; `advance()` bumps it past the
        // event we just cleared. Without this cursor, `findNextEvent`
        // would return the SAME event on the next RAF tick after
        // advance() (because `audio.currentTime` only moved a few
        // milliseconds past the pause threshold), and `pauseOn` would
        // re-trigger on the same event — an infinite loop where
        // step-mode never progresses past the first note.
        //
        // The skip threshold is `t - EVENT_MISSED_SEC`, not `t`, so a
        // RAF hitch that jumps audio past an event's pause window
        // doesn't silently lose the event — the next tick still sees
        // the event and pauses on it. Seeks are handled separately by
        // `onSeeked` / `resetCursor`, so this tolerance window doesn't
        // need to cover user-initiated jumps.
        const skipThreshold = t - EVENT_MISSED_SEC;
        while (nextEventIdx < chartEvents.length && chartEvents[nextEventIdx].t < skipThreshold) {
            nextEventIdx++;
        }
        return nextEventIdx < chartEvents.length ? chartEvents[nextEventIdx] : null;
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

    function configureButton(el) {
        // Re-applied even on already-injected buttons — a player DOM
        // rewrite via innerHTML would keep the element in the DOM but
        // drop its onclick / class / text, leaving Step Mode
        // un-toggleable. updateButton() overwrites class/text based on
        // the current `enabled` state after this runs.
        el.id = 'btn-stepmode';
        el.textContent = 'Step';
        el.title = 'Step Mode — pause at each note until played';
        el.onclick = toggleEnabled;
    }

    function ensureButton() {
        // Re-inject if the button is missing. If a button with our id
        // already exists (typical after a player-DOM rewrite), re-bind
        // its handlers and re-paint state rather than trusting what's
        // there.
        if (btn && document.body.contains(btn)) {
            configureButton(btn);
            updateButton();
            return;
        }
        const existing = document.getElementById('btn-stepmode');
        if (existing) {
            btn = existing;
            configureButton(btn);
            updateButton();
            return;
        }
        const controls = document.getElementById('player-controls');
        if (!controls) return;
        btn = document.createElement('button');
        configureButton(btn);
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
                // Shouldn't reach here — pauseOn cancels the RAF. Defensive
                // stop if something transitioned to PAUSED without going
                // through pauseOn.
                rafHandle = null;
                return;
            }
            if (audio.paused) {
                // User manually paused outside step-mode (or we're before
                // playback starts). `currentTime` isn't moving, so
                // there's nothing for us to scan for. Stop the RAF and
                // wait for the audio element's `play` event to restart
                // via `onAudioPlay`. The pending-listener guard prevents
                // duplicate registrations if startWatch runs multiple
                // times while audio remains paused (e.g., user enables
                // Step Mode pre-playback, then seeks or changes
                // arrangement — each path touches startWatch).
                rafHandle = null;
                if (!audioPlayListenerPending) {
                    audioPlayListenerPending = true;
                    audio.addEventListener('play', onAudioPlay, { once: true });
                }
                return;
            }
            const t = audio.currentTime;
            rebuildIfChartChanged();
            const next = findNextEvent(t);
            if (next && t >= next.t - PAUSE_LOOKAHEAD_SEC) {
                pauseOn(next);
                return; // pauseOn cancels the RAF; don't schedule another tick
            }
            rafHandle = requestAnimationFrame(tick);
        };
        rafHandle = requestAnimationFrame(tick);
    }

    function onAudioPlay() {
        // Audio resumed after a user-initiated pause (not a step-mode
        // PAUSED — that's handled by advance()/onArrangementChanged).
        // Clear the pending-listener guard regardless of whether we
        // restart — the listener itself already fired exactly once.
        audioPlayListenerPending = false;
        if (!enabled || state !== STATE_WATCHING) return;
        startWatch();
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
        // Stop the RAF while paused — PAUSED can last indefinitely
        // (user thinking, walking away, etc.) and we don't want to
        // spin the main thread at 60 Hz just to early-return. advance()
        // / onSeeked / onArrangementChanged restart the watch via
        // startWatch() when transitioning back to WATCHING.
        stopWatch();
    }

    function advance() {
        const audio = getAudio();
        const waitedEvent = waitingFor;
        if (!audio || !waitedEvent) return;

        function completeAdvance() {
            // Bump the cursor past the event we just advanced off, so the
            // next RAF tick looks for the FOLLOWING event rather than
            // re-pausing on this one. Invariant: at entry, waitingFor
            // was === chartEvents[nextEventIdx] (pauseOn only fires for
            // events returned by findNextEvent).
            if (chartEvents[nextEventIdx] === waitedEvent) {
                nextEventIdx++;
            }
            state = STATE_WATCHING;
            waitingFor = null;
            hideWaitingHUD();
            // Restart the RAF — pauseOn cancelled it when we entered
            // PAUSED, and we need it running again to watch for the
            // next chart event.
            startWatch();
        }

        // Only transition out of PAUSED after audio.play() actually
        // resolves. If the browser rejects the resume (autoplay-policy
        // edge cases, gesture-gating on non-user-initiated resume
        // paths), we'd otherwise land in WATCHING with audio paused
        // and the HUD hidden — visibly stuck with no way forward.
        // On reject: stay paused, keep the HUD visible, user can
        // retry via Space or another hit. playbackRate survives
        // across pause/play so the speed-slider setting is preserved.
        const playResult = audio.play();
        if (playResult && typeof playResult.then === 'function') {
            playResult.then(completeAdvance).catch(() => {
                state = STATE_PAUSED;
                waitingFor = waitedEvent;
                showWaitingHUD(waitedEvent);
            });
            return;
        }
        // Older browsers may return undefined from play(); treat as
        // a synchronous success.
        completeAdvance();
    }

    // ── Event handlers ───────────────────────────────────────────────────

    function onNoteDetectHit(e) {
        if (!enabled || state !== STATE_PAUSED || !waitingFor) return;
        const hit = e.detail;
        if (!hit || !hit.note) return;
        // Require a real timestamp — older/partial notedetect:hit
        // payloads that lack noteTime would otherwise coerce to 0 via
        // `||` and spuriously match early-song notes where
        // waitingFor.t < 0.5 on string/fret alone.
        if (!Number.isFinite(hit.noteTime)) return;
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
        const timeOK = Math.abs(hit.noteTime - waitingFor.t) < 0.5;
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
        // Don't intercept Space if the user is typing in an editable
        // control — they expect the space character, not an advance.
        // Applies to a rename dialog, the search box, or any future
        // contenteditable in the player.
        const target = e.target;
        if (target && (
            target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable
        )) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        advance();
    }

    function onSeeked() {
        if (!enabled) return;
        // User seeked — the event they were waiting for may now be in
        // the past or irrelevant. Jump the cursor directly to the new
        // audio.currentTime via binary search rather than linear-scan
        // from 0.
        resetCursor();
        if (state === STATE_PAUSED) {
            hideWaitingHUD();
            waitingFor = null;
        }
        state = STATE_WATCHING;
        startWatch();
    }

    function onArrangementChanged() {
        // Skip all work when Step Mode is off. enable() will rebuild
        // the chart the moment the user toggles on, and no watch is
        // running to need fresh data in the meantime. Avoids paying
        // the chart-events rebuild cost on every arrangement /
        // song-change notification for users who aren't running
        // Step Mode.
        if (!enabled) return;
        // Chart changed; re-scan (rebuildChartEvents swaps chartEvents
        // for the new arrangement and realigns the cursor to the
        // current audio.currentTime via resetCursor's binary search).
        // If we were paused on an event, the stale waitingFor belongs
        // to the old chart — dropping it here is important so
        // notedetect hit matching doesn't try to compare new-
        // arrangement hits against old-arrangement string/fret/time.
        // Transition plan:
        //   1. Drop the stale waitingFor up-front.
        //   2. Try to resume audio. If it plays, we're back in WATCHING
        //      and startWatch will find the next event for the new
        //      chart.
        //   3. If play() rejects, find the next event in the NEW chart
        //      at the current audio.currentTime and pauseOn it — the
        //      HUD shows the correct expected note for the new
        //      arrangement, and notedetect hits will match against a
        //      valid current target.
        rebuildChartEvents();
        if (state !== STATE_PAUSED) return;
        const audio = getAudio();
        if (!audio) return;
        waitingFor = null;
        hideWaitingHUD();
        const playResult = audio.play();
        if (playResult && typeof playResult.then === 'function') {
            playResult.then(() => {
                state = STATE_WATCHING;
                startWatch();
            }).catch(() => {
                const t = audio.currentTime;
                const nextEvent = findNextEvent(t);
                if (nextEvent) {
                    pauseOn(nextEvent); // set state=PAUSED, show HUD, stop watch
                } else {
                    // No more events in the chart (e.g., seeked past end).
                    state = STATE_WATCHING;
                }
            });
            return;
        }
        state = STATE_WATCHING;
        startWatch();
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
        // Preserve the original return type — slopsmith core's
        // playSong is async today, but wrapping it in `async function`
        // unconditionally would force every future sync version to
        // become a Promise too. Chain on the return value only if
        // it's actually a Promise; otherwise run post-load logic
        // synchronously and return the original value unchanged.
        const wrapper = function (...args) {
            const ret = orig.apply(this, args);
            // After a song loads: make sure our button is still in the
            // player-controls row (in case slopsmith rebuilt it), and
            // re-scan the chart. Step-mode's enabled flag persists
            // across songs on purpose — if a user had it on for song
            // A and loads song B, they keep it on for B.
            const afterLoad = () => {
                ensureButton();
                onArrangementChanged();
            };
            if (ret && typeof ret.then === 'function') {
                return ret.then(value => {
                    afterLoad();
                    return value;
                });
            }
            afterLoad();
            return ret;
        };
        wrapper._stepmodeWrapped = true;
        window.playSong = wrapper;
    }

    // ── Late-load installers ────────────────────────────────────────────
    // Same retry discipline as `installPlaySongHook` — if the audio
    // element or `window.slopsmith` aren't ready at script evaluation
    // time (unusual load order, plugin loaded before core finished
    // wiring the DOM), retry a bounded number of times. Backward seeks
    // break silently if `seeked` isn't attached, so this isn't
    // purely theoretical.

    let _seekedInstalled = false;
    function installSeekedListener() {
        if (_seekedInstalled) return;
        const audioEl = getAudio();
        if (audioEl) {
            audioEl.addEventListener('seeked', onSeeked);
            _seekedInstalled = true;
            return;
        }
        if ((installSeekedListener._retries = (installSeekedListener._retries || 0) + 1) < 20) {
            setTimeout(installSeekedListener, 50);
        }
    }

    let _arrangementListenerInstalled = false;
    function installArrangementListener() {
        if (_arrangementListenerInstalled) return;
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            window.slopsmith.on('arrangement:changed', onArrangementChanged);
            _arrangementListenerInstalled = true;
            return;
        }
        if ((installArrangementListener._retries = (installArrangementListener._retries || 0) + 1) < 20) {
            setTimeout(installArrangementListener, 50);
        }
    }

    // ── Bootstrap ───────────────────────────────────────────────────────

    window.addEventListener('notedetect:hit', onNoteDetectHit);
    document.addEventListener('keydown', onKeydownCapture, { capture: true });

    installSeekedListener();
    installArrangementListener();
    installPlaySongHook();
    ensureButton();
})();
