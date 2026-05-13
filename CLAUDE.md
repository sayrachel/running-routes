# Running Routes - Project Instructions

## App Store / TestFlight Builds

- **ALWAYS bump the iOS build number** in `app.json` (`expo.ios.buildNumber`) before building for TestFlight. Each TestFlight submission requires a unique build number.
- After bumping, commit and push before running the build.
- Build command: `eas build --platform ios --profile production --non-interactive` (uses global `eas` at `/opt/homebrew/bin/eas`)
- Submit command: `eas submit --platform ios --latest` — **must be run by the user in a separate terminal** (requires interactive Apple authentication, cannot run non-interactively)

## Production OSRM Constraints — READ BEFORE TOUCHING `lib/osrm.ts`

Production hits the **free public** `router.project-osrm.org` endpoint. It is rate-limited and tail-latency-prone. Concrete lessons from past regressions:

- **Total simultaneous request count matters more than per-candidate math.** A change that "only adds 2 parallel calls per candidate" with 7 candidates = 21 simultaneous requests. The endpoint will throttle that burst and return nulls. Keep the steady-state in-flight count ≤ candidate count (currently 7).
- **The harness does NOT validate against the public endpoint.** `--synthetic` uses mock OSRM (zero latency, zero failure rate). Local OSRM (`--osrm-base http://localhost:5000/...`) has no rate limits. **Neither environment can detect a regression that only manifests under public-OSRM rate limiting.** A "quality bumped X/N → Y/N" number from the harness is a claim about algorithm correctness, NOT about endpoint behavior.
- **Tail latency on public OSRM is real.** Typical 200-700ms, busy 1-2s, occasional 3-5s spikes. `OSRM_TIMEOUT_MS` is currently 8s. Don't tighten it without a way to measure the resulting null-rate against real users.
- **NEVER let the algorithm display non-OSRM geometry as a route.** The straight-line-waypoints-as-route bug (Build 21) happened because a fallback branch pushed raw input waypoints when OSRM returned null. If OSRM fails for a candidate: reject it. If all candidates fail: surface "No routes found" rather than draw lines through buildings.

### Pre-flight checklist for any change that touches OSRM call patterns (volume, timeout, hedging, caching) or quality gates

1. Run `npm test` and `npm run quality -- --synthetic`. Baselines: ~357/357 unit tests, ~59/60 synthetic harness (the 1 fail is `nyc-les-1mi-loop-quiet`, pre-existing).
2. **Run `npm run quality:real`** — exercises every fixture against `router.project-osrm.org` and diffs against `lib/__tests__/fixtures/real-osrm-baseline.json`. Catches the harness/prod gap that `--synthetic` is structurally blind to (real-OSRM dense-grid pathologies, tail latency, rate limiting). Takes ~5 minutes (3s per fixture spacing). Exit code 1 on any regressed fixture. If a regression is real (the algorithm legitimately got worse for a fixture), fix it. If a regression is intended (the algorithm legitimately got better and the baseline is stale), refresh with `npm run quality:real:record`.
3. **Manually generate ≥5 routes against public OSRM** from the actual app (or a dev build) before committing the change. Cover: a quick repeat (cache hit case), a fresh location (cold case), and a hard case (water-bounded grid like LES or DUMBO). If any route renders as straight lines or obviously degenerate triangles — STOP and investigate; even `quality:real` may not catch this.
4. Don't ship a perf claim ("X% faster", "wall-clock from A to B") that wasn't measured against the production endpoint. Local/mock numbers are NOT a proxy.

### Real-OSRM CI workflow

- `npm run quality:real` — runs all fixtures against public OSRM, diffs metrics against the committed baseline. Per-fixture verdict is one of UNCHANGED / IMPROVED / REGRESSED / NEW / MISSING. Tolerances: ±0.30mi distance error, ±0.05 retrace/overlap, ±1.0 turns/km, ±1.0 aspect, ±0.05 PP, ±2.0 cluster. Discrete-count metrics (stubs, pendant loops, anchors) flag any change.
- `npm run quality:real:record` — overwrites `lib/__tests__/fixtures/real-osrm-baseline.json` with current results. Run this only after a deliberate algorithm improvement; commit the new baseline alongside the algorithm change so reviewers can see the per-fixture impact.
- The baseline is stored deterministically (rounded to 2 decimal places). Public-OSRM responses are NOT byte-stable across days, so small unrounded jitter is expected and the tolerances above are sized to absorb it.

