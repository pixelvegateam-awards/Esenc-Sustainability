(function () {
  'use strict';

  /* ===== CONFIG ===== */
  var CONFIG = {
    stepDuration    : 0.7,            // ring travel for one step, seconds
    stepEase        : 'power2.inOut',

    // -- pinned stepper (desktop + tablet) --
    cadence         : 0.7,            // shortest gap between two items, seconds
    sustained       : 1.15,           // cadence multiplier while input keeps arriving
    gestureGap      : 0.09,           // quiet that marks a new gesture, seconds
    entryLock       : 0.3,            // immunity right after the section takes input
    tolerance       : 10,             // px of wheel before Observer reports a gesture
    touchTolerance  : 24,             // px of finger travel before a swipe counts
    pinScreens      : 1.2,            // page scroll the pin owns

    // -- phone --
    phoneAutoplay   : true,           // walk through the items once while on screen
    phoneDwell      : 3.2,            // seconds an item stays open during that walk

    captionFade     : 380,            // keep in sync with the CSS fade on .infra_dial-text
    desktopFrom     : 768,            // where the pinned stepper takes over
    debug           : false
  };
  /* ===== END CONFIG ===== */

  // Ring geometry. TICKS = marker positions as a fraction of the circle (0 = top).
  // FILL = how far the ring is filled after each item. TICK_DOM = which marker,
  // in DOM order, each item's fill lands on (item 5 closes back onto the top one).
  var TICKS    = [0, 0.2165, 0.4069, 0.6335, 0.8049];
  var FILL     = TICKS.slice(1).concat(1);
  var TICK_DOM = [1, 2, 3, 4, 0];

  function init(tries) {
    if (!window.gsap || !window.ScrollTrigger) {        // Webflow's bundle may still be loading
      if ((tries || 0) > 60) return;
      return void setTimeout(function () { init((tries || 0) + 1); }, 50);
    }

    var section = document.querySelector('.section_infrastructure');
    if (!section) return;

    var one = function (s) { return section.querySelector(s); };
    var all = function (s) { return Array.prototype.slice.call(section.querySelectorAll(s)); };

    var rows    = all('[data-infra-item]');
    var markers = all('.infra_dial-svg g line');
    var arc     = one('.infra_dial-progress');
    var counter = one('.infra_dial-counter .counter_change');
    var caption = one('.infra_dial-text');
    var track   = one('.infra_track');
    var sticky  = one('.infra_sticky');
    var dial    = one('.infra_dial');
    if (!arc || !rows.length || !track || !sticky) return;

    if (window.__infraStepper) return;                  // a second copy of this script
    window.__infraStepper = true;

    // Cache per-row nodes and caption text once; the markup never changes.
    var items = rows.map(function (row) {
      var src = row.querySelector('.infra_dial-source');
      return {
        el     : row,
        body   : row.querySelector('.infra_body-wrap'),
        number : row.querySelector('.infra_number'),
        text   : src ? src.textContent.trim() : ''
      };
    });

    gsap.registerPlugin(ScrollTrigger);
    if (window.Observer) gsap.registerPlugin(Observer);

    // Phones fire resize when the address bar slides; without this the pin
    // re-measures mid-scroll and shifts under the reader.
    ScrollTrigger.config({ ignoreMobileResize: true });

    // Lenis is booted from Site Settings - read it lazily, it may still be
    // loading. With Lenis present the page is locked outright while the section
    // holds the input, rather than relying on a preventDefault momentum ignores.
    function lenis()      { return window.lenis || null; }
    function lockPage()   { var l = lenis(); if (l) l.stop(); }
    function unlockPage() { var l = lenis(); if (l) l.start(); }
    function jumpTo(y) {
      var l = lenis();
      if (l) l.scrollTo(y, { immediate: true, force: true, lock: true });
      else window.scrollTo(0, y);
    }

    var steps      = rows.length;
    var index      = -1;        // the committed item, the only source of truth
    var animating  = false;
    var retreating = false;     // the ring is retracting back to empty
    var ring       = { value: 0 };
    var ringTween, captionTimer, captionToken = 0;

    /* ---------------------------------------------------------- paint ---- */

    function drawRing() { arc.style.strokeDashoffset = 100 * (1 - ring.value); }

    function paintTicks(i) {                            // i === -1 lights nothing
      markers.forEach(function (m) { m.classList.remove('is-on', 'is-now'); });
      for (var t = 0; t <= i; t++) {
        var m = markers[TICK_DOM[t]];
        if (!m) continue;
        m.classList.add('is-on');
        if (t === i) m.classList.add('is-now');
      }
    }

    function paintRows(i, instant) {
      items.forEach(function (it, r) {
        it.el.classList.toggle('is-current', r === i);
        it.el.classList.toggle('is-past', r < i);
        if (it.body)   it.body.classList.toggle('is-open', r === i);
        if (it.number) it.number.classList.toggle('is-active', r === i);
        if (it.el.getAttribute('role') === 'button') {
          it.el.setAttribute('aria-expanded', r === i ? 'true' : 'false');
        }
      });

      if (counter) counter.textContent = ('0' + (i + 1)).slice(-2);
      if (!caption) return;

      var text = items[i].text;
      clearTimeout(captionTimer);

      if (instant) {
        captionToken++;
        caption.classList.remove('is-out');
        caption.textContent = text;
        return;
      }

      // Token guard: only the newest change restores the caption, so it can
      // never be left stuck in the is-out state.
      var token = ++captionToken;
      caption.classList.add('is-out');
      captionTimer = setTimeout(function () {
        if (token !== captionToken) return;
        caption.textContent = text;
        caption.classList.remove('is-out');
      }, CONFIG.captionFade);
    }

    // Every ring move: same duration and ease both ways, always starting from
    // wherever the ring is, so a mid-travel reversal continues smoothly.
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
        onComplete : function () { animating = false; if (onDone) onDone(); }
      });
    }

    // The only way to change item. Atomic: rows, ticks, caption and ring commit
    // together and `animating` blocks input for the whole travel.
    //   instantPaint - swap rows/caption with no fade
    //   instantRing  - jump the ring instead of travelling
    //   force        - re-commit even if the index is unchanged
    function commit(i, opts) {
      opts = opts || {};
      i = Math.max(0, Math.min(steps - 1, i));
      if (i === index && !opts.force) return;

      if (CONFIG.debug) console.log('[infra] item', index + 1, '->', i + 1, 'fill', FILL[i]);

      index = i;
      paintRows(i, !!opts.instantPaint);
      paintTicks(i);
      moveRing(FILL[i], !!opts.instantRing);
    }

    // Leaving out of the top: retract segment 1 the way it was drawn. The tick
    // stays lit through the transit and goes dark once the ring is empty.
    function retreat(instant) {
      if (retreating || (index === 0 && ring.value === 0)) { paintTicks(-1); return; }

      if (index !== 0) paintRows(0, !!instant);
      index = 0;
      moveRing(0, !!instant, function () { paintTicks(-1); });
      retreating = true;                       // set after moveRing clears it
    }

    // First paint: item 1 open, ring empty, no tick lit. Segment 1 is drawn by
    // the entry (desktop) or the first auto step / tap (phone), not here.
    function prepare() {
      if (ringTween) ringTween.kill();
      index = 0;
      animating = retreating = false;
      ring.value = 0;
      drawRing();
      paintRows(0, true);
      paintTicks(-1);
    }

    prepare();

    /* ============================ PHONE ==================================
       No pin. The section keeps its Webflow height -- taller than a phone
       screen -- and scrolls like any other section, so nothing is hidden,
       nothing is resized and scrolling is never taken away from the reader.

       The items are driven by tap, not by scroll: the five rows occupy only
       ~335px, so a scroll-linked mapping would spend ~50px per item and a
       single flick would run the whole set. While the dial is on screen the
       section also walks itself through the items once, so a reader who
       never taps still sees the ring draw; the first tap takes that over
       for good.                                                           */

    function phoneFlow() {
      var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var quick = still ? { instantPaint: true, instantRing: true } : null;
      var manual = false, finished = false, timer = 0, io = null;
      var bound = [];

      unlockPage();            // never inherit a lock from the pinned branch

      function stopAuto() { clearTimeout(timer); timer = 0; }

      function tick() {
        timer = 0;
        if (manual || finished) return;
        if (index >= steps - 1) { finished = true; return; }
        commit(index + 1);
        timer = setTimeout(tick, CONFIG.phoneDwell * 1000);
      }

      function startAuto() {
        if (!CONFIG.phoneAutoplay || still || manual || finished || timer) return;
        timer = setTimeout(tick, CONFIG.phoneDwell * 1000);
      }

      function select(i) {
        manual = true;                     // the reader is driving from here on
        stopAuto();
        commit(i, quick);
      }

      items.forEach(function (it, i) {
        it.el.style.cursor = 'pointer';
        it.el.setAttribute('role', 'button');
        it.el.setAttribute('tabindex', '0');
        it.el.setAttribute('aria-expanded', i === index ? 'true' : 'false');

        var onTap = function () { select(i); };
        var onKey = function (e) {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          select(i);
        };
        it.el.addEventListener('click', onTap);
        it.el.addEventListener('keydown', onKey);
        bound.push([it.el, onTap, onKey]);
      });

      // Start the walk when the dial is actually worth watching, and pause it
      // the moment the section leaves the screen.
      if (window.IntersectionObserver && dial) {
        io = new IntersectionObserver(function (entries) {
          if (entries[0].isIntersecting) startAuto();
          else stopAuto();
        }, { threshold: 0.35 });
        io.observe(dial);
      } else {
        startAuto();
      }

      return function cleanup() {
        stopAuto();
        if (io) io.disconnect();
        bound.forEach(function (b) {
          b[0].removeEventListener('click', b[1]);
          b[0].removeEventListener('keydown', b[2]);
          b[0].style.cursor = '';
          b[0].removeAttribute('role');
          b[0].removeAttribute('tabindex');
          b[0].removeAttribute('aria-expanded');
        });
      };
    }

    /* ====================== DESKTOP + TABLET =============================
       The pinned stepper, unchanged: one gesture moves exactly one item.  */

    var FRESH = 0, INSIDE = 1, DONE = 2;

    function stepper() {
      var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      var quick = still ? { instantPaint: true, instantRing: true } : null;

      var phase      = FRESH;
      var engaged    = false;
      var refreshing = false;   // a refresh replays callbacks; not a real crossing
      var lastInput  = 0;
      var lastStep   = -1e9;
      var newGesture = true;    // turned back on by a quiet gap in the input
      var reEngageAt = 0;       // do not re-grab scrolling right after a release

      function onRefreshInit() { refreshing = true; }
      function onRefresh()     { refreshing = false; }
      ScrollTrigger.addEventListener('refreshInit', onRefreshInit);
      ScrollTrigger.addEventListener('refresh', onRefresh);

      // GSAP fires the callbacks below from inside create(), before `pin` is
      // assigned, so they use the instance handed to them via inst(). Same
      // reason the observer is built first: engage() must find a real one.
      // wheelSpeed:-1 -> onUp means the user is going down the page.
      // preventDefault is what actually holds a touch tablet still.
      var pin;
      function inst(self) { return self || pin; }

      var observer = window.Observer && Observer.create({
        target         : window,
        type           : 'wheel,touch',
        wheelSpeed     : -1,
        tolerance      : CONFIG.tolerance,
        dragMinimum    : CONFIG.touchTolerance,
        preventDefault : true,
        onUp           : function () { step(1); },
        onDown         : function () { step(-1); }
      });
      if (observer) observer.disable();

      pin = ScrollTrigger.create({
        trigger : track,
        // Normally the section is exactly one screen tall here, so it pins at
        // the top. If a short landscape tablet makes it taller, pinning at the
        // top would hide its bottom for good, so the pin aligns to the bottom
        // instead. Re-evaluated on every refresh.
        start   : function () {
          return sticky.offsetHeight > window.innerHeight ? 'bottom bottom' : 'top top';
        },
        end     : function () {
          return '+=' + Math.round(CONFIG.pinScreens * window.innerHeight);
        },
        pin                 : sticky,
        pinSpacing          : true,
        invalidateOnRefresh : true,   // no anticipatePin: Lenis already removed the lag it masks
        onEnter     : function (self) { arrive(-1, self); },   // crossed start, from above
        onEnterBack : function (self) { arrive(1, self); },    // crossed end, from below
        onLeave     : function () { leave(1); },
        onLeaveBack : function () { leave(-1); },
        onUpdate    : function (self) {
          // If an onEnter was refused during the post-release window, take the
          // input back on the next update instead of letting the reader slide
          // through the pinned range. A finished reader going down is left alone.
          if (engaged || !self.isActive) return;
          if (performance.now() < reEngageAt) return;
          if (phase === DONE && self.direction > 0) return;
          engage(self);
        }
      });

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

      // side: -1 arriving from above, +1 from below. Only a real crossing may
      // change the phase; `engaged` separates a crossing from a refresh replay.
      function arrive(side, self) {
        if (!refreshing && !engaged) {
          if (side < 0) phase = FRESH;               // over the top edge: new pass
          else if (phase === FRESH) phase = DONE;    // came up from below
        }
        engage(self);
      }

      function engage(self) {
        if (engaged || performance.now() < reEngageAt) return;

        var t = inst(self);
        if (!t) return;

        // A fast page scroll can land part-way into the pinned range before we
        // take over; reclaim it so stepping starts from a clean position. It is
        // invisible - the pinned view is identical anywhere in the range.
        if (t.progress > 0.02 && t.progress < 0.98) jumpTo(t.start + 2);

        engaged = true;
        lockPage();

        // The phase, never the scroll direction, decides what a re-entry
        // restores - and it never replays the entry animation.
        if (phase === FRESH) {
          commit(0, { instantPaint: true, instantRing: !!still, force: true });
        } else if (phase === DONE && index !== steps - 1) {
          commit(steps - 1, { instantPaint: true, instantRing: true, force: true });
        }
        phase = INSIDE;

        // The momentum tail that carried the reader in must not advance an item.
        // Backdating lastStep leaves a short entryLock instead of a full cadence,
        // so the first deliberate scroll is answered quickly.
        var t0 = performance.now();
        lastInput  = t0;
        lastStep   = t0 - Math.max(0, (CONFIG.cadence - CONFIG.entryLock) * 1000);
        newGesture = false;

        if (observer) observer.enable();
      }

      function disengage() {
        if (!engaged) return;
        engaged = false;
        unlockPage();                      // hand scrolling back before anything moves
        if (observer) observer.disable();
      }

      function leave(dir) {
        disengage();
        if (refreshing) return;            // a refresh is not a real exit
        if (dir < 0) { retreat(still); phase = FRESH; }   // out of the top: empty the ring
        else         { phase = DONE; }                    // out of the bottom: keep item 5
      }

      // Past the last (or before the first) item: hand scrolling back and jump
      // to the pin edge, so no dead pinned stretch is left to scroll through.
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
        lastInput = now;                   // every event counts, committed or not
        if (quiet) newGesture = true;

        if (!engaged || animating) return;

        // A distinct gesture steps as soon as the cadence has elapsed. Input
        // that never stops - a momentum tail, a spinning wheel, a hard flick -
        // is paced more slowly instead of chaining items together.
        var since = now - lastStep;
        if (since < CONFIG.cadence * 1000) return;
        if (!newGesture && since < CONFIG.cadence * CONFIG.sustained * 1000) return;

        var next = index + dir;
        if (next < 0 || next > steps - 1) { release(dir); return; }

        newGesture = false;
        lastStep = now;
        commit(next, quick);
      }

      if (pin && pin.isActive) engage(pin);
      if (engaged && observer && !observer.isEnabled) observer.enable();

      return function cleanup() {
        disengage();
        unlockPage();
        ScrollTrigger.removeEventListener('refreshInit', onRefreshInit);
        ScrollTrigger.removeEventListener('refresh', onRefresh);
        window.removeEventListener('keydown', onKey);
        if (observer) observer.kill();
        if (pin) pin.kill(true);
      };
    }

    var mm    = gsap.matchMedia();
    var DESK  = '(min-width: ' + CONFIG.desktopFrom + 'px)';
    var PHONE = '(max-width: ' + (CONFIG.desktopFrom - 1) + 'px)';

    mm.add(DESK + ' and (prefers-reduced-motion: no-preference)', stepper);

    // Desktop + Reduce Motion: the Page Head CSS already opens every row and
    // fills the ring, so just commit the last item to keep counter and ticks
    // in step with what is on screen.
    mm.add(DESK + ' and (prefers-reduced-motion: reduce)', function () {
      unlockPage();
      commit(steps - 1, { instantPaint: true, instantRing: true, force: true });
    });

    // Phone: one branch for every phone. Reduce Motion is honoured inside it
    // (no autoplay, no easing), not by a separate static branch -- no phone
    // CSS opens the rows, so a static branch would show one item and nothing
    // else.
    mm.add(PHONE, phoneFlow);

    // Positions are measured before webfonts land; re-measure once they do.
    function remeasure() { ScrollTrigger.refresh(); }
    window.addEventListener('load', remeasure);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(remeasure);
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', function () { init(); });
})();
