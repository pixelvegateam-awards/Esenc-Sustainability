# dot-orb

Dot-sphere canvas component plus the opportunity-section connector animation.
One file, no build step, served from jsDelivr.

- **dot-orb.js** — readable source
- **dot-orb.min.js** — 15.6 KB raw / **6.5 KB gzipped**

The orb has no dependencies. The connector module needs GSAP + ScrollTrigger and
silently does nothing if they're absent or if `.opportunity_stage` isn't on the page,
so the same file is safe to load site-wide.

---

## Install

Commit both files, then **tag a release**:

```bash
git tag v2.0.0 && git push --tags
```

In Webflow → Site Settings → Custom code → **Before `</body>`**:

```html
<script
  src="https://cdn.jsdelivr.net/gh/USER/REPO@2.0.0/dot-orb.min.js"
  integrity="sha384-curWJtazSrgfsPPNu6CekmZ/5jOfC8y8uu/LiklzAxwbStZJf0WWEbrr37lrFtBn"
  crossorigin="anonymous"
  defer></script>
```

Three things matter here:

**Pin the tag, never `@main`.** jsDelivr caches `@main` for 7 days, so a push
either doesn't appear or appears mid-session for some visitors and not others.
A tag is immutable and cached for a year. Bump the tag to deploy.

**Keep the `integrity` hash.** Same pattern as your GSAP tags. Regenerate on
every release — the hash is content-specific and a stale one blocks the file:

```bash
openssl dgst -sha384 -binary dot-orb.min.js | openssl base64 -A
```

**`defer` is enough.** The script waits for `DOMContentLoaded` itself. Don't use
`async` — with GSAP loading separately, ordering stops being guaranteed.

---

## Markup

```html
<div class="orb-wrap" data-orb data-orb-size="100%" data-orb-bleed="2.4"></div>
```

`data-orb` marks the target; the value is ignored (Webflow forces one — use `true`).

---

## Attributes

### Size

| attribute | default | |
|---|---|---|
| `data-orb-size` | — | Sphere width as a CSS length: `586`, `62vw`, `min(586px, 62vw)`, `100%`. Resolves against the div, re-resolves on resize. Overrides `radius`. |
| `data-orb-radius` | `0.42` | Sphere size as a fraction of the div. Ignored when `size` is set. |
| `data-orb-bleed` | `1` | Canvas size as a multiple of the div. `2.4` renders 2.4× larger, centred, overflowing — so the div can hug the sphere while the scatter still has room to stay round. Pair with `size="100%"`. |

With `size="100%"` + `bleed`, the sphere and the scatter both measure off the same
div, so their ratio holds at every screen width. That is the whole responsive story —
no breakpoint rules needed for the orb itself.

The div's ancestor must not clip. Use `overflow-x: clip`, not `overflow: hidden`.

### Dots

| attribute | default | |
|---|---|---|
| `data-orb-count` | `2600` | |
| `data-orb-count-sm` | — | Count below `sm-at`. Rebuilds automatically on crossing. |
| `data-orb-sm-at` | `767` | |
| `data-orb-color` | — | Defaults to the div's `color` |
| `data-orb-dot-size` | `1.5` | Dot radius, px |
| `data-orb-size-vary` | `0.45` | |
| `data-orb-jitter` | `0.35` | `0` = crisp Fibonacci spirals, `1` = fully random |
| `data-orb-min-alpha` | `0.16` | Far side |
| `data-orb-max-alpha` | `1` | Near side |
| `data-orb-halo` | `0` | |
| `data-orb-seed` | `1337` | |

### Entrance

| attribute | default | |
|---|---|---|
| `data-orb-trigger` | `view` | `view` \| `center` (div midline hits viewport middle) \| `load` |
| `data-orb-delay` | `0` | Hold the scattered cloud, ms |
| `data-orb-duration` | `2200` | Formation, ms |
| `data-orb-stagger` | `900` | Per-dot start spread, ms |
| `data-orb-scatter` | `0.7` | Cloud size as a fraction of the canvas |
| `data-orb-depth` | `0` | How far behind the sphere the dots start. `1–2.5` reads as arriving from a distance. |

Total entrance = `delay + duration + stagger`.

### Motion

| attribute | default | |
|---|---|---|
| `data-orb-speed` | `0.055` | rad/s |
| `data-orb-tilt` | `-0.3` | rad |
| `data-orb-drift` | `0.4` | Per-dot wander across the surface |
| `data-orb-wave` | `0.35` | Shared swell |
| `data-orb-drift-speed` | `1` | |
| `data-orb-perspective` | `3.2` | Lower = stronger |
| `data-orb-parallax` | `0.18` | |
| `data-orb-interactive` | `hover` | `hover` \| `drag` \| `none` |

`hover` and `none` set `pointer-events: none`, so the canvas never blocks clicks.
Only `drag` captures the pointer.

---

## API

```js
DotOrb.initAll();                       // re-scan after CMS filter / tab / modal
var orb = DotOrb.get(document.querySelector('.orb-wrap'));
orb.set({ speed: 0.2, color: '#0b1302' });
orb.replay();
orb.destroy();
```

---

## Performance

Measured at 4450 dots, 586px div, `bleed 2.4`:

| | |
|---|---|
| Geometry + sort | **0.54 ms/frame** (3% of a 60fps budget) |
| Canvas calls | 22 `fill()`, 1 `fillStyle`, 1 `clearRect` per frame |

Four things keep it there:

**Counting sort into 24 alpha tiers.** Dots are bucketed by opacity and drawn as
24 batched paths, not 4450 individual fills.

**Backing-store ceiling of 4.2M device px.** A 586px div at `bleed 2.4` is
1406×1406 CSS px — at DPR 2 that's 7.9M device px to clear and fill every frame.
DPR is scaled down to hold the ceiling: 47% fewer pixels, no visible difference
at this dot size. Smaller orbs stay at full DPR.

**Drift and wave are gated separately.** Each costs 2 `Math.sin` per dot per frame.
Setting one to `0` no longer pays for the other.

**The loop releases itself.** With `speed`, `drift` and `wave` all `0` and
`interactive="none"`, the orb draws its last frame and cancels the rAF loop
entirely. Resumes on resize.

It also pauses when scrolled out of view and when the tab is hidden, and honours
`prefers-reduced-motion` by rendering one static frame.

---

## Connectors

Activates only if `.opportunity_stage` exists and GSAP is loaded.

Reveal order per node: marker plots on the sphere edge → line draws **outward**
to the label → label fades up as the line lands. 300 ms between nodes.

The reveal reads `DotOrb`'s own elapsed clock rather than using a fixed delay.
The two components trigger at different scroll positions — the orb on
`trigger="center"`, the connectors on ScrollTrigger `top 75%` — so a hardcoded
timeout drifts apart from the sphere as scroll speed changes. Change
`data-orb-delay` and the connectors follow.

Wander tuning lives in `OCTAVES` / `PHASE` / `CFG` at the top of the module. The
endpoint is the only driver; tail, bend and stub are constants, which is why the
line can't stretch.

Per-instance overrides: `data-opp-amp`, `data-opp-amp-x`, `data-opp-amp-y`,
`data-opp-speed` on `.opportunity_wrap` or on an individual `svg[data-opp-line]`.

---

MIT
