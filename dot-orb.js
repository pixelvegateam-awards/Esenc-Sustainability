/*!
 * dot-orb 2.0.0 — dot-sphere canvas + opportunity connectors
 * Canvas 2D, no dependencies. Connectors need GSAP + ScrollTrigger.
 * MIT
 */
(function (win, doc) {
  'use strict';

  var TAU = Math.PI * 2;
  var sin = Math.sin, cos = Math.cos, sqrt = Math.sqrt, min = Math.min, max = Math.max;

  function num(v, d) { var f = parseFloat(v); return isFinite(f) ? f : d; }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ==================================================================
     Dot Orb
     ================================================================== */
  (function () {
    if (win.DotOrb) return;

    var GOLDEN  = Math.PI * (3 - sqrt(5));
    var BUCKETS = 24;
    // Backing-store ceiling. A bleed canvas can reach ~2M CSS px; at dpr 2
    // that is 8M device px to clear and fill every frame, which is where
    // large orbs start costing real time on integrated GPUs.
    var MAX_PX  = 4.2e6;
    var mq = win.matchMedia ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;

    function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

    var probe;
    function toRGB(c) {
      if (!probe) probe = doc.createElement('canvas').getContext('2d');
      probe.fillStyle = '#000';
      probe.fillStyle = c;
      var s = probe.fillStyle;
      if (s.charAt(0) === '#') {
        return [parseInt(s.substr(1, 2), 16), parseInt(s.substr(3, 2), 16), parseInt(s.substr(5, 2), 16)];
      }
      var m = s.match(/[\d.]+/g) || [255, 255, 255];
      return [+m[0], +m[1], +m[2]];
    }

    // Resolves vw / vmin / min() / clamp(). Costs a layout read, so bare
    // numbers and % are short-circuited above this in _size().
    var ruler;
    function toPx(v, el) {
      if (!ruler) {
        ruler = doc.createElement('div');
        ruler.style.cssText = 'position:absolute;left:-9999px;top:0;height:0;visibility:hidden;pointer-events:none';
      }
      el.appendChild(ruler);
      ruler.style.width = '0px';
      ruler.style.width = v;
      var px = ruler.getBoundingClientRect().width;
      ruler.parentNode.removeChild(ruler);
      return px;
    }

    function rng(seed) {
      var s = seed >>> 0 || 1;
      return function () {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5;  s >>>= 0;
        return s / 4294967296;
      };
    }

    function Orb(el, opts) {
      this.el = el;
      this.cfg = this._config(opts || {});
      this._build();
      this._mount();
    }

    Orb.prototype._config = function (o) {
      var d = this.el.dataset, cs = win.getComputedStyle(this.el);
      function pick(k, a, f) {
        return o[k] !== undefined ? o[k] : (d[a] !== undefined ? d[a] : f);
      }
      var raw = pick('color', 'orbColor', null);
      return {
        count:       max(50, Math.round(num(pick('count', 'orbCount', 2600), 2600))),
        countSm:     Math.round(num(pick('countSm', 'orbCountSm', 0), 0)),
        smAt:        num(pick('smAt', 'orbSmAt', 767), 767),
        color:       raw && raw !== 'currentColor' ? raw : cs.color,
        radius:      clamp(num(pick('radius', 'orbRadius', 0.42), 0.42), 0.05, 0.9),
        size:        String(pick('size', 'orbSize', '') || ''),
        bleed:       max(1, num(pick('bleed', 'orbBleed', 1), 1)),
        dotSize:     num(pick('dotSize', 'orbDotSize', 1.5), 1.5),
        sizeVary:    clamp(num(pick('sizeVary', 'orbSizeVary', 0.45), 0.45), 0, 1),
        speed:       num(pick('speed', 'orbSpeed', 0.055), 0.055),
        tilt:        num(pick('tilt', 'orbTilt', -0.3), -0.3),
        perspective: max(1.2, num(pick('perspective', 'orbPerspective', 3.2), 3.2)),
        minAlpha:    clamp(num(pick('minAlpha', 'orbMinAlpha', 0.16), 0.16), 0, 1),
        maxAlpha:    clamp(num(pick('maxAlpha', 'orbMaxAlpha', 1), 1), 0, 1),
        duration:    max(0, num(pick('duration', 'orbDuration', 2200), 2200)),
        stagger:     max(0, num(pick('stagger', 'orbStagger', 900), 900)),
        delay:       max(0, num(pick('delay', 'orbDelay', 0), 0)),
        scatter:     max(0, num(pick('scatter', 'orbScatter', 0.7), 0.7)),
        depth:       max(0, num(pick('depth', 'orbDepth', 0), 0)),
        jitter:      clamp(num(pick('jitter', 'orbJitter', 0.35), 0.35), 0, 1),
        drift:       clamp(num(pick('drift', 'orbDrift', 0.4), 0.4), 0, 1),
        wave:        clamp(num(pick('wave', 'orbWave', 0.35), 0.35), 0, 1),
        driftSpeed:  max(0, num(pick('driftSpeed', 'orbDriftSpeed', 1), 1)),
        halo:        clamp(num(pick('halo', 'orbHalo', 0), 0), 0, 1),
        parallax:    num(pick('parallax', 'orbParallax', 0.18), 0.18),
        interactive: String(pick('interactive', 'orbInteractive', 'hover')),
        trigger:     String(pick('trigger', 'orbTrigger', 'view')),
        seed:        Math.round(num(pick('seed', 'orbSeed', 1337), 1337))
      };
    };

    Orb.prototype._n = function () {
      var c = this.cfg;
      return (c.countSm && (win.innerWidth || 9999) <= c.smAt) ? c.countSm : c.count;
    };

    Orb.prototype._build = function () {
      var c = this.cfg, N = this._n(), rand = rng(c.seed);
      this.n = N;

      var bx = new Float32Array(N), by = new Float32Array(N), bz = new Float32Array(N);
      var sx = new Float32Array(N), sy = new Float32Array(N), sz = new Float32Array(N);
      var dl = new Float32Array(N), sv = new Float32Array(N);
      var t1 = new Float32Array(N * 3), t2 = new Float32Array(N * 3);
      var f1 = new Float32Array(N), q1 = new Float32Array(N);
      var f2 = new Float32Array(N), q2 = new Float32Array(N);
      var w1 = new Float32Array(N), w2 = new Float32Array(N);

      for (var i = 0; i < N; i++) {
        var y  = 1 - (i / (N - 1)) * 2;
        var rr = sqrt(max(0, 1 - y * y));
        var th = GOLDEN * i;
        var x = cos(th) * rr, z = sin(th) * rr;

        if (c.jitter) {
          var j = c.jitter * 0.055;
          x += (rand() - 0.5) * j; y += (rand() - 0.5) * j; z += (rand() - 0.5) * j;
          var len = sqrt(x * x + y * y + z * z) || 1;
          x /= len; y /= len; z /= len;
        }
        bx[i] = x; by[i] = y; bz[i] = z;

        var u = rand() * 2 - 1, a = rand() * TAU, s = sqrt(1 - u * u);
        var mag = 0.3 + 0.7 * Math.cbrt(rand());
        sx[i] = s * cos(a) * mag;
        sy[i] = u * mag;
        sz[i] = s * sin(a) * mag;

        dl[i] = rand() * c.stagger;
        sv[i] = 1 - c.sizeVary * rand();

        // Orthonormal tangents at this dot: drift slides ACROSS the surface,
        // so the silhouette stays crisp however hard you push it.
        var k = i * 3, rx = rand() - 0.5, ry = rand() - 0.5, rz = rand() - 0.5;
        var tx = y * rz - z * ry, ty = z * rx - x * rz, tz = x * ry - y * rx;
        var tl = sqrt(tx * tx + ty * ty + tz * tz);
        if (tl < 1e-6) { tx = -y; ty = x; tz = 0; tl = sqrt(tx * tx + ty * ty) || 1; }
        tx /= tl; ty /= tl; tz /= tl;
        t1[k] = tx; t1[k + 1] = ty; t1[k + 2] = tz;
        t2[k] = y * tz - z * ty; t2[k + 1] = z * tx - x * tz; t2[k + 2] = x * ty - y * tx;

        f1[i] = 1.4 + rand() * 2.4; q1[i] = rand() * TAU;
        f2[i] = 1.4 + rand() * 2.4; q2[i] = rand() * TAU;
        w1[i] = 2.2 * (x * 0.72 + y * 0.51 - z * 0.47);   // shared phase, so
        w2[i] = 3.1 * (-x * 0.42 + y * 0.79 + z * 0.44);  // neighbours swell together
      }

      this.p = { bx: bx, by: by, bz: bz, sx: sx, sy: sy, sz: sz, dl: dl, sv: sv,
                 t1: t1, t2: t2, f1: f1, q1: q1, f2: f2, q2: q2, w1: w1, w2: w2 };
      this.out    = new Float32Array(N * 3);
      this.sorted = new Float32Array(N * 3);
      this.bucket = new Uint8Array(N);
      this.counts = new Int32Array(BUCKETS);
      this.starts = new Int32Array(BUCKETS);
      this.head   = new Int32Array(BUCKETS);
      this._color(c.color);
    };

    Orb.prototype._color = function (c) {
      var v = toRGB(c);
      this.rgb = v;
      this.css = 'rgb(' + v[0] + ',' + v[1] + ',' + v[2] + ')';
    };

    Orb.prototype._mount = function () {
      var self = this, el = this.el, drag = this.cfg.interactive === 'drag';

      if (win.getComputedStyle(el).position === 'static') el.style.position = 'relative';

      var cv = this.canvas = doc.createElement('canvas');
      cv.setAttribute('aria-hidden', 'true');
      var b = this.cfg.bleed, off = (b - 1) * 50;
      cv.style.cssText = 'position:absolute;left:' + (-off) + '%;top:' + (-off) + '%;width:' +
        (b * 100) + '%;height:' + (b * 100) + '%;display:block;' +
        (drag ? 'cursor:grab;touch-action:pan-y' : 'pointer-events:none');
      el.appendChild(cv);
      this.ctx = cv.getContext('2d', { alpha: true });

      this.angle = this.spin = this.t = this.clock = this.last = 0;
      this.px = this.py = this.tx = this.ty = 0;
      this.w = this.h = this.raf = 0;
      this.started = this.cfg.trigger === 'load';
      this.visible = true;

      this._onResize = function () { self._resize(); };
      if (win.ResizeObserver) {
        this.ro = new ResizeObserver(this._onResize);
        this.ro.observe(el);
      } else {
        win.addEventListener('resize', this._onResize);
      }

      if (win.IntersectionObserver) {
        this.io = new IntersectionObserver(function (e) {
          var vis = e[0].isIntersecting;
          self.visible = vis;
          if (vis && !self.started && self.cfg.trigger === 'view') { self.started = true; self.t = 0; }
          if (vis) self._play(); else self._pause();
        }, { threshold: 0.08 });
        this.io.observe(el);
      }

      this._onVis = function () { if (doc.hidden) self._pause(); else self._play(); };
      doc.addEventListener('visibilitychange', this._onVis);

      if (this.cfg.interactive === 'hover' || drag) this._pointer(drag);
      if (mq && mq.addEventListener) {
        this._onMQ = function () { self._resize(); };
        mq.addEventListener('change', this._onMQ);
      }

      this._resize();
      this._play();
    };

    Orb.prototype._pointer = function (drag) {
      var self = this, el = this.el, down = false, lastX = 0;

      this._onMove = function (e) {
        var r = el.getBoundingClientRect();
        if (!r.width) return;
        self.tx = clamp(((e.clientX - r.left) / r.width - 0.5) * 2, -1, 1);
        self.ty = clamp(((e.clientY - r.top) / r.height - 0.5) * 2, -1, 1);
        if (down) { self.spin += (e.clientX - lastX) * 0.006; lastX = e.clientX; }
        self._play();
      };
      this._onLeave = function () { self.tx = self.ty = 0; self._play(); };
      el.addEventListener('pointermove', this._onMove, { passive: true });
      el.addEventListener('pointerleave', this._onLeave, { passive: true });

      if (!drag) return;
      this._onDown = function (e) {
        down = true; lastX = e.clientX;
        self.canvas.style.cursor = 'grabbing';
        if (self.canvas.setPointerCapture) self.canvas.setPointerCapture(e.pointerId);
      };
      this._onUp = function () { down = false; self.canvas.style.cursor = 'grab'; };
      this.canvas.addEventListener('pointerdown', this._onDown, { passive: true });
      win.addEventListener('pointerup', this._onUp, { passive: true });
    };

    // % and bare numbers avoid the ruler, so the common cases cost no layout.
    Orb.prototype._size = function (r) {
      var v = this.cfg.size;
      if (!v) return 0;
      var n = parseFloat(v), s = v.trim();
      if (String(n) === s) return n > 0 ? n : 0;
      if (s.charAt(s.length - 1) === '%' && isFinite(n)) return r.width * n / 100;
      return max(0, toPx(v, this.el));
    };

    Orb.prototype._resize = function () {
      var r = this.el.getBoundingClientRect();
      if (!r.width || !r.height) return;

      var b = this.cfg.bleed;
      this.w = r.width * b;
      this.h = r.height * b;
      this.sizePx = this._size(r);
      if (this.n !== this._n()) { var keep = this.t; this._build(); this.t = keep; }

      var dpr = min(win.devicePixelRatio || 1, 2);
      var area = this.w * this.h;
      if (area * dpr * dpr > MAX_PX) dpr = max(1, sqrt(MAX_PX / area));

      this.canvas.width  = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (!this.raf) this._draw(mq && mq.matches ? 1 : 0);
    };

    // Nothing left to animate: draw the last frame and release the loop.
    Orb.prototype._idle = function () {
      var c = this.cfg;
      return c.interactive === 'none' && !c.speed && !c.drift && !c.wave &&
             Math.abs(this.spin) < 1e-4 &&
             this.started && this.t > c.delay + c.duration + c.stagger + 400;
    };

    Orb.prototype._play = function () {
      if (this.raf || !this.visible || doc.hidden || this.dead) return;
      if (mq && mq.matches) { this._draw(1); return; }
      var self = this;
      this.last = 0;
      this.raf = win.requestAnimationFrame(function (ts) { self._frame(ts); });
    };

    Orb.prototype._pause = function () {
      if (this.raf) { win.cancelAnimationFrame(this.raf); this.raf = 0; }
    };

    Orb.prototype._frame = function (ts) {
      var self = this;
      var dt = this.last ? min((ts - this.last) / 1000, 0.05) : 0.016;
      this.last = ts;

      if (!this.started && this.cfg.trigger === 'center') {
        // Bounded: only runs between entering view and crossing the midline.
        // d < 0 means it already scrolled past, so a fast flick can't skip it.
        var r = this.el.getBoundingClientRect();
        var vh = win.innerHeight || doc.documentElement.clientHeight || 0;
        var d = (r.top + r.height / 2) - vh / 2;
        if (d < 0 || Math.abs(d) < vh * 0.35) { this.started = true; this.t = 0; }
      }

      if (this.started) this.t += dt * 1000;
      this.clock += dt;
      this.angle += (this.cfg.speed + this.spin) * dt;
      this.spin *= Math.pow(0.02, dt);
      this.px += (this.tx - this.px) * min(1, dt * 4);
      this.py += (this.ty - this.py) * min(1, dt * 4);

      this._draw();

      if (this._idle()) { this.raf = 0; return; }
      this.raf = win.requestAnimationFrame(function (n) { self._frame(n); });
    };

    Orb.prototype._draw = function (force) {
      var ctx = this.ctx, c = this.cfg, p = this.p, N = this.n;
      if (!this.w) return;

      var cx = this.w / 2, cy = this.h / 2;
      var fov = c.perspective, mn = min(this.w, this.h);

      // A unit sphere's visible limb projects to fov/sqrt(fov^2-1); invert it
      // so cfg.size can be given as the on-screen diameter.
      var rFrac = this.sizePx > 0
        ? clamp(this.sizePx * 0.5 * sqrt(fov * fov - 1) / fov / mn, 0.02, 0.9)
        : c.radius;
      var R = mn * rFrac;

      ctx.clearRect(0, 0, this.w, this.h);

      if (c.halo > 0) {
        var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.5);
        g.addColorStop(0, 'rgba(' + this.rgb + ',' + (0.14 * c.halo).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(' + this.rgb + ',0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.fillRect(cx - R * 1.5, cy - R * 1.5, R * 3, R * 3);
      }

      var yaw = this.angle + this.px * c.parallax;
      var pitch = c.tilt - this.py * c.parallax * 0.6;
      var ca = cos(yaw), sa = sin(yaw), ct = cos(pitch), st = sin(pitch);

      var out = this.out, bucket = this.bucket, counts = this.counts, starts = this.starts;
      var dur = max(1, c.duration);
      var fade = force ? 1 : clamp(this.t / 350, 0, 1);

      // Scatter is measured against the CANVAS, the sphere against cfg.size or
      // the element. Dividing rFrac back out keeps the two independent.
      var ss  = c.scatter / rFrac;
      var ssx = ss * (this.w > this.h ? min(this.w / this.h, 2.5) : 1);
      var ssz = 1.9 * ss / (ss + 1.1);

      var T = this.clock, Td = T * c.driftSpeed;
      var dr = c.drift * 0.05, wv = c.wave * 0.07, ws = 0.55 * c.driftSpeed;
      // Gated separately: wave costs 2 sin/dot and drift 2 more, so a config
      // with one of them at 0 must not pay for the other.
      var doDrift = dr > 0, doWave = wv > 0, live0 = doDrift || doWave;
      var dep = force ? 0 : c.depth;

      // Hoisted: 16 property loads per dot per frame otherwise.
      var bx = p.bx, by = p.by, bz = p.bz, sxa = p.sx, sya = p.sy, sza = p.sz;
      var dl = p.dl, sv = p.sv, T1 = p.t1, T2 = p.t2;
      var F1 = p.f1, Q1 = p.q1, F2 = p.f2, Q2 = p.q2, W1 = p.w1, W2 = p.w2;
      var minA = c.minAlpha, dA = c.maxAlpha - minA, ds = c.dotSize, drift = c.drift;

      counts.fill(0);
      var live = 0;

      for (var i = 0; i < N; i++) {
        var t = force ? 1 : (this.t - c.delay - dl[i]) / dur;
        t = t <= 0 ? 0 : (t >= 1 ? 1 : ease(t));

        var gx = bx[i], gy = by[i], gz = bz[i], s1 = 0, s2 = 0;
        if (live0) {
          if (doWave) {                       // wave scales the base position
            var rad = 1 + wv * (0.6 * sin(T * ws + W1[i]) + 0.4 * sin(T * ws * 0.73 + W2[i]));
            gx *= rad; gy *= rad; gz *= rad;
          }
          if (doDrift) {                      // drift is added on top of it
            s1 = sin(Td * F1[i] + Q1[i]);
            s2 = sin(Td * F2[i] + Q2[i]);
            var k3 = i * 3, o1 = dr * s1, o2 = dr * s2;
            gx += T1[k3] * o1 + T2[k3] * o2;
            gy += T1[k3 + 1] * o1 + T2[k3 + 1] * o2;
            gz += T1[k3 + 2] * o1 + T2[k3 + 2] * o2;
          }
        }

        var ax = sxa[i] * ssx, ay = sya[i] * ss, az = sza[i] * ssz;
        var x = ax + (gx - ax) * t, y = ay + (gy - ay) * t, z = az + (gz - az) * t;

        var rx = x * ca + z * sa;
        var rz = z * ca - x * sa;
        var ry = y * ct - rz * st;
        var rw = y * st + rz * ct;
        // Recede in CAMERA space. In model space, yaw orbits the whole cloud
        // sideways instead of spinning it.
        if (dep) rw += dep * (1 - t);

        var q = fov / (fov + rw);
        if (q <= 0.05) continue;

        var near = clamp((1 - rw) * 0.5, 0, 1);
        var a = (minA + dA * near) * fade;
        if (doDrift) a *= 1 + 0.16 * drift * s1 * t;
        if (a <= 0.004) continue;

        var k = live * 3;
        out[k]     = cx + rx * R * q;
        out[k + 1] = cy + ry * R * q;
        out[k + 2] = max(0.35, ds * sv[i] * (0.6 + 0.7 * near) * q *
                              (doDrift ? 1 + 0.14 * drift * s2 * t : 1));
        var tier = a >= 1 ? BUCKETS - 1 : (a * BUCKETS) | 0;
        bucket[live] = tier; counts[tier]++;
        live++;
      }

      // Counting sort into alpha tiers: 24 fill() calls a frame instead of N.
      var off = 0, head = this.head, sorted = this.sorted, bi;
      for (bi = 0; bi < BUCKETS; bi++) { starts[bi] = head[bi] = off; off += counts[bi]; }
      for (var j = 0; j < live; j++) {
        var dst = head[bucket[j]]++ * 3, src = j * 3;
        sorted[dst] = out[src]; sorted[dst + 1] = out[src + 1]; sorted[dst + 2] = out[src + 2];
      }

      ctx.fillStyle = this.css;
      for (bi = 0; bi < BUCKETS; bi++) {
        var n2 = counts[bi];
        if (!n2) continue;
        ctx.globalAlpha = (bi + 0.5) / BUCKETS;
        ctx.beginPath();
        for (var m = starts[bi], e = m + n2; m < e; m++) {
          var o = m * 3, ox = sorted[o], oy = sorted[o + 1], orr = sorted[o + 2];
          ctx.moveTo(ox + orr, oy);
          ctx.arc(ox, oy, orr, 0, TAU);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    Orb.prototype.replay = function () { this.t = 0; this.started = true; this._play(); };

    Orb.prototype.set = function (patch) {
      var rebuild = false, k;
      for (k in patch) {
        if (!patch.hasOwnProperty(k)) continue;
        this.cfg[k] = patch[k];
        if (k === 'count' || k === 'countSm' || k === 'jitter' || k === 'stagger' ||
            k === 'sizeVary' || k === 'seed') rebuild = true;
        if (k === 'color') this._color(patch[k]);
      }
      if (patch.size !== undefined) this.sizePx = this._size(this.el.getBoundingClientRect());
      if (rebuild) { var t = this.t; this._build(); this.t = t; }
      this._play();
      if (!this.raf) this._draw(mq && mq.matches ? 1 : 0);  // paused, idle or reduced
      return this;
    };

    Orb.prototype.destroy = function () {
      this.dead = true;
      this._pause();
      if (this.ro) this.ro.disconnect();
      if (this.io) this.io.disconnect();
      doc.removeEventListener('visibilitychange', this._onVis);
      win.removeEventListener('resize', this._onResize);
      win.removeEventListener('pointerup', this._onUp);
      if (mq && mq.removeEventListener && this._onMQ) mq.removeEventListener('change', this._onMQ);
      if (this._onMove) this.el.removeEventListener('pointermove', this._onMove);
      if (this._onLeave) this.el.removeEventListener('pointerleave', this._onLeave);
      if (this.canvas) this.canvas.remove();
      this.el.__orb = null;
    };

    win.DotOrb = {
      version: '2.0.0',
      init: function (el, opts) {
        if (!el || el.__orb) return el && el.__orb;
        return (el.__orb = new Orb(el, opts));
      },
      initAll: function (root) {
        var list = (root || doc).querySelectorAll('[data-orb]'), made = [], i;
        for (i = 0; i < list.length; i++) made.push(win.DotOrb.init(list[i]));
        return made;
      },
      get: function (el) { return el && el.__orb; }
    };
  })();

  /* ==================================================================
     Opportunity connectors — needs GSAP + ScrollTrigger, no-ops without.
     ================================================================== */
  function connectors() {
    if (win.__oppConnectorsBound || !win.gsap) return;

    var gsap = win.gsap;

    // Weighted toward the slow bands. Raising the last two makes the endpoint
    // reverse more often, which reads as jitter; raising the first two makes
    // it roam further at the same reversal rate.
    var OCTAVES = [
      { period: 2.00, amp: 1.00 },
      { period: 1.00, amp: 0.56 },
      { period: 0.42, amp: 0.25 },
      { period: 0.21, amp: 0.06 }
    ];
    var Y_SCALE = 0.87;

    var PHASE = {
      one:   { x: 0.00, y: 1.10 },
      two:   { x: 2.20, y: 3.60 },
      three: { x: 4.30, y: 0.50 }
    };
    var DEF_PHASE = { x: 1.00, y: 2.40 };

    var CFG = {
      ampX: 30, yRatio: 0.667, speed: 1.1,
      stagger: 0.30, draw: 0.80, mark: 0.42, label: 0.45, lead: 0.12,
      gap: 0, fallback: 2.0, bail: 9.0, start: 'top 75%'
    };

    var sum = 0, oi;
    for (oi = 0; oi < OCTAVES.length; oi++) sum += OCTAVES[oi].amp;
    for (oi = 0; oi < OCTAVES.length; oi++) OCTAVES[oi].w = OCTAVES[oi].amp / sum;

    function attr(el, name, fb, allowZero) {
      if (!el) return fb;
      var v = parseFloat(el.getAttribute(name));
      return (isFinite(v) && (allowZero ? v >= 0 : v > 0)) ? v : fb;
    }

    function points(d) {
      var n = (d.match(/-?\d*\.?\d+/g) || []).map(Number);
      return n.length < 8 ? null
        : [[n[0], n[1]], [n[2], n[3]], [n[4], n[5]], [n[6], n[7]]];
    }

    function wander(t, phase, scale) {
      var v = 0;
      for (var i = 0; i < OCTAVES.length; i++) {
        var o = OCTAVES[i];
        v += sin((t / (o.period * scale)) * TAU + phase * (i + 1)) * o.w;
      }
      return v;
    }

    function measure(svg) {
      var line = svg.querySelector('[data-opp-path]');
      var g    = svg.querySelector('[data-opp-marker]');
      if (!line || !g) return null;

      var ring = g.querySelector('[data-opp-ring]');
      var pts  = points(line.getAttribute('d') || '');
      if (!ring || !pts) return null;

      // Hover was dropped; strip its leftovers so they can't paint or
      // swallow pointer events.
      var dead = svg.querySelectorAll('[data-opp-square],[data-opp-hit]');
      for (var i = 0; i < dead.length; i++) dead[i].parentNode.removeChild(dead[i]);

      var host = svg.closest ? svg.closest('[class*="opportunity_node"]') : null;

      return {
        svg: svg, line: line, g: g, ring: ring,
        dot:   g.querySelector('[data-opp-dot]'),
        label: host ? host.querySelector('.opportunity_text') : null,
        tail:  pts[0],
        head:  pts[3],
        bendX: pts[1][0],                 // fixed: first segment never moves
        run:   pts[2][0] - pts[3][0],     // constant: last segment keeps its length
        mdx:   parseFloat(ring.getAttribute('cx')) - pts[3][0],
        mdy:   parseFloat(ring.getAttribute('cy')) - pts[3][1],
        ph:    PHASE[svg.getAttribute('data-opp-line') || ''] || DEF_PHASE,
        ampX: 0, ampY: 0
      };
    }

    // One driver — the endpoint. Tail, bend and stub are constants, which is
    // why the line can never stretch or look rubbery.
    function draw(n, hx, hy) {
      var b2x = hx + n.run;
      b2x = n.run < 0 ? max(b2x, n.bendX + 1) : min(b2x, n.bendX - 1);

      n.line.setAttribute('d',
        'M' + n.tail[0] + ' ' + n.tail[1] +
        'L' + n.bendX + ' ' + n.tail[1] +
        'L' + b2x + ' ' + hy +
        'L' + hx + ' ' + hy);

      var mx = hx + n.mdx, my = hy + n.mdy;
      n.ring.setAttribute('cx', mx);
      n.ring.setAttribute('cy', my);
      if (n.dot) { n.dot.setAttribute('cx', mx); n.dot.setAttribute('cy', my); }
    }

    var stage = doc.querySelector('.opportunity_stage');
    if (!stage) return;

    var svgs = stage.querySelectorAll('svg[data-opp-line]');
    var nodes = [], i;
    for (i = 0; i < svgs.length; i++) {
      var m = measure(svgs[i]);
      if (m) nodes.push(m);
    }
    if (!nodes.length) return;

    win.__oppConnectorsBound = true;

    var wrap   = stage.querySelector('.opportunity_wrap') || stage;
    var legacy = attr(wrap, 'data-opp-amp', CFG.ampX, true);
    var baseX  = attr(wrap, 'data-opp-amp-x', legacy, true);
    var baseY  = attr(wrap, 'data-opp-amp-y', legacy * CFG.yRatio, true);
    var speed  = attr(wrap, 'data-opp-speed', CFG.speed);

    for (i = 0; i < nodes.length; i++) {
      nodes[i].ampX = attr(nodes[i].svg, 'data-opp-amp-x', baseX, true);
      nodes[i].ampY = attr(nodes[i].svg, 'data-opp-amp-y', baseY, true);
      draw(nodes[i], nodes[i].head[0], nodes[i].head[1]);
    }

    if (win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (i = 0; i < nodes.length; i++) {
        gsap.set(nodes[i].g, { opacity: 1 });
        if (nodes[i].label) gsap.set(nodes[i].label, { opacity: 1 });
      }
      return;
    }

    // Hidden at init, not at reveal: otherwise everything paints on load and
    // blinks away when the trigger fires.
    for (i = 0; i < nodes.length; i++) {
      var L = nodes[i].line.getTotalLength();
      // Negative offset reveals from the path's END — the sphere — so the
      // line grows outward toward its label.
      gsap.set(nodes[i].line, { strokeDasharray: L + ' ' + L, strokeDashoffset: -L });
      gsap.set(nodes[i].g, { opacity: 0 });
      if (nodes[i].label) gsap.set(nodes[i].label, { opacity: 0, y: 10 });
    }

    var running = false;

    function reveal() {
      var last = 0;
      for (var i = 0; i < nodes.length; i++) {
        (function (n, at) {
          var origin = n.ring.getAttribute('cx') + ' ' + n.ring.getAttribute('cy');

          gsap.fromTo(n.g,
            { opacity: 0, scale: 0.3, svgOrigin: origin },
            { opacity: 1, scale: 1, svgOrigin: origin, duration: CFG.mark,
              ease: 'back.out(2.2)', delay: at });

          gsap.to(n.line, {
            strokeDashoffset: 0, duration: CFG.draw, ease: 'power2.inOut',
            delay: at + CFG.lead,
            onComplete: function () {
              gsap.set(n.line, { clearProps: 'strokeDasharray,strokeDashoffset' });
            }
          });

          if (n.label) {
            gsap.to(n.label, {
              opacity: 1, y: 0, duration: CFG.label, ease: 'power2.out',
              delay: at + CFG.lead + CFG.draw * 0.55
            });
          }
        })(nodes[i], i * CFG.stagger);

        last = max(last, i * CFG.stagger + CFG.lead + CFG.draw);
      }
      // Dash length was measured off one pose, so hold the wander until every
      // stroke has finished drawing or it lands short.
      gsap.delayedCall(last, function () { running = true; });
    }

    // Follow the sphere's own clock. The two components trigger at different
    // scroll positions, so any fixed delay drifts as scroll speed changes.
    function armed() {
      var orb = win.DotOrb && win.DotOrb.get(doc.querySelector('[data-orb]'));
      if (!orb) { gsap.delayedCall(CFG.fallback, reveal); return; }

      var formed = orb.cfg.delay + orb.cfg.duration + orb.cfg.stagger + CFG.gap * 1000;
      var t0 = gsap.ticker.time;
      var watch = function () {
        if (orb.t >= formed || gsap.ticker.time - t0 > CFG.bail) {
          gsap.ticker.remove(watch);
          reveal();
        }
      };
      gsap.ticker.add(watch);
    }

    gsap.ticker.add(function () {
      if (!running) return;
      var t = gsap.ticker.time * speed;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        draw(n,
          n.head[0] + wander(t, n.ph.x, 1) * n.ampX,
          n.head[1] + wander(t, n.ph.y, Y_SCALE) * n.ampY);
      }
    });

    if (win.ScrollTrigger) {
      gsap.registerPlugin(win.ScrollTrigger);
      win.ScrollTrigger.create({ trigger: stage, start: CFG.start, once: true, onEnter: armed });
    } else {
      armed();
    }
  }

  function boot() {
    win.DotOrb.initAll();
    connectors();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

})(window, document);
