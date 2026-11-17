# Running Routes - Project Instructions

## App Store / TestFlight Builds

- **ALWAYS bump the iOS build number** in `app.json` (`expo.ios.buildNumber`) before building for TestFlight. Each TestFlight submission requires a unique build number.
- After bumping, commit and push before running the build.
- Build command: `eas build --platform ios --profile production --non-interactive` (uses global `eas` at `/opt/homebrew/bin/eas`)
- Submit command: `eas submit --platform ios --latest` — **must be run by the user in a separate terminal** (requires interactive Apple authentication, cannot run non-interactively)

## Production OSRM Constraints — READ BEFORE TOUCHING `lib/osrm.ts`

Production hits the **free public** `router.project-osrm.org` endpoint. It is rate-limited and tail-latency-prone. Concrete lessons from past regressions:

- **That endpoint only serves the CAR profile — `/foot/` in the URL is ignored** (verified Nov 2026: `/route/v1/foot/…` and `/route/v1/driving/…` return byte-identical routes at ~25 km/h; a real foot profile returns walking speed and different geometry). Every route this app has generated is a car route: it obeys one-way streets, can use highways/tunnels, and can NOT use park paths, greenways, esplanades, car-free park drives, or boardwalks. Many entries below (highway/tunnel/barrier gates, block-loop and zigzag penalties, "no waterfront paths") are workarounds for car-routing artifacts. See "Routing profile" under the Nov 2026 audit section before changing endpoints — a real foot server (e.g. FOSSGIS `routing.openstreetmap.de/routed-foot`) returns mostly UNNAMED sidewalk steps, which the off-street gate (#35) rejects wholesale. **Migration in progress (#62, #63):** the user will NOT self-host a server (personal project); the candidate walking router is Mapbox Directions `mapbox/walking` (free tier, OSRM-shaped responses, token in gitignored `.env.local` as `EXPO_PUBLIC_MAPBOX_TOKEN`), not yet wired into the app. Everything walking-specific is keyed to `isWalkingProfile()` (`'running'` = osrm/running.lua, `'walking'` = Mapbox-style router without running classes); production stays on the car router until then and car geometry is byte-identical. Both free public OSRM servers' usage policies say max 1 request/second — this app bursts ~12 and makes ~30 per generation (walking loops ~36, #63).

- **Total simultaneous request count matters more than per-candidate math.** A change that "only adds 2 parallel calls per candidate" with 7 candidates = 21 simultaneous requests. The endpoint will throttle that burst and return nulls. Keep the steady-state in-flight count ≤ candidate count (currently 7).
- **The harness does NOT validate against the public endpoint.** `--synthetic` uses mock OSRM (zero latency, zero failure rate). Local OSRM (`--osrm-base http://localhost:5000/...`) has no rate limits. **Neither environment can detect a regression that only manifests under public-OSRM rate limiting.** A "quality bumped X/N → Y/N" number from the harness is a claim about algorithm correctness, NOT about endpoint behavior.
- **Tail latency on public OSRM is real.** Typical 200-700ms, busy 1-2s, occasional 3-5s spikes. `OSRM_TIMEOUT_MS` is currently 8s. Don't tighten it without a way to measure the resulting null-rate against real users.
- **NEVER let the algorithm display non-OSRM geometry as a route.** The straight-line-waypoints-as-route bug (Build 21) happened because a fallback branch pushed raw input waypoints when OSRM returned null. If OSRM fails for a candidate: reject it. If all candidates fail: surface "No routes found" rather than draw lines through buildings.

### Pre-flight checklist for any change that touches OSRM call patterns (volume, timeout, hedging, caching) or quality gates

1. Run `npm test` and `npm run quality -- --synthetic`. Baselines: ~423/423 unit tests, ~59/60 synthetic harness (the 1 fail is `nyc-les-1mi-loop-quiet`, pre-existing).
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

33. **Bridges from #32 squeezed out by parks in dense areas + stale
    persisted cache served pre-#32 anchor pools.** User-reported East
    Village 16mi "Backstreet Run" still tangled within lower Manhattan
    after #32 shipped — never crossed any bridge to extend. Two
    issues compounding:
    - **Cache served stale data.** `overpass-persist.ts` keyed at
      `@running_routes_overpass_cache_v1` with a 30-day TTL and no
      version bump on schema changes. Users who'd generated routes
      before #32 had cached anchor pools that never included
      bridges. New anchor data not queried until cache expired,
      blocking the #32 fix from reaching most users immediately.
      Fix: bumped key to `_v2`. Invalidates all existing entries.
    - **Cap-50 sort by area squeezed out bridges in areal-rich
      neighborhoods.** `parseGreenSpaceElements` deduped to 50 anchors
      sorted by `(tier, areaSize)`. In Manhattan with a 5km radius,
      50+ named parks/waterfront features filled the entire budget,
      and bridges (areaSize=0) sorted last. Even after #32 added
      bridges to the *query*, they were truncated out of the *pool*
      passed to `selectGreenSpaceWaypoints`. Fix: split the cap into
      35 areal + 15 linear with mutual leftover so each kind is
      guaranteed slots. The Williamsburg/Manhattan/Brooklyn bridges
      now reliably appear in East Village's pool.
    Did NOT change `selectGreenSpaceWaypoints` sectoring logic — even
    with bridges in the pool, sectoring may still prefer parks (which
    have bigger area scores in the picker too). If after this users
    still see lower-Manhattan tangled long loops, that's the next
    place to look: bias the picker toward bridges/corridors when the
    target distance is long enough that parks-only loops can't fit
    without retrace.

34. **Architectural: anchor-first picking produces convoluted loops in
    dense areal-rich neighborhoods (East Village 16mi case).** User
    diagnosed the core problem after #32/#33 still produced a
    "Backstreet Run" that zigzagged through lower Manhattan covering
    the same 2km square multiple times: the existing
    `selectGreenSpaceWaypoints` is anchor-availability-driven (pick
    highest-scoring nearby anchors, then sector them), so in
    Manhattan with 50+ named parks within 5km, all anchors cluster
    where the parks are, and the loop collapses around them. The
    algorithm never planned a coherent loop SHAPE first — shape was
    whatever fell out of anchor positions.
    **New strategy: macro-snap.** Added as a 4th `CandidateStrategy`
    competing alongside `large-parks`/`named-paths`/`balanced` in the
    12-candidate pool. Loop-only (out-and-back is 1-D, point-to-point
    is start/end-constrained):
    1. Compute macro vertices via compass bearings (same perimeter math
       as step-3.5 fallback) so the planned loop SHAPE matches the
       target distance.
    2. Snap each macro vertex to the nearest scenic anchor within
       0.8km. If no anchor is in range, the geometric vertex is used
       directly — a partial-anchored candidate is still coherent in
       shape, which is the whole point.
    3. OSRM-route between snapped vertices using the existing
       pipeline (trim, score, hard-rejects all unchanged).
    Variant seed produces different starting bearings (×137 mod 360,
    golden-angle-ish) so the 3 macro-snap candidates in a 12-pool
    don't land on near-duplicate rotations.
    **New constraints added in same diff** (user explicitly requested,
    since the scoring pipeline was being touched anyway):
    - **Short-turn-segment ratio** (`shortTurnSegmentRatio` in
      `route-scoring.ts`): fraction of route distance in rapid-fire
      turning (consecutive turns <200m apart). Catches the "zigzag
      through one neighborhood" pattern. Soft penalty: linear from
      0.10 ratio (no penalty), 0.5 weight — a 0.30 ratio costs
      ~0.10 quality points (about a stub's worth). No hard reject —
      dense Manhattan grids legitimately have rapid turns near
      intersections, hard reject would over-fire.
    - **Max single-street share** (`maxStreetShare` in
      `route-scoring.ts`): max fraction of named-street distance on
      any one street, computed from OSRM step data. Catches "5th Ave
      out, 6th Ave back" patterns that pass retrace/overlap (different
      streets) but read as out-and-backs. Hard reject above 0.50,
      soft penalty linear from 0.30 (no penalty), 1.0 weight. Loop-
      only — out-and-back legitimately runs single corridor, point-
      to-point can follow one avenue.
    macro-snap is a SEPARATE candidate strategy (option A from the
    user), not the new primary path. The chooser picks whichever
    strategy's candidate scores best on quality. If macro-snap
    consistently wins on long loops, can be promoted; if it
    consistently loses, can be removed without affecting other
    strategies. Lower-risk validation than rewriting the existing
    strategies.
    **What's NOT in this fix:** sectoring is unchanged in the
    existing strategies; macro-snap is just one of 4. If the picker
    still favors anchor-clustered candidates over macro-snap on long
    loops because of the distance-weighted scoring, the next move is
    to add a length-conditional weight on shape coherence. Don't
    add it preemptively — let the data from the user's next few
    long-loop generations tell us whether macro-snap is competing or
    losing.

35. **Off-street threshold over-fired on long loops, blocking
    East Village 16mi entirely.** User-reported error after #34 with
    diagnostic `Q=9 (b=2 o=6 p=1) W=3` — 6 of 12 candidates rejected
    for off-street ratio >10%. The 10% flat threshold from #34 (and
    earlier) was tuned on PCV/Stuy Town diagonal cases (3mi route
    cutting straight through a private superblock at ~50% off-street).
    For long loops, the math works against us: a 26km route extending
    into Brooklyn or Murray Hill legitimately crosses 1-2km of
    unmapped pass-through (housing-project edges, unmapped bridge
    approaches, college campus crossings) — that's already 4-8% before
    counting the Stuy-Town/PCV pathology the gate was actually meant
    to catch. Combined with the macro-snap strategy aiming bearings
    in arbitrary directions (some of which inevitably point at
    unmappable interior zones), the algorithm rejected most candidates
    and surfaced "no routes found" with auto-retry also failing.
    Fix: scale the threshold linearly with target distance, from
    10% at ≤5km up to 15% at ≥20km (cap), formula
    `min(0.15, 0.10 + max(0, distanceKm - 5) * 0.0033)`. For a 26km
    route, threshold becomes 0.15 — true PCV-diagonal candidates
    (40%+) still rejected, but borderline long-route candidates with
    1-2km of pass-through pass. Applied to both step-3 hard reject
    AND step-3.5 fallback gate.
    **What's NOT being addressed here:** macro-snap might be
    over-firing the off-street gate by aiming bearings into
    known-bad zones (Stuy Town, college campuses). A more targeted
    fix would identify these zones and skip bearings that aim into
    them, but we don't have a list of "bad zones" and building one
    is hand-curation work. Pragmatic order: ship the threshold
    loosening first, see if it unblocks the user, then decide
    whether the macro-snap bearing selection needs zone-awareness.

