/*!
 * infra-dial — pinned "infrastructure" stepper for Webflow (GSAP + ScrollTrigger + Observer)
 * Logic is intentionally unchanged from the battle-tested original; comments document real
 * edge-case fixes. Safe optimizations only: per-row DOM lookups are cached once, and the
 * load/fonts resync is factored into a single helper. Serve the minified build over the CDN.
 */
(function () {
  'use strict';

  // Ring position of each tick, as a fraction of the circle. Index 0 is the
  // tick at the top, which is both the start (0) and the end (1) of the ring.
  var TICKS = [0, 0.2165, 0.4069, 0.6335, 0.8049];

  // How far the ring is filled on each item: one segment per item, closing
  // the circle on the last one.  → [0.2165, 0.4069, 0.6335, 0.8049, 1]
  var FILL = TICKS.slice(1).concat(1);

  // Which marker (in DOM order) each item's fill lands on. Item 5 lands back
  // on the top marker, because that is where a full ring finishes.
  var TICK_DOM = [1, 2, 3, 4, 0];

  var CONFIG = {
    stepDuration : 0.75,  // ring travel for one step, seconds — both directions
    stepEase     : 'power2.inOut',

    // ---- Pacing. These three numbers are the whole feel of the section ----
    cadence      : 0.9,   // s — shortest possible gap between two items
    sustained    : 1.8,   // × cadence — pace while input never stops arriving
    gestureGap   : 0.16,  // s of quiet that marks the start of a new gesture

    tolerance    : 12,    // px of input before Observer reports a gesture
    captionFade  : 380,   // keep in sync with the CSS fade on .infra_dial-text
    pinScreens   : 1.2,   // page scroll the pinned section owns
    desktopFrom  : 768,   // below this: no pin, no input capture
    debug        : false  // true → console.log every ring move
  };

  function init(tries) {
    // Webflow's GSAP bundle normally loads above this file, but never assume.
    if (!window.gsap || !window.ScrollTrigger) {
      if ((tries || 0) > 60) return;
      return void setTimeout(function () { init((tries || 0) + 1); }, 50);
    }

    var section = document.querySelector('.section_infrastructure');
    if (!section) return;

    var find = function (sel) {
      return Array.prototype.slice.call(section.querySelectorAll(sel));
    };

    var rows    = find('[data-infra-item]');
    var markers = find('.infra_dial-svg g line');
    var arc     = section.querySelector('.infra_dial-progress');
    var counter = section.querySelector('.infra_dial-counter .counter_change');
    var caption = section.querySelector('.infra_dial-text');
    var track   = section.querySelector('.infra_track');
    var sticky  = section.querySelector('.infra_sticky');

    if (!arc || !rows.length || !track || !sticky) return;

    // Cache per-row nodes and caption text once. The originals re-queried these
    // on every step; the markup never changes after render, so this is pure
    // win with identical behaviour. `rows` stays the element list for length,
    // mobile triggers, etc.
    var items = rows.map(function (row) {
      var source = row.querySelector('.infra_dial-source');
      return {
        el     : row,
        body   : row.querySelector('.infra_body-wrap'),
        number : row.querySelector('.infra_number'),
        text   : source ? source.textContent.trim() : ''
      };
    });

    gsap.registerPlugin(ScrollTrigger);
    if (window.Observer) gsap.registerPlugin(Observer);

    /* --- Sole owner of this section -------------------------------------
       Two implementations writing to the same dial is unfixable from inside
       either one: an old scrub version caps the ring at 0.8049 (one segment
       short) and keeps overwriting the arc from its own 7-screen pin. So
       this script claims the section and retires anything else pinned to
       it. Delete the old blocks from the custom code anyway — this is a
       safety net, not a substitute.                                      */
    if (window.__infraStepper) return;      // a second copy of this script
    window.__infraStepper = true;

    var OWNED = '__infraStepperST';

    function sweepForeign() {
      ScrollTrigger.getAll().forEach(function (st) {
        if (st[OWNED]) return;              // one of ours
        var t = st.trigger, p = st.pin;
        if ((t && section.contains(t)) || (p && section.contains(p))) {
          if (CONFIG.debug) console.warn('[infra] retiring a stale ScrollTrigger on this section');
          if (st.animation) st.animation.kill();
          st.kill(true);
        }
      });
    }

    function own(st) { st[OWNED] = true; return st; }

    function resync() { sweepForeign(); ScrollTrigger.refresh(); }

    sweepForeign();

    /* --- Lenis bridge ----------------------------------------------------
       Lenis itself is booted from Site Settings → Footer. Read it lazily,
       every time: it may still be loading when this runs, and the section
       must work either way. With Lenis present the page is locked outright
       while the section holds the input, instead of relying on a
       preventDefault that momentum scrolling is allowed to ignore.       */
    function lenis()      { return window.lenis || null; }
    function lockPage()   { var l = lenis(); if (l) l.stop(); }
    function unlockPage() { var l = lenis(); if (l) l.start(); }
    function jumpTo(y) {
      var l = lenis();
      if (l) l.scrollTo(y, { immediate: true, force: true, lock: true });
      else window.scrollTo(0, y);
    }

    var steps      = rows.length;
    var index      = -1;         // the committed item — the only source of truth
    var animating  = false;
    var retreating = false;      // the ring is retracting back to empty
    var ring       = { value: 0 };
    var ringTween;
    var captionTimer;
    var captionToken = 0;

    /* ---------------------------------------------------------------- paint */

    function drawRing() {
      arc.style.strokeDashoffset = 100 * (1 - ring.value);
    }

    function paintTicks(i) {
      markers.forEach(function (marker) {
        marker.classList.remove('is-on', 'is-now');
      });
      for (var t = 0; t <= i; t++) {           // i === -1 → nothing lit
        var marker = markers[TICK_DOM[t]];
        if (!marker) continue;
        marker.classList.add('is-on');
        if (t === i) marker.classList.add('is-now');
      }
    }

    function paintRows(i, instant) {
      items.forEach(function (it, r) {
        it.el.classList.toggle('is-current', r === i);
        it.el.classList.toggle('is-past', r < i);
        if (it.body) it.body.classList.toggle('is-open', r === i);
        if (it.number) it.number.classList.toggle('is-active', r === i);
      });

      if (counter) counter.textContent = ('0' + (i + 1)).slice(-2);
      if (!caption) return;

      var text = items[i].text;

      if (instant) {
        clearTimeout(captionTimer);
        captionToken++;
        caption.classList.remove('is-out');
        caption.textContent = text;
        return;
      }

      // Token guard: only the newest change may restore the caption, so it
      // can never be left stuck in the is-out state.
      var token = ++captionToken;
      clearTimeout(captionTimer);
      caption.classList.add('is-out');
      captionTimer = setTimeout(function () {
        if (token !== captionToken) return;
        caption.textContent = text;
        caption.classList.remove('is-out');
      }, CONFIG.captionFade);
    }

    // Every ring move goes through here: same duration, same ease, forward or
    // backward. It always starts from wherever the ring currently is, so a
    // reversal mid-travel continues smoothly instead of snapping.
    function moveRing(target, instant, onDone) {
      if (ringTween) ringTween.kill();
      retreating = false;

      var duration = instant ? 0 : CONFIG.stepDuration;
      animating = duration > 0;
      ringTween = gsap.to(ring, {
        value      : target,
        duration   : duration,
        ease       : CONFIG.stepEase,
        onUpdate   : drawRing,
        onComplete : function () {
          animating = false;
          if (onDone) onDone();
        }
      });
    }

    /* The single entry point for changing item. A step is atomic: rows, dial,
       ticks and caption commit together, and `animating` stays true for the
       whole travel so nothing can interrupt a step half-way through.

       opts.instantPaint — swap rows/caption with no fade
       opts.instantRing  — jump the ring instead of travelling
       opts.force        — re-commit even if the index is unchanged          */
    function commit(i, opts) {
      opts = opts || {};
      i = Math.max(0, Math.min(steps - 1, i));
      if (i === index && !opts.force) return false;

      if (CONFIG.debug) console.log('[infra] item', index + 1, '→', i + 1, 'fill', FILL[i]);

      index = i;
      paintRows(i, !!opts.instantPaint);
      paintTicks(i);
      moveRing(FILL[i], !!opts.instantRing);
      return true;
    }

    // Leaving out of the top: retract segment 1 the same way it was drawn,
    // rather than clearing it. The tick stays lit for the whole transit and
    // goes dark once the ring is actually empty.
    function retreat() {
      if (retreating || (index === 0 && ring.value === 0)) {
        paintTicks(-1);
        return;
      }
      if (CONFIG.debug) console.log('[infra] retract from item', index + 1);

      if (index !== 0) paintRows(0, false);   // eased, in case we left deeper in
      index = 0;

      moveRing(0, false, function () { paintTicks(-1); });
      retreating = true;                       // set after moveRing clears it
    }

    // First paint only: item 1 open, ring empty, no tick lit. Segment 1 is
    // NOT drawn here — the entry draws it, once.
    function prepare() {
      if (ringTween) ringTween.kill();
      index = 0;
      animating = false;
      retreating = false;
      ring.value = 0;
      drawRing();
      paintRows(0, true);
      paintTicks(-1);
    }

    prepare();

    /* ------------------------------------------------- desktop: the stepper */

    var FRESH = 0, INSIDE = 1, DONE = 2;

    var mm = gsap.matchMedia();

    mm.add(
      '(min-width: ' + CONFIG.desktopFrom + 'px) and (prefers-reduced-motion: no-preference)',
      function () {
        var phase      = FRESH;
        var engaged    = false;
        var refreshing = false;  // suppress phase changes during a refresh
        var lastInput  = 0;
        var lastStep   = -1e9;
        var newGesture = true;   // flipped back on by a quiet gap in the input
        var reEngageAt = 0;      // don't re-grab scrolling right after a release

        function onRefreshInit() { refreshing = true; }
        function onRefresh() { refreshing = false; }
        ScrollTrigger.addEventListener('refreshInit', onRefreshInit);
        ScrollTrigger.addEventListener('refresh', onRefresh);

        /* GSAP fires these callbacks synchronously from inside create() and
           from _refreshAll(), i.e. before `pin` has been assigned. Reading
           pin.progress there threw "Cannot read properties of undefined
           (reading 'progress')" on load, which aborted the entry before it
           could commit an item or capture input — leaving the dial to
           whatever else was painting it. So every callback uses the instance
           GSAP hands it and never relies on the variable.                 */
        var pin;
        function inst(self) { return self || pin; }

        // Built BEFORE the ScrollTrigger for the same reason: a callback can
        // fire from inside create(), and engage() must find a real observer
        // to enable — otherwise the section pins with the input uncaptured.
        // wheelSpeed:-1 matches GSAP's own stepper demos — onUp means the
        // user is going *down* the page. preventDefault is kept as a second
        // line of defence; with Lenis running, lockPage() is the one that
        // actually holds the page still.
        var observer = window.Observer && Observer.create({
          target         : window,
          type           : 'wheel,touch',
          wheelSpeed     : -1,
          tolerance      : CONFIG.tolerance,
          preventDefault : true,
          onUp           : function () { step(1); },
          onDown         : function () { step(-1); }
        });
        if (observer) observer.disable();

        pin = own(ScrollTrigger.create({
          trigger : track,
          start   : 'top top',
          end     : function () {
            return '+=' + Math.round(CONFIG.pinScreens * window.innerHeight);
          },
          pin                 : sticky,
          pinSpacing          : true,
          // anticipatePin removed: it exists to mask compositor scroll lag,
          // which Lenis has already removed. Leaving it on pins a frame early.
          invalidateOnRefresh : true,
          onEnter     : function (self) { arrive(-1, self); },  // crossed start, from above
          onEnterBack : function (self) { arrive(1, self); },   // crossed end, from below
          onLeave     : function () { leave(1); },
          onLeaveBack : function () { leave(-1); },
          onUpdate    : function (self) {
            // Safety net: if an onEnter was refused during the post-release
            // window, take the input back on the next scroll update rather
            // than letting the reader slide through the pinned range. A
            // finished reader heading down is left alone.
            if (engaged || !self.isActive) return;
            if (performance.now() < reEngageAt) return;
            if (phase === DONE && self.direction > 0) return;
            engage(self);
          }
        }));

        function onKey(e) {
          if (!engaged || e.metaKey || e.ctrlKey || e.altKey) return;
          var t = e.target;
          if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

          var dir = 0;
          if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') dir = 1;
          else if (e.key === 'ArrowUp' || e.key === 'PageUp') dir = -1;
          if (!dir) return;

          e.preventDefault();
          step(dir);
        }
        window.addEventListener('keydown', onKey);

        // side: -1 arriving from above, +1 arriving from below. Only a real
        // crossing may change the phase — during a refresh the callbacks are
        // just replays of where we already are. `engaged` is what separates a
        // replay from a real crossing: if we still hold the input we are
        // mid-pass, so the phase is left alone.
        function arrive(side, self) {
          if (!refreshing && !engaged) {
            if (side < 0) phase = FRESH;                     // over the top edge: new pass
            else if (phase === FRESH) phase = DONE;          // came up from below
          }
          engage(self);
        }

        function engage(self) {
          if (engaged || performance.now() < reEngageAt) return;

          var t = inst(self);
          if (!t) return;               // nothing to measure against yet

          // A very fast page scroll can land part-way into the pinned range
          // before we take over. Reclaim it so stepping always starts from a
          // clean position (invisible: the pinned view is identical anywhere
          // inside the range). If the flick cleared the section entirely we
          // let it go rather than yanking the reader backwards.
          if (t.progress > 0.02 && t.progress < 0.98) {
            jumpTo(t.start + 2);
          }

          engaged = true;
          lockPage();                  // hard stop — Lenis stops feeding scroll

          // The phase decides what a re-entry restores — never the scroll
          // direction, and never a replay of the entry animation.
          if (phase === FRESH) {
            commit(0, { instantPaint: true, force: true });         // draw segment 1
          } else if (phase === DONE && index !== steps - 1) {
            commit(steps - 1, { instantPaint: true, instantRing: true, force: true });
          }
          phase = INSIDE;

          // Treat the arrival as a step for pacing, so the momentum tail that
          // carried the reader in cannot immediately advance an item.
          lastInput = lastStep = performance.now();
          newGesture = false;

          if (observer) observer.enable();
        }

        function disengage() {
          if (!engaged) return;
          engaged = false;
          unlockPage();                // give scrolling back before anything moves
          if (observer) observer.disable();
        }

        function leave(dir) {
          disengage();
          if (refreshing) return;   // a refresh is not a real exit
          if (dir < 0) {
            retreat();              // out of the top → retract the ring to empty
            phase = FRESH;
          } else {
            phase = DONE;           // out of the bottom → keep item 5, ring closed
          }
        }

        // Past the last (or before the first) item: give scrolling back to the
        // page and jump to the pin edge, so no dead pinned stretch is left to
        // scroll through.
        function release(dir) {
          disengage();
          phase = dir > 0 ? DONE : FRESH;
          reEngageAt = performance.now() + 450;
          var t = inst();
          if (!t) return;
          jumpTo(Math.max(0, dir > 0 ? t.end + 2 : t.start - 2));
        }

        function step(dir) {
          var now = performance.now();
          var quiet = (now - lastInput) > CONFIG.gestureGap * 1000;
          lastInput = now;                 // every event counts, committed or not
          if (quiet) newGesture = true;

          if (!engaged || animating) return;

          var since = now - lastStep;
          // A distinct gesture may step as soon as the cadence has elapsed.
          // Input that never stops arriving — a long momentum tail, or a wheel
          // being spun continuously — is paced more slowly instead of chaining
          // one item straight into the next.
          if (since < CONFIG.cadence * 1000) return;
          if (!newGesture && since < CONFIG.cadence * CONFIG.sustained * 1000) return;

          var next = index + dir;
          if (next < 0 || next > steps - 1) { release(dir); return; }

          newGesture = false;
          lastStep = now;
          commit(next);
        }

        if (pin && pin.isActive) engage(pin);
        // If a callback engaged us from inside create(), make sure the input
        // really is captured now.
        if (engaged && observer && !observer.isEnabled) observer.enable();

        return function cleanup() {
          disengage();
          unlockPage();               // never leave the page locked behind us
          ScrollTrigger.removeEventListener('refreshInit', onRefreshInit);
          ScrollTrigger.removeEventListener('refresh', onRefresh);
          window.removeEventListener('keydown', onKey);
          if (observer) observer.kill();
          if (pin) pin.kill(true);
        };
      }
    );

    /* ---------------------- mobile / reduced motion: no pin, no capture */

    mm.add(
      '(max-width: ' + (CONFIG.desktopFrom - 1) + 'px), (prefers-reduced-motion: reduce)',
      function () {
        // The section scrolls normally and each row becomes the active one as
        // it reaches the middle of the screen. Still one item at a time, but
        // touch scrolling is never intercepted. Lenis runs with syncTouch:false
        // site-wide, so touch is native and this branch is unchanged by it.
        unlockPage();                 // in case we crossed the breakpoint locked

        var triggers = rows.map(function (row, i) {
          return own(ScrollTrigger.create({
            trigger     : row,
            start       : 'top 70%',
            end         : 'bottom 30%',
            onEnter     : function () { commit(i); },
            onEnterBack : function () { commit(i); }
          }));
        });

        commit(0, { instantPaint: true, force: true });   // draw segment 1 once

        return function cleanup() {
          triggers.forEach(function (t) { t.kill(); });
        };
      }
    );

    /* --------------------------------------------------------------- layout */

    // A stale block placed *after* this one in the page runs later, so sweep
    // again once everything inline has executed.
    window.addEventListener('load', resync);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(resync);
    }
  }

  if (document.readyState !== 'loading') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  }
})();
