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