36. **Macro-snap worked for far vertex but failed locally — Manhattan
    side block-weaved while Brooklyn lobe was clean.** User-reported
    East Village 16mi after #35 unblocked generation: Brooklyn lobe
    (across Williamsburg Bridge → Greenpoint → back) was clean and
    runnable; Manhattan side was tight zigzag through SoHo/West
    Village. The user diagnosed exactly: macro-snap planned the far
    vertex well but the close vertex either snapped to a clustered
    park (causing OSRM to weave between nearby anchors) or fell in
    water (Hudson) with no anchor in snap radius, leaving it
    geometric and OSRM routed to an unreachable point.
    Three fixes to `generateMacroSnapLoop`:
    - **Snap radius scales with waypoint distance**:
      `max(0.5, min(2.0, waypointDist * 0.4))`. Long loops put
      vertices 4-6km out where the nearest viable corridor is often
      1.5-2km away (Hudson River Greenway from a Hudson-floating
      vertex); the previous flat 0.8km radius left those vertices
      anchorless. Short loops keep tight radius so vertices don't
      all snap to the same big park.
    - **Linear-corridor preference**: anchors with kind in
      {cycleway, footway, path, route, waterfront} get a 0.5×
      distance discount in the snap chooser. Catches the
      user-reported case where the Manhattan-side vertex snapped to
      Washington Sq (park, dense weaving back to start) instead of
      the Hudson River Greenway (clean linear extension up the
      river). Park anchors still picked when nothing else is in
      range — discount only flips ties.
    - **Bearing-jitter retry**: if the planned bearing puts the
      vertex in water/no-anchor zone, try ±30° then ±60° before
      falling back to geometric. Small bearing nudge often reaches
      a viable anchor without breaking the macro shape much. Stops
      at the first success so the planned bearing is preserved
      whenever possible.
    What this should fix: the user's Manhattan side should now
    extend along the Hudson River Greenway (linear corridor) instead
    of weaving through SoHo. The Brooklyn lobe pattern (clean
    bridge-out + corridor + bridge-back) is what we want for both
    sides.
    What's NOT in this fix: scoring still doesn't penalize
    waypoint clustering — if the legacy strategies produce a
    candidate where 2 anchors are 1km apart, that candidate can
    still win on quality if its distance match is exact. The
    cluster penalty is the next move if macro-snap still loses.

37. **Bearing-sorted waypoint order forced U-turns at the join.**
    User-reported East Village 16mi after #36: a small spur near
    start where the route went east, dead-ended, and retraced. User
    diagnosed correctly: the issue is upstream — when consecutive
    waypoints require OSRM to reverse direction on the same street,
    OSRM's only response is a U-turn or block-loop. trimStubs misses
    the block-loop variant (two ~90° turns instead of one ~180°
    turn), trimPendantLoops misses the open-loop variant (endpoints
    at different intersections), so the spur survives all post-
    processing. Fix can only be upstream.
    Root cause: `selectGreenSpaceWaypoints` sorted picks by compass
    bearing from center to "form a loop" — but bearing-sorted order
    isn't always U-turn-free. Concrete example: picks at compass
    bearings 0°/90°/270° in bearing order has a 180° turn at the
    third waypoint (the runner arrives going north and must depart
    going south to reach the next waypoint), which OSRM resolves
    via a block-loop. Reordering the same picks to (90°→0°→270°)
    drops max turn severity to 135° — no U-turn anywhere.
    Fix: added `maxTurnSeverity(waypoints)` and
    `reorderForLowestUTurn(center, intermediate)` helpers. Both
    `selectGreenSpaceWaypoints` and `generateMacroSnapLoop` now run
    their picks through reorder before constructing the waypoint
    array. Brute-force across N! permutations (capped at N=5, so
    max 120 perms — negligible cost). The wrap-around at center
    (last → center → first) is intentionally NOT checked: a
    closed-loop's start/end direction inversion is geometric
    closure, not a U-turn the runner experiences.
    Test contract change: two existing tests asserted "waypoints
    bearing-monotonic" — replaced with the actual desired property
    ("max turn severity < 170°"). The previous contract was a
    proxy for the desired property that didn't always hold for
    pathological pick configurations.
    What's NOT in this fix: anchor SELECTION still picks based on
    bearing sectoring + scoring, not turn-severity awareness. So
    if the picker insists on a configuration where NO permutation
    is U-turn-free (rare but possible — 3 picks all at the same
    bearing sector), the reorder can't help. Next step if needed:
    drop picks that, when added, force a U-turn no matter the
    order.

38. **macro-snap got the Brooklyn lobe but Manhattan still
    block-weaved — corridor preference was a tiebreaker, not a
    requirement.** User-reported East Village 16mi after #37: the
    Brooklyn lobe (across Williamsburg Bridge → Greenpoint → back)
    was clean and runnable; the Manhattan side was tight rectangular
    zigzag through SoHo / West Village. User diagnosed exactly:
    "near the start point it reverts to local distance-filling
    because there are no more far anchors to reach." Their proposed
    fix: when adding distance near start, push to a corridor and
    run along it — never grid fill.
    Why macro-snap wasn't catching this: macro-snap's corridor
    preference (#36 — 0.5x distance discount for cycleway/footway/
    path/route/waterfront) is a TIEBREAKER, not a REQUIREMENT.
    When the macro vertex's nearest anchor is a park, the park
    still wins — the discount only flips ties. For East Village,
    the closest anchor to a Manhattan-side macro vertex is often
    Washington Sq Park (a clustered park, dense weaving back to
    start) rather than the Hudson River Greenway (a corridor,
    clean linear extension up the river).
    Fix: added `corridor-loop` as a 5th candidate strategy in
    `STRATEGIES`. Filters the anchor pool to corridors-only first,
    then assigns one to each cardinal direction by angular fit
    (±60° tolerance) AND distance fit (0.4×–1.6× of waypointDist
    band). Tier-1 named corridors get a small score discount.
    Falls back to a geometric vertex when no corridor exists in a
    given direction — handles non-NYC starts with sparse corridor
    coverage.
    Routes generated by corridor-loop naturally have lobes per
    leg: each leg traverses or extends along a corridor, not a
    weaving grid. Brooklyn lobe + Manhattan lobe both use the same
    pattern as the Brooklyn-side success was already demonstrating.
    Compete vs the existing 4 strategies in the chooser; if
    corridor-loop consistently wins on long-loop quality it can be
    promoted to primary.
    Synthetic harness improved from 59/60 → 60/60 — corridor-loop
    helped at least one previously-failing fixture.
    What's NOT in this fix: candidate count stays at 12 (CLAUDE.md
    is explicit about OSRM rate-limit risk from increased call
    volume). With 5 strategies sharing 12 candidates, each gets
    ~2-3 — slightly diluted vs the 4-strategy era. If long-loop
    quality stays inconsistent, next move is conditionally bumping
    the candidate count for long loops or weighing corridor-loop's
    quality bonus higher in the chooser. Don't bump candidate
    count preemptively — let real generations show whether
    dilution is a real problem.