## Key Files

- `app.json` — Expo config (build number, permissions, plugins)
- `eas.json` — EAS build profiles
- `lib/theme.ts` — Design tokens (colors, fonts, spacing)
- `assets/icon.png` — App icon (1024x1024, no rounded corners)
- `ios/RunningRoutes/PrivacyInfo.xcprivacy` — Privacy manifest (gitignored, regenerated on build)

## Privacy Policy

- Hosted at: https://docs.google.com/document/d/e/2PACX-1vRCYKfkq6s1kWEMNCX_NOYRV8i-egoughcvQn3XLR1XZjrj3qzEHMVAvCnYKAFZz2-pzqgzQIS-RKmx/pub
- In-app privacy policy opens this URL in the native browser
- Contact email: irachelma@gmail.com

## Current Status / Open Issues

- **QA harness solved:** the algorithm now QAs end-to-end without screenshots. Synthetic green-space fixtures replace Overpass; deterministic mock OSRM (`mockOSRMRoute` in `lib/osrm.ts`) replaces the public router. Run with `npm run quality -- --synthetic` (mock + deterministic seeding default-on with `--synthetic`); ~5s for 17 fixtures, byte-identical across runs.
- **Algorithm bugs found and fixed via the harness:**
  1. `removeSelfintersections` chopped ~75% of out-and-back routes (treated natural retraces as lollipops). Fix: skip for out-and-back; recompute distance from emitted points.
  2. Geometric loop fallback used `2π` (full-circle) math for what's actually a triangle — undershot target by 20-30%. Fix: triangle perimeter factor `2 + 2·sin(105°) ≈ 3.93`.
  3. `removeWaterCrossings` used a flat 1.5km threshold that dropped both waypoints on every loop ≥4mi (natural wp1→wp2 chord exceeds 1.5km). Fix: threshold scales with route distance.
  4. `removeWaterCrossings` didn't sync the parallel `anchors` array when replacing/dropping waypoints — downstream naming and `expandParkWaypoints` used stale data. Fix: new `removeWaterCrossingsWithAnchors()` that returns both arrays in lockstep.
  5. `selectGreenSpaceWaypoints` returned null too easily for clustered locations (LES has 7 greens all to the N or E → 1 sector → 1 pick → null → geometric fallback). Fix: top-N-by-score backfill when sectoring leaves <2 picks; lowered strict-mode count requirement from 3 to 2.
  6. `minCenterDist` ran AFTER picks were made, dropping picks too late for fallback to recover. Fix: moved upstream to the `annotated` filter; lowered formula from `max(0.8, dist × 0.12)` to `max(0.3, dist × 0.08)`.
  7. `computeGreenSpaceProximity` under-sampled (10 samples for 161 points → routes that briefly visited parks scored 0%). Fix: sample to ~50 points instead of ~10.
  8. Multi-anchor route names dropped the second anchor ("East River Park Loop" instead of "East River Park & Tompkins Loop"). Fix: mention up to 2 anchors with `pickRouteName`.
