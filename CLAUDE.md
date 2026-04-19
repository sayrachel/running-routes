# Running Routes - Project Instructions

## App Store / TestFlight Builds

- **ALWAYS bump the iOS build number** in `app.json` (`expo.ios.buildNumber`) before building for TestFlight. Each TestFlight submission requires a unique build number.
- After bumping, commit and push before running the build.
- Build command: `eas build --platform ios --profile production --non-interactive` (uses global `eas` at `/opt/homebrew/bin/eas`)
- Submit command: `eas submit --platform ios --latest` — **must be run by the user in a separate terminal** (requires interactive Apple authentication, cannot run non-interactively)

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