39. **Generation latency: step-3.5 sequential bearing trials, no
    map-pan prewarm, prefetch not persisted.** User-reported "routing
    service slow or unavailable" — the cache-invalidation side effect
    of #33 made cold-start generations slower because every
    neighborhood needed a fresh Overpass + OSRM round trip. Two
    targeted optimizations:
    - **Step-3.5 batched parallelism.** The 8 bearing trials in
      step-3.5 fallback were sequential (CLAUDE.md: a previous "all 8
      in parallel" hedge regressed because it was 21+ in flight when
      combined with concurrent step-3 candidates). Step 3.5 only
      fires AFTER step 3 completes, so its concurrent count IS the
      in-flight count. Batched the 4 first-pass bearings in parallel,
      then the 4 second-pass bearings if the first pass found nothing
      with right-display match. Peak in-flight = 4 (well under the 12
      step-3 tolerates). Cuts step-3.5 wall-clock from 30-60s
      sequential to 8-15s in degraded conditions. Removed the
      per-bearing EARLY_EXIT_RATIO check — early exit now happens
      between passes (skip pass 2 if pass 1 succeeded) which preserves
      the "stop when good enough" behavior at coarser granularity.
    - **Map-pan Overpass prewarm.** Added `onRegionChanged` callback
      to `RouteMap` and a debounced handler in `app/index.tsx` that
      fires `prefetchGreenSpacesAndHighways` for the new region. 800ms
      debounce + 500m distance threshold prevents firing during pan
      animations or for sub-block movements. The bucketed cache key
      (~111m) means same-area pans hit cache anyway. Persists the
      cache 5s after each prefetch so the data survives app close.
    - **Prefetch persistence on `ctx.center` change.** Same 5s
      timeout pattern — used to only persist after a successful
      Generate, so a user who opened the app, prefetched, and closed
      lost the data on next launch.

40. **Pendant spur survived trimStubs and trimPendantLoops on a 7mi
    East Village loop near Corlears Hook.** User-reported visible
    pendant after #39. trimStubs requires a sharp ≥150° apex (misses
    L-shaped detours and gentle U-turns); trimPendantLoops requires
    both bridge endpoints to match within 20m AND a body ≤300m
    (misses pendants where OSRM's coordinate jitter pushes endpoints
    just over). Either trimmer's spec is the right primary detector
    for the case it targets, but the union doesn't cover the whole
    space.
    Fix: `trimRetracedSpurs(points, minRetraceM=50)` as a backstop
    that runs AFTER both existing trimmers in the post-processing
    pipeline (and in the step-3.5 fallback path). Algorithm is
    shape-agnostic — builds canonical edge keys (5-decimal rounding
    ≈1m precision), groups consecutive retraced indices into
    back-leg runs, and for each run ≥50m finds the matching
    forward-leg edges via first-occurrence lookup. Removes
    [fwdStart+1 .. backEnd+1], keeping the entry point.
    Bounded blast radius: refuses to trim >25% of route length in
    one pass — a larger trim signals a degenerate near-OAB shape
    that upstream gates should have caught. Out-and-back routes are
    exempt entirely (their entire return leg is "retraced" by
    design).
    What's NOT in this fix: **block-loop trim** (user-requested for
    Empire State Building area artifact). A block loop traces 3
    sides of a city block without retrace — different streets each
    leg, no edge-key matches. Detecting it shape-wise (3 right-angle
    turns within ~400m total displacement) is doable, but
    REPLACING it with "a simple turn at the corner intersection"
    requires knowing which OSM way to short-cut along, which we
    don't have on-device. Naively stitching points across the
    detour creates a polyline that visually cuts through buildings.
    Deferred until we have a safer remedy (likely: detect block
    loops, reject the candidate, force regeneration with a
    different waypoint offset that doesn't induce the detour).

41. **Start-spur (start point is dead-end branch off the loop) and
    block-loop survived #40 trim.** User-reported 7mi East Village
    "Backstreet Run": the blue dot was on a spur off the main loop
    at 12th & 3rd, not ON the loop — runner had to walk out from
    start, run the loop, walk back the same way. The trimRetracedSpurs
    backstop from #40 detected the retrace correctly but its bounded
    blast radius (25%) refused to trim — for a closed-loop start-spur,
    trimming would remove everything except the start point (the
    "spur" is on both ends of the polyline). User also reported
    block-loop near Washington Square — route circles a single block
    instead of just turning at the corner.
    Both cases are detection-then-penalize, not trim:
    - **`detectStartSpurM(points)`** walks forward from index 0 and
      backward from N-1 simultaneously, accumulating the length of
      matching mirror-image edges. For a 200m start-spur, returns
      ~200. Used as a soft penalty (linear from 50m, 0.002/m, capped
      at 0.40) so 50–250m spurs lose to clean alternatives in the
      chooser. **Hard reject for >250m** because the soft penalty
      alone may not be enough to flip the chooser when the alternative
      is a wrong-distance candidate.
    - **`countBlockLoops(points)`** detects 3-edge sequences with two
      ~90° turns (both 60–120°), each leg 30–300m, and net
      displacement ≤150m — i.e., 3 sides of a city block. Soft
      penalty only (0.15 per loop). Cannot trim because replacing
      the detour with "a diagonal" would visually cut through
      buildings without road-network data.
    What's NOT in this fix: **upstream waypoint placement** to
    prevent start-spurs and block-loops from being generated in the
    first place. Both happen because OSRM has to detour to satisfy
    a waypoint that isn't on a road that passes through start (or
    isn't at a clean intersection). The detection-and-penalize
    approach lets the algorithm SHIP a route in the worst case
    (no clean alternative), at the cost of occasionally still
    visible artifacts. Upstream fix would require road-network
    knowledge (OSM way data on-device) to snap waypoints to known
    intersections — significant data dependency we've avoided so far.
    [Update May 2026: implemented via OSRM /nearest, see #42 — way
    smaller dependency than bundling OSM data.]

42. **Snap geometric waypoints + start coord to nearest road via OSRM
    /nearest.** User asked why we'd been avoiding road-network data.
    Honest answer: bundling OSM data on-device is real complexity
    (hundreds of MB per city, stale data risk), AND polyline-level
    fixes had been "good enough" until #41 hit the wall — start-spurs
    and block-loops are produced by OSRM having to detour from
    waypoints that aren't on roads (or aren't at intersections), and
    no polyline transformation can clean them retroactively. But
    OSRM has a `/nearest` endpoint that returns the snapped road
    point for any input coord — one tiny call per waypoint, same
    OSRM server, same rate-limit pool. Way smaller dependency than
    bundling OSM.
    New helpers in `lib/osrm.ts`:
    - `fetchOSRMNearest(point)` — single-coord call to OSRM
      `/nearest/v1/foot/{lng,lat}?number=1`. Returns snapped coord on
      success, input coord on any failure. Cached by rounded input
      coord (~1m precision) so repeats hit cache. Mock no-op.
    - `snapWaypointsToRoad(points)` — parallel batch via Promise.all.
    Wired in three places:
    1. **`generateOSRMRoutes` top.** Snaps the user's input center
       once per generation (cached for the rest). Result becomes the
       canonical start for all candidates. When the user's GPS is in
       a building or on a non-road, the polyline now starts on the
       actual road — no more closed-loop start-spur from
       input→snap→loop→snap→input. The user walks the small
       (typically <30m, indistinguishable from GPS error) input→snap
       distance separately.
    2. **`generateMacroSnapLoop`.** When no anchor is found within
       snap radius for a macro vertex, the geometric fallback vertex
       is now snapped via /nearest before being pushed. Prevents
       OSRM from detouring to/from a vertex floating in water or
       inside a private superblock.
    3. **`generateCorridorLoop`.** Same — geometric fallback vertices
       (when no corridor exists in a cardinal direction) get snapped.
    Anchored vertices are NOT pre-snapped: they come from Overpass
    way-centroid data which is already road-adjacent, and OSRM's own
    internal snap during routing handles the small final adjustment.
    Pre-snapping them would be redundant.
    Cost: ~1-3 extra /nearest calls per generation in the typical
    case (1 for start + 0-2 for geometric vertices across all 12
    candidates, since most are anchored). With caching, repeated
    coords (same start, same anchor used by multiple candidates)
    cost only one round trip.