- **Current quality:** 17/17 harness fixtures pass distance, retrace, overlap thresholds. 16/17 produce named green-space anchors (the lone "(none)" is an 8mi loop where green spaces are too close to center for a meaningful triangle). 268/268 unit tests pass.
- **Mock limitations:** harness skips `removeSelfintersections` in mock mode (smooth wobble creates false-positive crossings that real OSRM wouldn't produce). Production keeps the original behavior.

### Real-OSRM QA work (Apr 2026)

Local OSRM server (NYC-only data at `/Users/rachelma/osrm-data/`) lets the harness exercise real road geometry instead of mock wobble. Run with `--osrm-base http://localhost:5000/route/v1/foot`. See `reference_qa_workflow.md` in user memory for the workflow.

Bugs found and fixed:
9. `fetchOSRMRouteAdjusted` iteration could oscillate wildly (10km → 28km → 7km → 11km) when scaling waypoints across barriers. Fix: cap per-step scale to [0.80, 1.25], add divergence detection (return best-so-far if attempt is 2× worse than best), reduce damping 0.85 → 0.7.
10. `harness` reported out-of-region fixtures (SF/Chi/LA/Boston) as failures. Fix: detect degenerate result (pts < 10 && dist < 0.5km) and mark as SKIP.
11. Quality scoring picked clean-but-short over close-to-target-with-retrace, but the harness rounds distance to nearest mile so a 78% candidate fails "rounds to N". Fix: add rounding penalty (0.4 per mile of rounded delta).
12. Candidate pool was 7 (3 strategies × 2-3 variants), small enough that dense-grid runs often had no clean candidate near target. Fix: increase to 12.

Fixtures expanded from 15 NYC + 8 OOR to 25 NYC + 8 OOR (added Tribeca, UWS, UES, Chelsea, Brooklyn Heights, DUMBO).

Current real-OSRM pass rates (geometric-fallback, no Overpass — production has Overpass so should be better):
- Random seed: ~12-14/25
- Deterministic seed: 14/25
- With `--synthetic` (simulating production Overpass): 15-16/25

Inherent limits — water-bounded tight grids (LES 4-6mi, DUMBO, Brooklyn Heights) can't get clean target-distance loops without retrace. Algorithm makes the best of bad options; harness fails them as designed.

### Build 21 quality regression (Apr 2026, fixed in Build 22)

Three speed-focused commits compounded into a serious regression: short loops rendered as long parallel out-and-backs, triangle "fallbacks" cut through buildings and across the East River as straight lines.

Root causes:
13. **Hedging tripled OSRM request volume** (1 call per candidate → 3 parallel scaled attempts). With 7 candidates, that's ~21 simultaneous calls hitting public OSRM → rate limiting → many nulls. Harness measured "11/25 → 13/25" because local OSRM has no rate limits. Fix: removed hedging entirely; restored sequential first attempt + iterative refinement.
14. **5s OSRM timeout was too aggressive** for the public endpoint's tail latency (occasional 3-5s legitimate responses became nulls). Fix: restored 8s.
15. **Latent bug: when OSRM returned null, the algorithm pushed RAW INPUT WAYPOINTS as the displayed route** (the `else` branch in step 3 of `generateOSRMRoutes`). This had been there since early development but rarely fired because OSRM rarely failed. Build 21's hedge made nulls common, exposing the bug as straight-line triangles through buildings. Fix: reject candidates with null OSRM routes; if all fail, surface "no routes found" instead of geometric noise.

Speed wins kept in Build 22:
- Progressive candidate resolution with early exit when `qualityPenalty < 0.20` (most generations exit before the slowest candidate finishes).
- OSRM cache persisted to AsyncStorage (`lib/osrm-persist.ts`) — repeat generations from the same start hit cache on the recurring green-space anchors.
- Overpass cache persistence (already shipped Build 21, kept).
- OSRM connection prewarm on `ctx.center` becoming available (already shipped Build 21, kept).

### Build 23 spur regression (Apr 2026)

User reported a visible westward spur on a 4mi N. Williamsburg / Greenpoint quiet
loop — the route shot ~280m out toward the Marsha P. Johnson State Park
waterfront strip, U-turned 180°, came back, and continued. This kind of
"peninsula visit" was technically a stub but slipped past every detector.

Root causes:
16. **`trimStubs` `maxStubLenKm` was 150m by default.** The user's spur had
   ~280m out and ~280m back, so `findStubOutStart` saw out.len > maxLen and
   skipped trimming. Spurs from 150m–500m sailed through. Fix: bump default
   to 300m. Catches the common 200–300m peninsula stubs without trimming
   genuine 500m+ peninsulas (those might be intentional).
17. **The chooser preferred candidates with visible backtracking over
   alternatives that just rounded to the wrong mile.** A candidate with
   retrace 22% / overlap 13% (clearly broken-looking) won at quality
   penalty 0.45 because alternatives carried a 0.4 rounding penalty (e.g.
   "rounds to 3mi when you asked for 4mi"). Fix: hard-reject any candidate
   where `retrace + overlap > 0.50` — only fires on truly egregious cases,
   doesn't regress areas where ALL candidates are moderately retrace-y.

Harness gaps that hid this from CI:
18. **`prefillOverpassCaches` keyed at the per-fixture radius, but
   `fetchGreenSpacesAndHighways` always reads at `MAX_OVERPASS_RADIUS_KM`
   (10km).** The keys never matched, so synthetic green spaces silently
   never loaded. Every `--synthetic` harness run was actually testing the
   geometric-fallback path, NOT the green-space-first algorithm production
   users actually hit. Fix: prefill at `MAX_OVERPASS_RADIUS_KM` to match.
19. **`--osrm-base` disabled deterministic seeding.** The flag set
   `mockOsrm = false`, which gated `deterministic` to off, which left
   `getSeed()` falling back to `Date.now()`. Variants differed across runs,
   so the same fixture produced different routes and the harness was
   effectively non-deterministic — making it impossible to tell whether a
   change moved pass rate or just shifted the RNG. Fix: any harness backend
   that's itself deterministic (mock OSRM, local OSRM via --osrm-base, or
   --synthetic) implies deterministic seeding.