### In-run experience fixes (May 2026, post-launch QA)

These cover the in-run tracking/navigation layer, NOT route generation.
First batch of fixes after the user did a real-world test of the
shipping app. Caught issues that the route-quality harness can't
surface because they live in the tracking/UX path, not the algorithm.

43. **Map auto-pan yanked user's manual zoom every GPS tick.** During
    a run, `RouteMap`'s region useEffect called `animateToRegion` on
    every input change. `region` recomputes when `currentPosition`
    changes (every 3s during a run), so any manual pinch-zoom was
    overridden within seconds. Fix: `userControlledUntilRef` bumped by
    `USER_CONTROL_HOLD_MS` (10s) every time `onRegionChangeComplete`
    fires with `details.isGesture === true`. The auto-animate effect
    skips while `Date.now() < userControlledUntilRef.current`. Route
    changes (new `selectedRouteId`) bypass the gate — when the user
    taps Refresh they expect the new bbox even if they were exploring.
    What's NOT in this fix: a "recenter" button to manually jump back
    to follow-mode. Currently the user has to wait 10s after their
    last gesture. Cheap to add later if anyone asks.

44. **GPS polyline rendered as jagged squiggles.** The recorded GPS
    track was visibly jittery on the map: each raw sample landed
    ±3-10m around the true path, and the polyline drew a line through
    every point. Fix: EMA smoothing in `useLocationTracking.ts` with
    `SMOOTH_ALPHA = 0.5` (each new smoothed point = midpoint of raw
    sample and previous smoothed point). Both the displayed polyline
    AND the distance integration use the smoothed series — moving
    average doesn't lose path distance because the jitter it removes
    was inflating distance to begin with (a zigzag line is longer than
    the underlying straight road). Also added a
    `MAX_ACCEPTED_ACCURACY_M = 50` gate — samples worse than 50m of
    accuracy (typical under buildings / urban canyon refraction) are
    dropped entirely; the EMA can't recover from samples that wrong.
    Live map-matching is OUT — public OSRM /match has the same
    rate-limit envelope as /route (CLAUDE.md is explicit about volume
    risk), and per-sample matching would burn the budget. Instead see
    fix #48 for the post-run /match.

45. **Audio kept reading original-route instructions when off route.**
    Once the user crossed the 150m off-route threshold, the in-run
    audio kept announcing turns from the planned route — confusing
    when those turns were now 500m away on streets the user can't
    reach without backtracking. Fix is structural and tiered (see
    entries #45-47 together; they share the new
    `lib/off-route.ts` state machine and the new
    `fetchInRunRoute` OSRM helper). Specifically for #45: after 60s
    continuously off route, the app silently calls OSRM with
    `[currentPos, nextOnRouteTarget(planned route, lookahead 150m)]`
    and uses the resulting `extractManeuvers` step list as a `recalcSteps`
    OVERRIDE for ManeuverBanner. The override stays in effect until
    the user gets back on route (auto-cleared) or the reroute tier
    fires (cleared by the route-change reset useEffect). What's NOT in
    this fix: continuing the planned-route turn-by-turn from "after
    the return point" — once the user is back on route the banner
    resets to step 0 of the planned list, not step N where they left
    off. Picking the right resume index is a future improvement.