20. **No fixture matched the user's actual start.** The closest fixture
   was `nyc-williamsburg-4mi-loop` at (40.714, -73.961), but the user's
   blue dot was at ~(40.718, -73.961) — the N. Williamsburg / Greenpoint
   border, near McCarren Park, with the Marsha P. Johnson waterfront strip
   pulling waypoints west. Fix: added `nyc-greenpoint-{3,4,5}mi-loop-quiet`
   fixtures with synthetic green spaces matching the actual neighborhood.
21. **Harness OSRM cache state from earlier fixtures contaminated later
   ones.** A single-fixture run produced different output than the same
   fixture in a full sweep. Fix: `clearOSRMCache()` at the start of each
   fixture in deterministic mode.

Additional improvements after the spur fix:

22. **`trimStubs` now scales the threshold with target distance.** Default
   300m is right for 4mi+ routes, but on a 1mi route a 300m "stub" is 20-40%
   of the route — trimStubs gutted geometry, producing a 0.7mi route from
   a 1mi request. Fix in `generateOSRMRoutes`:
   `stubThresholdKm = Math.min(0.30, distanceKm * 0.08)`. So a 1mi route
   caps stub trims at 130m; a 4mi+ route gets the full 300m. `countStubs`
   uses the same threshold so the metric agrees with what was trimmed.
23. **Synthetic green spaces added for Tribeca, UWS, UES, Chelsea, Brooklyn
   Heights, DUMBO.** Without them these fixtures hit the geometric-fallback
   path (`[fb]` tag) — the harness reported PASS but wasn't exercising the
   green-space-first algorithm production users hit. Now they do.
24. **Tried and reverted: spatial-revisit `trimDetours` detector.** Built
   to catch 500m+ peninsula visits with intermediate turns (which trimStubs
   misses because there's no single 150° reversal). The detector flagged
   loop closure itself as a "detour" — for any loop, the start and end are
   spatially close with the entire route between them, and various points
   in the loop pass close to each other naturally. Cut 50%+ off legitimate
   routes. Don't reintroduce without solving the loop-closure false
   positive. Borderline cases (the LES 3mi-relaxed 564m peninsula) remain
   a known gap; the hard-reject covers truly egregious cases (>0.50
   combined retrace+overlap).

Pre-flight checklist for any future "the harness passes but I see X on the
map" report:
- Verify the harness fixture's center matches the user's actual start.
  If they're 0.5km+ apart, OSRM may pick entirely different streets.
- Verify `--synthetic` runs are exercising the green-space-first path,
  not silently falling through to `[fb]` (look for the `[fb]` tag).
- Verify the harness is deterministic (run the same single-fixture command
  3x; output should be byte-identical). `--osrm-base`, `--synthetic`, and
  `--mock-osrm` all imply deterministic seeding now.
- Pull the chosen route's geometry and run a U-turn detector with a
  threshold matching what's visible on the map. The current `countStubs`
  default (300m, scaled to 8% of target) is the floor; visible spurs
  longer than that won't show in `stubs=N` but will inflate `retr=`
  and `over=`.

Current real-OSRM pass rates (deterministic, with --synthetic green spaces
covering 14 of 28 NYC fixtures, all locations):
- 16/28 pass — the user's reported Greenpoint 4mi spur is fixed.
- Remaining 12 failures are dominated by:
  - Distance rounding in dense areas where adjustment loop converges
    to short routes (chelsea, ues, tribeca, williamsburg).
  - Inherent location limits — LES 6mi can't fit a clean loop because
    LES is <1.5km wide N-S between Hudson and East River; LES 1mi is
    too tight a target for the candidate pool to land on.
  - Borderline retrace (10-14%) in water-bounded areas (DUMBO 3mi, UWS
    6mi). Not visibly broken, just over the strict 8% harness threshold.
- Greenpoint fixtures (3, 4, 5mi) all pass cleanly — the user's exact
  scenario is covered.

### May 2026 OTA fixes (post-Build 36)

User-reported bugs surfaced by real-world use after EAS Update wired up.
None of these were caught by the harness — all required visible-on-the-
map screenshots from the user. Each entry: symptom → cause → fix →
harness gap.

25. **Distance slider capped at 30mi/50km but algorithm could still
    reach NJ via Lincoln/Holland Tunnel from a Manhattan start at long
    distances.** User reported a 31mi loop with straight diagonal lines
    crossing the Hudson where OSRM had foot-routed through car tunnels
    (OSM tag ambiguity). Fix: capped slider to 20mi/32km; that alone
    reduces the algorithm's pressure to extend far enough to need a
    tunnel, but the underlying tunnel-routing path is still reachable
    at 20mi from edge-of-Manhattan starts. See entries 26-28 for the
    structural fixes.

26. **Step-3.5 bearing-trial fallback was missing the
    `hasRoutedBarrierCrossing` check that step 3 had.** When every
    step-3 candidate failed the barrier gate (typical for long
    Manhattan loops, where most bearings hit a river), step 3.5 would
    happily ship a westbound trial via Lincoln/Holland Tunnel since
    none of its other gates (pendant, distance, off-street, aspect,
    turns) catch water crossing. Fix: added the same barrier check to
    the step-3.5 gate chain.

27. **`hasRoutedBarrierCrossing` heuristic 1 (straight-line) and 2
    (geographic drift) both missed the user's Hudson tunnel case.**
    Heuristic 1's sample stride (`points/60`) didn't reliably hit a
    sparse 2-point tunnel polyline. Heuristic 2's drift cap was
    `min(target * 0.45, 8)km` — Hoboken sat at ~5km from Chelsea, well
    within 8km. Added Heuristic 3: any single polyline edge >1.2km
    indicates an OSM way with no intermediate nodes (car tunnel or
    ferry). Threshold history: started at 0.5km, regressed all 12
    candidates on a real-OSRM 20mi NYC loop (user-reported "Q=12 B=12"
    error — every candidate had a legitimately long edge from a
    densely-noded greenway or post-trim discontinuity). Raised to
    1.2km — still cleanly catches Lincoln (2.4km) and Holland (2.6km)
    tunnels without rejecting normal routes. Mock harness false-
    positives at 0.5km were trim-discontinuity artifacts, not real
    geometry; harness signal was misleading.

28. **Distance slider initial render: persisted distance from a
    previous build with a higher cap (e.g. 31mi from the old 30mi cap)
    rendered the thumb past the right edge until first interaction.**
    Fix: `displayValue` clamps to `[1, maxValue]` in the slider
    component, with a `useEffect` that propagates the clamp back to
    parent so the persisted value gets rewritten without user action.

29. **Distance slider scaling: user wanted 10mi at the visual midpoint
    between 5 and 20.** Was two-segment piecewise (1-5 first half,
    5-max second half), put 10mi at 67% of slider on the 1-20 scale.
    Fix: three-segment piecewise — [0,50%]→1-5, [50%,75%]→5-mid,
    [75%,100%]→mid-max. Imperial mid is 10, metric mid is 16. Labels
    switched from `justify-content: space-between` to absolute
    positioning so they align with the new breakpoints.

30. **Highway proximity check was structurally blind to long highways.**
    User-reported 19mi Williamsburg "Sidestreet Shuffle" included a
    long stretch alongside I-278 (BQE). Highway dataset stored only
    the centroid of each OSM way (`out center;`) — for a 10km
    highway like the BQE, that's a single point at the geometric
    middle, often km from any specific position on it. Routes
    running directly alongside the BQE saw their nearest "highway
    point" 1km+ away and scored ~0% highway proximity, well below
    the 15% reject threshold. Fix: switched query to `out geom;` and
    sample every ~150m along each way's geometry. Long highways now
    have 30+ representative points instead of 1. With accurate data,
    tightened the hard-reject threshold from 15% → 8% (~2.4km in a
    30km loop). Step-3.5 fallback was missing the highway gate too
    (same architectural pattern as #26) — added it.

31. **No "best candidate is still dirty" gate for long loops —
    ATTEMPTED AND REVERTED.** Initially added a length-conditional
    gate: for distance ≥16km, if the sorted-best candidate had
    dirtiness >0.30, drop the entire pool so the user got "no
    routes". User pushed back immediately: "I should just get the
    right route generated" — gating to "try a shorter distance" is
    the wrong response, the algorithm should actually find a clean
    route at the requested distance. Reverted. The `dirtiness`
    field on `ResolvedCandidate` is kept (cheap to populate, useful
    for diagnostics).
    **Real fix needed (not yet shipped):** candidate generation for
    long loops in geographically constrained areas (Williamsburg,
    LES, Brooklyn Heights, etc.) needs work — the green-space-only
    anchor pool doesn't include bridges, greenways, or pedestrian
    corridors that runners actually use to extend long routes
    cleanly. Possible directions: (a) add bridges/greenways/
    promenades to the anchor pool via a separate Overpass query,
    (b) increase candidate variant count for long loops to find
    luckier configurations, (c) for long loops in narrow areas,
    bias anchors toward known pedestrian corridors instead of
    sectored greens. Don't re-add a "best is dirty → no routes"
    gate without solving the underlying generation problem first.

32. **Anchor pool missing bridges and named footways.** Follow-up to
    #31 after the user pushed back on the gate. The existing
    `greenSpaceSubQuery` already captures named cycleways (catches
    Hudson/East River Greenways), pedestrian streets, foot-designated
    paths, route relations, and waterfront features. But it missed:
    - **Bridges with foot access.** The Williamsburg / Manhattan /
      Brooklyn / Pulaski / Queensboro / GW bridges are anchored on by
      runners doing long Brooklyn or NYC loops — they're how you
      extend a 15mi+ loop without retrace. They're typically tagged
      `[highway=footway, bridge=yes, name="Williamsburg Bridge"]`. The
      named-cycleway line caught the cycleway portion of bridges where
      that exists, but the foot-only spans were missed.
    - **Named footways.** Some long pedestrian paths (Brooklyn Bridge
      Park promenade segments, Roosevelt Island promenade,
      neighborhood greenways) are tagged `[highway=footway, name=...]`
      without `foot=designated` (which is implied by `highway=footway`
      anyway). The previous query required an explicit `foot=designated`
      tag, so unnamed-but-walkable corridors slipped through.
    Fix: added two query lines:
    - `way["highway"="footway"]["name"](${a});`
    - `way["bridge"~"yes|aqueduct|cantilever|movable|suspension|viaduct"]["foot"!="no"]["name"](${a});`
    The parser's existing 50m dedup + cap-at-50 + tier-1-then-area
    sort means parks still rank above linear features (which have
    areaSize=0), so the addition expands the pool without displacing
    park anchors. Bridges become tier-1 anchors via the existing
    `(highway && hasName)` rule. **Did NOT bump candidate variant
    count from 12** — CLAUDE.md is explicit about OSRM rate-limit
    risk from increased call volume; 24 simultaneous candidate
    requests would risk throttling on public OSRM. If the bridge
    additions don't fix long-loop cleanness on their own, next step
    is biased sectoring (prefer corridor anchors for ≥10mi loops),
    not more candidates.

### Recurring-fix discipline

User explicitly called out (May 2026) that the same class of bug ("route
ships visibly broken — backtracking, tangle, water/highway/tunnel
crossing") has been corrected multiple times across builds. The pattern:
1. User reports a visible-on-the-map failure with a screenshot.
2. We diagnose, identify a specific gap (missing check, threshold too
   loose, dataset structurally inaccurate).
3. We patch with a new heuristic, threshold tightening, or fallback
   gate addition.
4. The harness doesn't catch the next instance because the bug class
   manifests against real OSRM/Overpass data the harness can't
   reproduce in mock mode.

To prevent regression-by-rediscovery: every algorithm change MUST add a
numbered entry to this list at the time of the fix, with the symptom,
cause, fix, and harness gap. Threshold changes MUST cite their
before/after values and the reasoning (especially when reverting a
prior tightening). Reverted attempts (e.g. trimDetours #24, retrace+
overlap 0.35 → 0.50 in entry #31's history) stay documented so we don't
re-attempt them blind.