46. **Off-route runs never auto-rerouted.** Even after the recalc
    tier (#45) gave back-to-route directions, if the user kept going
    farther off, nothing replanned the rest of the run. Fix: at 90s
    continuously off-route, the app calls
    `fetchInRunRoute([currentPos, destination])` (destination =
    `ctx.center` for loop/OAB, `ctx.endLocation` for p2p) and
    REPLACES `ctx.selectedRoute` with the result. The route-change
    useEffect already in run.tsx (predates this) catches the
    swap and resets turn-by-turn state + off-route state + recalc
    override — the new route is now the plan and "off" is recomputed
    against it. What's deliberately NOT in v1: preserving remaining
    planned anchors. The route is a straight pos→destination path;
    we don't know which of the original anchors are "behind" the
    user vs ahead without spatial analysis of the GPS track against
    each, and an out-of-order anchor would produce its own block-loops
    / pendant artifacts (CLAUDE.md #34, #41). A user who wants to
    continue the full distance can plan a new route post-arrival.

47. **"Off course" audio nagged every time isOffRoute flipped.** The
    previous implementation fired `speakOffCourse` on the false→true
    edge of `isOffRoute`, but GPS jitter near the 150m boundary
    caused multiple true/false flips per minute, each one queuing a
    new "Off course" announcement. Fix is now built into the
    `updateOffRoute` state machine in `lib/off-route.ts`:
    - 30s grace period before the first speech (existing behavior,
      kept)
    - 30s minimum cooldown between subsequent speeches
    - Hard cap at 2 speeches per off-route episode — after the
      second cue the app falls silent and lets the rerouting
      (#45/#46) do the talking
    - Counter resets to 0 when the user returns on-route, so a fresh
      episode plays the full sequence from the beginning
    Pure state machine, exported separately, fully unit-tested in
    `lib/__tests__/off-route.test.ts` (8 update-state cases + 5
    helper-function cases). The chip visibility and the speech edge
    are now both derived from the same state machine — they can't
    desync.

48. **Run never auto-completed at the destination.** Users had to
    manually tap Finish even after arriving at the planned start/end
    point — easy to miss when phone is in a pocket. Fix: geofence
    check in run.tsx on each GPS tick. Destination =
    `ctx.center` for loop / out-and-back, `ctx.endLocation` for p2p.
    Triggers when `haversineDistance(currentPosition, destination) <
    AUTO_FINISH_RADIUS_KM` (40m). For loops/OAB, gated on
    `totalDistanceKm >= 0.7 × plannedKm` so standing at start in
    the first minute doesn't fire (no planned distance → fall back
    to a 500m minimum). On trigger, a 5-second cancel countdown
    toast appears at the top of the screen ("Finishing in 5…" with
    a "Keep Running" button). The toast is dismissable: cancel sets
    `autoFinishCancelledRef.current = true` so the geofence trip
    doesn't immediately re-arm on the next GPS tick (otherwise a
    user loitering at start during cooldown would loop into
    cancel → arm → cancel forever). Re-arm requires the route to
    change (new selectedRoute id). At 0 the countdown calls
    `handleFinish` which is the same path as the manual finish
    button — same StopTracking, same StatsView, same Save flow.

49. **Post-run map-match for saved track quality.** Live GPS, even
    smoothed (#44), still has small wobble where individual samples
    land off-road and the smoothed polyline kinks. Saved runs were
    visibly squiggly on the history detail view. Fix: one OSRM
    `/match` call at save time in `handleSave`, snapping the recorded
    GPS track to the actual road network. Fires AFTER the user taps
    Save (not in the hot generation path) so the steady-state public-
    OSRM load is negligible. Falls back to raw track on: <5 samples
    (too short for /match to disambiguate), >100 samples (OSRM /match
    has a request-size cap), any HTTP / JSON / parse error. Implemented
    in `lib/osrm.ts:fetchOSRMMapMatch` as a public export. Long-run
    chunking (>100 samples) is a known follow-up — currently a 25-min
    run at one sample per 3s = 500 samples = no map-match. Easy to
    add chunked /match later when needed.

50. **Smoothing-only blue track still wandered off-road.** Follow-up to
    #44 after user reported the live blue GPS track was still visibly
    off-road after the EMA filter shipped. Correct diagnosis: EMA
    dampens jitter but doesn't snap — if the underlying GPS sample
    reports a position 30m off the road, the smoothed point ends up
    ~15m off (closer to the previous smoothed point), still not on
    the road. The post-run /match (#49) cleans the saved track but
    doesn't help while the user is looking at the live view.
    Fix: throttled per-sample /nearest snap in `handleLocationUpdate`.
    After pushing a smoothed sample to the polyline, fire
    `fetchOSRMNearest(smoothed)` asynchronously if the sample has
    moved ≥`SNAP_THROTTLE_DISTANCE_KM` (20m) from the last snap
    attempt. When the call resolves, replace the same index in
    `coordinatesRef` with the snapped point and set
    `snapPendingEmitRef` so the timer's next array-rebuild check
    forces a re-emit (without the flag, the length-only equality
    check would skip the rebuild and the snapped point wouldn't
    reach the map until the next GPS sample).
    Cost model: at running pace (~3 m/s) a smoothed sample moves
    ~10m per 3s tick, so the 20m throttle means ~1 snap call per
    7s, or ~8/min. Same OSRM server, same rate-limit pool as /route,
    but unlike route generation (12 candidates × ~1 call burst) the
    snap load is a steady drip — significantly less likely to trip
    public OSRM's burst throttle. `osrmNearestCache` (keyed at ~1m
    precision) absorbs repeat snap requests for the same patch of
    road (user stops at a light → same coord repeatedly).
    Race-condition guards:
    - Reference identity check: the snap callback only writes if
      `coordinatesRef.current[snapIndex] === snapTarget` (the exact
      object pushed). When the background-task sync wholesale-replaces
      `coordinatesRef`, fresh point objects break reference equality
      and the stale snap is dropped rather than corrupting the new
      array.
    - Distance accounting stays on the smoothed series. `lastPointRef`
      is NOT updated to the snapped value when the snap resolves —
      doing so would race with subsequent samples that already
      computed distance using the smoothed baseline. The polyline
      visually snaps, the recorded distance stays computed from the
      smoothed deltas; the discrepancy is sub-meter per snap.
    What's NOT in this fix: snapping in the background task. Async
    network calls from a `TaskManager`-defined task on iOS are
    fragile (the task may be suspended mid-await), and the user is
    by definition not looking at the map when backgrounded. Bg
    samples land in the polyline unsnapped; when the app foregrounds
    again the next round of foreground samples will snap normally.

Harness gaps this batch surfaced (preserved here so the next round of
in-run UX bugs doesn't get the same blind-eye treatment):
- The quality harness exercises ROUTE GENERATION only. It has no
  simulator for "user runs along the route, gets off, comes back" —
  off-route handling can't be QA'd by running the harness. Manual
  testing is currently the only signal for entries #45-#47.
- The harness has no model of UI state — map zoom respect, chip
  visibility, countdown toast behavior all require manual or
  on-device test.
- A future "tracking simulator" that replays a known-good GPS trace
  (real run recording) against the in-run hooks would catch
  regressions in the smoothing, off-route detection, and auto-complete
  paths without requiring a phone. Not built yet.

### In-run polish + setup UX fixes (May 2026 round 2)

51. **Auto-finish countdown toast was actually a confirmation popup.**
    Entry #48 shipped a 5-second cancel countdown ("Finishing in 5…"
    with a "Keep Running" button) the first time the geofence + progress
    gate fired. User feedback: the prompt is friction — when they reach
    the destination they want the run to end silently, not be asked.
    Fix: removed the countdown UI (`autoFinishCountdown` state,
    `autoFinishTimerRef`, `armAutoFinish`/`cancelAutoFinish` callbacks,
    `autoFinishToast`/`autoFinishCancelBtn` styles). The geofence effect
    now calls `handleFinish()` directly on trip, guarded by a single
    `hasAutoFinishedRef` to prevent double-fire across the ~1s window
    before `setRunState('idle')` propagates and gates the effect itself.
    The progress gate (≥70% of planned km, or ≥500m if no plan) is
    unchanged so starting at the destination doesn't fire instantly.
    What's NOT in this fix: a manual "Finish" override during the run
    (already exists via StartButton's finish action) or a per-user
    setting to re-enable the countdown — entry #48's premise (some users
    will want the cancel) didn't survive contact with the real-world
    test. If feedback flips later, the previous behavior can be
    restored cleanly from git history.

52. **GPS polyline still rendered as seismograph after entry #44's EMA
    smoothing and #50's /nearest throttled snap.** EMA dampens jitter
    but doesn't eliminate it (a 30m off-road raw sample produces a
    ~15m off-road smoothed sample); /nearest snap fires every ~7s on
    a 20m throttle and only snaps the point that triggered the call,
    leaving intermediate samples unsnapped. The two filters together
    were not enough to make the live polyline read as a clean path.
    Fix: added `simplifyRDP` (Ramer-Douglas-Peucker) at the RENDER
    layer in `RouteMap.tsx`. Tolerance 4m — below typical GPS jitter
    (5-10m) so wobble below that threshold collapses, while real
    intersection turns (corners well above the tolerance from any
    smoothed chord) survive. Applied to the displayed polyline only;
    distance integration in `useLocationTracking` continues to use the
    un-simplified smoothed series, so total distance is unaffected.
    Helper lives in `lib/gps-simplify.ts` with 6 unit tests covering
    endpoint preservation, jitter-vs-corner discrimination, and short
    array passthrough. Memo key on `gpsTrack` reference is fine — we
    only ever append to the array (entry #50 reference-identity guard
    notwithstanding, the snap callback mutates the same array, then
    a fresh ref gets emitted by the timer's `[...coords]` clone).
    What's NOT in this fix: snapping the entire polyline to roads via
    a chunked OSRM /match on every render — too expensive (per-render
    network round-trip), and the post-run /match (#49) already handles
    the saved-track case. RDP at render time is a CPU-only, predictable-
    cost transform.

53. **Address autocomplete dropdown invisible to users.** User reported
    "no address suggestions appear" when typing an endpoint for a
    point-to-point run. The Photon (Komoot) API itself is fine
    (confirmed via curl) and the wiring in `app/index.tsx` correctly
    debounces and populates `endSuggestions`. Root cause: the
    conditional render gated on `endSuggestions.length > 0`, which
    means during the 200ms debounce + ~500ms fetch window the dropdown
    is empty — and if the fetch silently returns 0 results (no API
    match, rate limit, network blip), the dropdown stays empty
    indefinitely with no indication of WHY. Indistinguishable from
    "autocomplete broken" from the user's perspective.
    Fix: render the suggestions container any time the search input is
    open and the user has typed ≥2 chars. Inside the container, branch
    on three states:
    - `isLoading*Suggestions` (flipped synchronously on the keystroke
      that triggers debounce) → "Searching…" spinner row.
    - `*Suggestions.length > 0` → the existing scrollable list.
    - `*SearchAttempted` (flipped after a debounce-driven fetch
      resolves) → "No matching addresses. Check spelling or try again."
    Loading and attempted flags reset on every code path that clears
    the search input (selectSuggestion, handleLocationCardPress,
    handleEndLocationCardPress, the route-style toggle, blur+resolve,
    handleGenerate's pre-resolve). The dropdown now always has visible
    content while the user is typing, so the "no suggestions appeared"
    case becomes "I see Searching… and then either results or No
    matching addresses, never a void."
    What's NOT in this fix: switching to Google Places / Mapbox. Photon
    is free, unauthenticated, and works for Manhattan addresses today;
    swap is justified only if Photon's NYC coverage starts failing.
    Also NOT in: error surface for actual fetch failure (HTTP 500,
    network timeout). `searchAddresses` swallows errors into an empty
    array, which the new "No matching addresses" branch covers
    sufficiently from the user's perspective. A dedicated "Couldn't
    reach search service" message would require differentiating empty
    results from errors at the fetch layer — defer until we see real
    user reports of network-related failures.

### Generation latency (Jun 2026)

54. **Serial start-snap before Overpass on the cold path.** Every
    `generateOSRMRoutes` call snaps the user's start to the nearest road
    via OSRM `/nearest` (#42), then — only after that resolves — fires the
    Overpass green-space/highway fetch. On a cold generate (cache not yet
    warmed by prefetch) this stacked a full /nearest round trip
    (~0.2–0.7s, more under public-OSRM tail latency) in front of the
    Overpass fetch for no reason: the two hit DIFFERENT endpoints (OSRM
    vs Overpass), and the snap moves the center <30m which is immaterial
    to the km-scale search radius and anchor selection. Fix (two parts):
    - `lib/osrm.ts`: compute `radiusKm` from the input center, then fire
      `fetchOSRMNearest(center)` and `fetchGreenSpacesAndHighways(center,
      radiusKm)` together via `Promise.all`. Apply the snap result
      afterward. This adds ZERO peak OSRM-route concurrency — no candidate
      route calls are in flight during step 1, so the rate-limit envelope
      CLAUDE.md guards is untouched. Pure wall-clock win on the cold path.
    - `app/index.tsx`: call `fetchOSRMNearest(center)` (fire-and-forget,
      never rejects) alongside the existing Overpass prefetch + OSRM
      prewarm, both on GPS-lock (`ctx.center`) and on map-pan settle.
      `fetchOSRMNearest` caches by rounded coord, so the generate-time
      snap becomes a cache hit (≈0ms) on the warm path — removing the
      call from the critical path entirely for the common case where the
      user spends a few seconds adjusting distance before tapping
      Generate.
    What's NOT in this change: candidate count (still 12), launch stagger
    (150ms), OSRM timeout (8s), resolution budget (18s), and the
    distance-adjustment retry count (5) are all untouched — those are the
    big OSRM-volume levers CLAUDE.md gates behind the public-OSRM
    pre-flight checklist (which requires manual generation against the
    real endpoint, not just the harness). Reducing any of them could cut
    wall-clock further but risks the documented rate-limit / quality
    regressions; don't touch them without running the checklist. A
    further safe-ish win not taken here: the macro-snap / corridor-loop
    candidate builders run their geometric-vertex /nearest snaps serially
    inside the candidate-building loop (gated by the sequential
    `usedParkPoints` diversity filter). Batching those snaps would shave
    cold-path time but is more invasive and shifts /nearest timing, so it
    needs the checklist too.
    Verification (Nov 2026, at commit): `npm test` 384/384;
    `npm run quality -- --synthetic` 59/60 (the known
    `nyc-les-1mi-loop-quiet`). `quality:real` only runs from the dev Mac
    with `NODE_USE_ENV_PROXY=1` (Claude Code sandbox proxy) and was
    inconclusive: every Overpass mirror failed, so all 60 fixtures took
    the geometric-fallback path (57/60; fails: les-3mi-quiet stub,
    columbus-15mi/30mi retrace), and `real-osrm-baseline.json` has been
    `{}` since 2026-05-11, so nothing was diffed. The ≥5-route manual
    check (step 3) happens on-device via the OTA update that ships this.

### Location tracking accuracy (Nov 2026)

Root-cause pass on the in-run tracking layer after the user reported "when
I run, the blue arrow is rather inaccurate". These change how Core Location
is configured and how fixes are recorded; they do NOT change any OSRM call
pattern (the live /nearest snap stays distance-throttled at 20m, so its
call rate is unchanged by the denser fix feed).

55. **Core Location was asked for 10m-class accuracy, and background
    updates could auto-pause.** The same root cause surfaced before as
    #44 (jagged polyline), #50 (off-road track) and #52 (seismograph) —
    each patched downstream with smoothing / snapping / simplification
    while the input stayed coarse. Cause: both `watchPositionAsync` and
    `startLocationUpdatesAsync` used `Location.Accuracy.High`, which
    expo-location maps on iOS to `kCLLocationAccuracyNearestTenMeters`
    (`node_modules/expo-location/ios/LocationAccuracy.swift`), not
    Apple's best mode. The background task also left
    `pausesUpdatesAutomatically` unset — its NATIVE default is `true`
    (`EXLocationTaskConsumer.m`, `defaultValue:true`) despite expo's TS
    docs saying `false` — with `activityType` `.other`, so iOS could
    pause updates at a red light while the phone was locked and not
    restart them on its own.
    Fix (`lib/useLocationTracking.ts`): `Accuracy.BestForNavigation`
    (`kCLLocationAccuracyBestForNavigation`, GPS fused with motion
    sensors) for both streams; foreground distance filter 3m → none
    (~1 Hz; the recorder drops sub-3m moves itself); background
    `activityType: Fitness`, `pausesUpdatesAutomatically: false`.
    Cost: battery. If that draws complaints, drop the BACKGROUND task to
    `Accuracy.Highest` (`kCLLocationAccuracyBest`) first — the
    foreground (where the dot is visible) is the part to keep at max.
    What's NOT in this fix: a custom native module / iOS 17
    `CLLocationUpdate.liveUpdates(.fitness)`. expo-location already
    drives `CLLocationManager` directly, so a native module would cost a
    TestFlight build for no accuracy gain; everything here is JS and
    OTA-able. `watchPositionAsync` can't set `activityType` on iOS
    (expo's Swift provider only reads accuracy + distanceInterval); the
    background task's manager carries the fitness hint.
    Harness gap: nothing in the repo exercises Core Location — on-device
    only.

56. **Two location streams with separate smoothing chains; pace assumed
    a 3s cadence.** Found by code read while fixing #57, then confirmed
    by simulating the old ingestion code (2.7 km loop, correlated 4m GPS
    error, phone locked 2:00-8:00): after unlock the recorded position
    sat ~100-210m behind the runner and took ~5-7s to catch up; distance
    came out +14-20% (if RN timers keep running in the background) or
    −20-25% (if they pause) — screen-on runs were fine (within 1%).
    Current pace read 13:24/km or '--:--' at a true 5:33/km.
    Cause: the foreground watch and background task are separate
    `CLLocationManager`s and both receive fixes while foregrounded. Each
    had its own EMA anchor (`lastPointRef` vs `lastBackgroundSmoothed`)
    and its own copy of the track + distance, reconciled by array copies
    on the 1s timer. Background fixes never refreshed the foreground
    anchor, so the first fix after unlock was averaged with the pre-lock
    position (and counted that jump as distance); if the foreground
    handler ran before the timer sync it overwrote the shared copy,
    erasing the background-recorded stretch. Pause stopped only the
    foreground watch, so the background task kept adding distance while
    paused. Current pace was `recentCount × 3s`, but iOS ignores
    `timeInterval` and appends a point every ~1.1-1.3s.
    Fix: one module-level `TrackRecorder` fed by BOTH streams through
    `ingestFix`: timestamp dedupe (a fix delivered to both managers is
    processed once; out-of-order fixes dropped; a ≥5-min backwards jump
    is treated as a clock reset, not a reason to drop everything);
    single EMA anchor + distance accumulator; a >15s gap re-seeds the
    smoothing (the straight-line gap distance still counts, once);
    `pauseRecorder` drops all fixes; `resumeRecorder` starts a fresh
    segment (pause displacement not counted, pace window cleared).
    `computeCurrentPace` uses real fix timestamps over a trailing 30s
    window, '--:--' after 10s without movement.
    Tests: `lib/__tests__/track-recorder.test.ts` (13 cases, incl. the
    lock/unlock regression and cadence-independent pace).
    Side note on #49: its "one sample per 3s" math was also wrong on iOS
    — the 100-point `/match` cap was already hit after ~2 min, so the
    post-run map-match effectively never ran for real runs, before or
    after this change. Chunked `/match` is still the follow-up.
    Harness gap: still no in-run tracking simulator (see the gap note
    after #50); the recorder's pure functions are unit-tested instead.

57. **Live position marker lagged and jumped.** User report (Nov 2026):
    "when I run, the blue arrow is rather inaccurate". Cause: during a
    run `RouteMap` hid MapKit's native dot (`showsUserLocation=
    {!currentPosition}`, since the initial GPS commit 8f3dbca) and drew a
    custom `<Marker>` at the last recorded track point — EMA-smoothed
    (~1 fix behind), sometimes swapped for the `/nearest`-snapped road
    point (#50, which can be the adjacent street), moved only on the 1s
    stats tick across the JS bridge, and after a lock/unlock pulled back
    toward the pre-lock position (#56).
    Fix: `showsUserLocation` always on, custom marker removed. MapKit
    draws the dot natively straight from Core Location, animates between
    fixes, and shows an accuracy halo. `currentPosition` still drives
    camera follow, off-route, turn-by-turn and auto-finish.
    Expected: the recorded blue track (smoothed, snapped, RDP-simplified)
    trails the dot by about one fix — that's the smoothing, not drift.
    What's NOT in this fix: a brand-colored dot (`tintColor` would also
    recolor the setup-screen dot; left system blue).

### Generation speed + routing-profile audit (Nov 2026)

Measured, not estimated. Tooling (all reusable):
- **Local car OSRM = production stand-in.** `~/osrm-data/car/` (built
  from the same NY extract with `car.lua`), serve with
  `osrm-routed --algorithm mld --port 5002 ~/osrm-data/car/new-york-latest.osrm`.
  Matches the public endpoint within ~1% (same street names, car speeds).
- **Local foot OSRM (`~/osrm-data/`, port 5000) no longer works for QA:**
  the Homebrew 26.4.1 foot profile routes ~85% of a Manhattan loop on
  unnamed sidewalks, so the off-street gate (#35) rejects nearly every
  candidate (2/60 fixtures pass). It IS a faithful stand-in for a real
  foot server (FOSSGIS behaves the same) — use it for foot-migration work.
- **Generation-time measurement:** `npm run quality -- --synthetic
  --osrm-base http://localhost:5001/route/v1/foot --no-snapshot --timing
  --only nyc-` with a latency-injecting proxy on :5001 forwarding to :5002
  (400ms ±25%, 5% chance of +2s). `--timing` (harness) prints per-fixture
  wall-clock, /route and /nearest counts, and peak in-flight.
- Production-equivalent quality baseline (car OSRM + synthetic greens):
  44/60 overall, 41/45 NYC (`--only nyc-`).

58. **O(n²) geometry scans dominated on-device CPU.** `overlapSegmentRatio`,
    `trimOnePendantLoop` (up to 2 passes) and `countPendantLoops` compared
    every pair of polyline points with trig-heavy haversines (two per pair
    in the pendant scans). On 360 real car-OSRM polylines (median 530 pts):
    ~188 ms per candidate in Node with JIT, ~510 ms with `node --jitless`
    (interpreter-only, closest proxy for Hermes) — i.e. ~6 s of JS-thread
    CPU per 12-candidate generation on a fast Mac. It also stalled the
    event loop: the harness saw peak in-flight 11 even against a local
    server, because finished responses sat unread while CPU ran.
    Fix: `nearBounds()` — exact degree-space lower bounds
    (d ≥ R·|Δφ|; d ≥ R·cos φmax·|Δλ|·(1−Δλ²/24), with margins) let the scans
    skip the haversine for pairs that provably can't be within tolerance.
    Pairs that pass still get the exact comparison, so every decision is
    identical: 0 mismatches on 360 polylines (trim path exercised on 179),
    route geometry identical on 60/60 synthetic and 60/60 car-OSRM
    fixtures. Speed: 13–18× faster interpreter-only (~30 ms/candidate),
    40–57× with JIT. Regression guard: `near-bounds-equivalence.test.ts`
    pins the three functions to naive reference copies of the old scans.

59. **Candidate building serialized network round trips.** The macro-snap
    and corridor-loop builders `await`ed OSRM /nearest per geometric
    vertex inside the sequential candidate loop, so no candidate's first
    route request could start until every snap had finished (~6 snaps per
    generation in the harness). Fix: split into synchronous
    `planMacroSnapLoop` / `planCorridorLoop` (anchors chosen without
    network, so the usedParkPoints diversity filter is unaffected) +
    `finishPlannedLoop` (snaps, one at a time, then the #37 U-turn
    reorder), deferred into the candidate's own launch pipeline after its
    stagger delay. Each candidate still has ≤1 request in flight, so the
    in-flight ≤ candidate-count envelope is unchanged (peak 12 = candidate
    count, before and after). Geometry identical (60/60 both harnesses).
    Measured with #58, simulated public-OSRM latency, 45 NYC fixtures:
    median 8.4s → 4.9s, p90 13.1s → 8.0s, max 26.0s → 10.2s; same route
    calls (30.2/generation), same pass rate. On a phone the CPU share of
    the old number was larger, so the real-world gain should be bigger.
    Not yet validated on-device against public OSRM (pre-flight step 3).

60. **Tried, not adopted: faster distance convergence.** Secant step on
    (cumulative scale, ratio) after the first correction + shrink cap
    0.80 → 0.65 for too-long routes in `fetchOSRMRouteAdjusted`. Fewer
    candidates exhausted retries (give-ups 59 → 40) and 2 more NYC
    fixtures passed (hudson-greenway-5mi, uws-4mi), but total route calls
    didn't drop (30.2 → 30.0) and the 16 changed routes were mixed
    (distance error 4.5% → 4.1%, but Polsby-Popper 0.33 → 0.27, turns/km
    1.88 → 2.12, green 17% → 14%). Reverted. Baseline facts for the next
    attempt: only 49% of first attempts land within ±15%; first-attempt
    ratio p10/median/p90 = 0.76/1.03/1.71; 15% of chains use all 5
    attempts, so most generations' critical path has one.

61. **Tried, no effect under car routing: scenery-aware ranking.** Step 4
    computes green / run-path / waterfront proximity for every candidate,
    but the final sort has used `qualityPenalty` alone since 4b0ee6f, so
    those scores are only logged. Adding them as a bonus (≤0.12) changed
    0/49 NYC routes: bonuses are tiny (median 0.015) and their spread
    within a candidate pool (median 0.019) is far below the winner's
    typical lead (0.074). Expected — car routes can't enter parks or
    greenways, so coverage is uniformly low (~15%). Reverted; revisit
    after a foot-profile migration, where it should matter.

**Routing profile — the biggest open quality lever.** Production routes
with the car profile (see Production OSRM Constraints). Evidence: East
Village loop, public "foot" = 4,201m / 595s (25 km/h) via 1st Ave, Avenue
C/D service roads; real foot = 3,709m / 2,670s. W 14th → W 34th along the
Hudson: public routes up West Street / 11th / 12th Ave (the West Side
Highway corridor), 3,514m; real foot takes the Hudson River Park
Esplanade, 1,943m. FOSSGIS `routing.openstreetmap.de/routed-foot/route/v1/foot`
serves a real foot profile (also /nearest), reachable from the dev Mac.
Migration blockers to solve first: (1) the off-street gate (#35) — in
foot data sidewalks are unnamed (84% of that loop) while Stuy Town's
interior paths ARE named ("Stuyvesant Walk"), so the unnamed-means-
off-street signal inverts; (2) re-tune ROUTING_OVERHEAD (foot routes are
more direct) and re-check turn/shape gates on sidewalk geometry;
(3) FOSSGIS usage policy (free, limited use) vs the 12-candidate burst
pattern. Use local foot OSRM (port 5000) to prototype and measure.

62. **Walking + bike-path routing (self-hosted running profile).** User
    asked to switch to walking routes and include bike paths. Groundwork
    shipped behind a switch; production is unchanged until a server exists.
    **Why a custom server:** both free public routers cap usage at 1
    request/second (this app: ~30 route + ~7 /nearest calls per generation,
    ~12 in flight). Stock `foot.lua` (OSRM 26.4) is also a poor running
    profile: it blocks any carriageway tagged `sidewalk=separate`, so NYC
    routes are 84–91% unnamed sidewalk ways (no street names, jogs at every
    crosswalk, retrace hidden across opposite sidewalks), and it drops
    `highway=cycleway` without `foot=*` — 17% of NY State cycleways,
    including Hudson River / East River Greenway segments. FOSSGIS's foot
    profile includes cycleways but prefers sidewalks (same unnamed problem).
    **`osrm/running.lua`** (build: `osrm/build.sh`, deploy: `osrm/Dockerfile`,
    notes: `osrm/README.md`): bike paths runnable unless `foot=no`; street
    centerlines kept routable and sidewalks/crossings weighted 0.8 so routes
    follow named streets; runner weights (greenway 1.2 — shared-use paths,
    `foot`-designated cycleways, and car-free park drives, which in OSM are
    `highway=pedestrian` + `bicycle=designated`; unnamed footways 0.9 so
    housing-complex cut-throughs must save >10%; primary 0.85, alleys/parking
    aisles 0.75, steps 0.6, tunnels/indoor 0.5); quadratic turn cost (4s per
    90°) so grid staircases resolve to fewest turns; only real way types
    (stock helpers made a `foot=yes` ferry a 1.5km "walk" across the Hudson
    to Weehawken — fixed); no ferries; classes greenway / path / sidewalk /
    steps / busy / service on every intersection. Untagged cycleways are
    runnable but neutral: some are protected on-street lanes (Broadway, Pike
    St, Tillary St) that shouldn't pull routes onto their avenue.
    **App changes, all keyed to the profile (car geometry identical 45/45):**
    `RoutingProfile` + `RUNNING_SERVER` coverage box chosen per generation
    (`null` → public car router everywhere, as before); ROUTING_OVERHEAD
    1.25 for running (first-attempt ratio median 1.01; 1.45 would undershoot
    ~13%); `continue_straight=true` on /route (walking profiles allow U-turns
    AT via waypoints, so every off-path waypoint became an out-and-back spur:
    30 → 36/45); class-aware off-street gate — unnamed sidewalk / greenway /
    busy pieces are public and no longer count, other unnamed pieces are
    split at intersections; park containment uses Overpass bounding boxes
    (new `GreenSpace.bounds`) because a centroid circle covers ~⅓ of Hudson
    River Park or Brooklyn Bridge Park; `maxStreetShare` divides by all
    distance, not named distance (one named greenway read as 60% of a DUMBO
    loop that was ⅓ greenway); /nearest cache keyed by endpoint;
    `pathShare` (greenway + path share) on GeneratedRoute.
    **Measured** (local servers, 45 NYC fixtures, synthetic greens; synthetic
    fixtures now carry bounds for 8 big NYC parks): just pointing the
    unchanged algorithm at the profile 16/45 → profile fixes + class gate +
    overhead 30 → continue_straight 36 → ferry fix 37–38 → park bounds 39/45
    (car baseline 41/45). By group: loops ≤7mi car 32/34, running 33/34
    (fixes greenpoint-4mi, uws-4mi; breaks dumbo-3mi); out-and-back car 5/6,
    running 6/6; loops >7mi car 4/5, running 0/5. Running routes put a
    median 16% (mean 25%) of distance on greenways/paths (car: 0 by
    construction), distance error 3.1% vs 4.0%, but turns/km 2.05 vs 1.40.
    Tried and reverted: neutral weight for unnamed footways (37/45, no
    path-share gain).
    **Harness:** `--profile running` (with `--osrm-base` pointing at a
    running server), `os=` off-street rejections, `path=` column; off-street
    rejections in `--dump` traces list the offending pieces. The
    `greenProximity` metric counts points within 200m of park CENTROIDS, so
    it can't see a route crossing a big park — use `path=` for foot routes.
    **Status (Nov 17):** (1) superseded — user won't self-host; Mapbox walking is the candidate (#63); (2) and (3) fixed by #63. Original list:
    **Open before production:** (1) a hosted server (user decision; NY State
    extract needs ~3 GB RAM, HTTPS in front); (2) long loops near water —
    Columbus 8–30mi pick out-and-backs over one bridge (Queensboro) or one
    park drive; car routing hid this because a car crosses on separate
    one-way roadways; (3) dumbo-3mi: geometric waypoints land across the
    river, the Brooklyn/Manhattan Bridge loop is 8–12km, and distance
    scaling then drags waypoints into the water (routes collapse to <2km);
    (4) named interior walks (Stuy Town's "Stuyvesant Walk", "14th Street
    Loop") pass the name-based part of the off-street gate; (5) the #54
    /nearest warm-up still warms the car endpoint; (6) pre-flight steps 2–4
    against the deployed server, incl. ≥5 on-device generations.

63. **Walking-router loop fixes: start on the loop, detour repair, Mapbox
    gates.** User declined to self-host (#62 open item 1); Mapbox Directions
    `mapbox/walking` is the candidate hosted walking router (10k req/month free
    without a card, 300 req/min even on trial, OSRM-shaped responses, sidewalks
    named after their street, park paths unnamed, no /nearest). Spot check with
    the unchanged generator (5 NYC fixtures via `/tmp/rr-tools/mapbox-proxy.mjs`,
    which maps OSRM URLs to Mapbox): 2/5 vs car 4/5 — out-and-back detours
    (retrace 9–17%) and 6/12 Columbus candidates rejected off-street for Central
    Park paths. Mapbox terms bar bulk/automated queries: never run the full
    harness against it, only ~10-fixture spot checks.
    **Root cause:** every loop generator put waypoints AROUND the start — two
    at bearings θ and θ+165–210°, three or more over 330–360°. One-way streets
    kept car legs on different avenues; on foot the router uses the same street
    both ways, so the leg between opposite waypoints ran back past the start:
    out-and-backs, figure-8s through the start, in-and-out park visits (428 of
    468 loop candidates had a ≥150° turn at some waypoint). Same cause as #62's
    Columbus 8–30mi and DUMBO failures.
    **Fixes (all behind `isWalkingProfile()`; car geometry identical 45/45):**
    - `RoutingProfile` gains `'walking'` (walking router without running
      classes); `isWalkingProfile()` covers running + walking for
      continue_straight, total-distance street share and overhead 1.25.
    - Loop shape: `planWalkingLoop` / `walkingLoopVertex` put the start ON a
      circle — regular (n+1)-gon, n = 2 under 2.5mi, 3 under 14mi, 4 under
      22mi, else 5, sized so perimeter × ROUTING_OVERHEAD = target. Walking
      versions of macro-snap (anchor within 0.4 side, slide ±30° along the
      circle), corridor-loop (nearest corridor within 0.6 side of each vertex),
      the anchor-first strategies (`selectWalkingGreenSpaceWaypoints`: anchors
      in a 0.5–1.5r band, one per arc, ≥30° of arc clear of the start, −10 per
      unit radial miss) and both geometric fallbacks. Distance scaling about
      the start keeps the shape. `expandParkWaypoints(..., matchByPoint)`
      pairs parks to waypoints by position (mixed anchored/geometric loops
      list only anchored vertices in `anchors`; index pairing expanded the
      wrong waypoint — the car path keeps index pairing).
    - Detour repair in `fetchOSRMRouteAdjusted` (walking loops):
      `findWaypointDetours` walks back from each via waypoint along the
      incoming leg while the outgoing leg's early part (≤ 2× walked-back +
      400m) passes within 25m, tolerating ≤400m gaps (lollipops); ≥80m doubled
      counts. `applyDetourRepairs` moves the waypoint to the divergence point
      (drops it when the whole leg doubles and ≥2 waypoints remain); the next
      attempt scales for the distance minus the detours; a route with a detour
      isn't accepted while attempts remain; best-so-far error adds the detour
      share. A final `trimStubs` pass after the pendant / retraced-spur trims
      removes few-meter reversals those cuts leave (a 2m-in/2m-out Mapbox
      U-turn at a waypoint failed the 0-stub requirement).
    - Gates: off-street gate uses park bounding boxes for unnamed steps on
      walking profiles (Mapbox park paths); the straight-segment "tunnel"
      heuristic is skipped on foot (car tunnels are motorways); ferries
      rejected via step mode/class (`routeUsesFerry`, p2p included);
      geographic drift cap 0.45×target with no 8km cap (start-on-perimeter
      loops reach ~0.28×target; the cap rejected every 20mi+ candidate).
    **Measured (45 NYC fixtures, synthetic greens):** running profile 39 → 45;
    shortest-path stand-in for Mapbox (running.lua with flat preferences,
    turn penalty 2: `~/osrm-data/walkplain`, port 5005) 36 → 45 (old vs new
    generator). Loops: retrace mean 3.0% → 0.8%, overlap 2.6% → 0.3%,
    Polsby-Popper 0.32 → 0.58; distance error median 3.1% → 1.6%; turns/km
    ~2.1 either way; long loops (>7mi) 0/5 → 5/5. Mapbox spot check (new code):
    10/10 (Columbus 5mi now a clean loop instead of in-and-out of Central Park;
    DUMBO along Brooklyn Bridge Park instead of into the Navy Yard). Cost:
    route calls per generation 28.4 → 36.0 (detour repair forces more
    attempts; 27% of candidates use all 5). Ablation with the final stub trim:
    repair off 44/45 + 43/45 at 29 calls; ≥150m only 44/45 + 45/45 at 33;
    ≥80m (chosen) 45/45 + 45/45 at 36.
    **Open:** wire Mapbox in (URL builder + token, no /nearest — skip snapping
    or use returned waypoint locations, `alternatives=true` boolean only,
    on-device check); Mapbox terms changes (no persisted route cache
    (osrm-persist), favorites store waypoints and re-route on open, GPX export
    off for Mapbox routes, Mapbox logo + © Mapbox © OpenStreetMap under the
    map); route names still credit an anchor a detour repair moved away from;
    Mapbox walking ignores greenways (`walkway_bias=1` changed nothing on
    W 14th→W 34th), so path share relies on anchors.

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
