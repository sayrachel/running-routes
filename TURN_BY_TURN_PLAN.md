# Turn-by-turn navigation — implementation plan

Goal: bring the in-run experience close to Strava Premium parity. Phases 1–3
ship together; Phase 4 deferred. Watch parity is explicitly out of scope.

## Reference: what we're matching

Strava Premium during a route-following activity:
- Persistent banner at the top with the next maneuver ("In 0.2 mi, turn right
  onto Main St" — bare "turn right" when street is unnamed).
- Voice prompts via headphones at distance thresholds before each turn.
- Haptic buzz at the actual turn point.
- Off-course detection with audio cue.
- Visual arrow / callout on the map at the next maneuver.

Free Strava skips voice/haptic/arrow and just shows polyline + off-course
chip. That's roughly where we are today.

## Phase 1 — Maneuver banner + step state

User-visible: top banner showing distance to next turn + maneuver type +
street name (if known). Updates in real time.

**Code:**
- `lib/route-generator.ts` — extend `GeneratedRoute` with `steps?: ManeuverStep[]`.
- `lib/osrm.ts`
  - Extend `OSRMStep` with `maneuver: { type, modifier?, location, bearing_after }`.
  - In the route assembly (~line 3355), map OSRM legs/steps onto a flat
    `ManeuverStep[]` and attach to the GeneratedRoute. Drop the `arrive`
    step and any zero-distance "depart" so the banner doesn't lead with
    a no-op.
- `lib/firestore.ts` — strip `steps` before persisting (regenerable, large).
- `lib/turn-by-turn.ts` (new) — pure logic:
  - `findCurrentStep(position, steps, lastStepIdx, lastConfirmCount)` →
    next step index + meters to its maneuver point.
  - **False-alert mitigation** (user-mandated): require N=3 consecutive
    GPS samples agreeing on the same "next step" before changing the
    committed step index. A single 30m GPS jump won't fire a turn.
- `lib/__tests__/turn-by-turn.test.ts` (new) — at least:
  - Single noisy outlier doesn't change the committed step.
  - Real progression through 5 steps fires each step in order.
  - Distance-to-maneuver is monotonically decreasing as you approach.
- `components/ManeuverBanner.tsx` (new) — top banner. Renders icon
  (left/right/sharp-left/etc.) + distance + name (or bare "Turn right"
  if name is empty).
- `app/run.tsx` — wire banner above the existing header chip when
  `hasStarted && ctx.selectedRoute?.steps`.

**Ships via:** EAS Update (no native).

## Phase 2 — Voice + haptic

User-visible: voice prompts ("In 200 meters, turn right") and a haptic
buzz at each turn. Settings toggles for both (default ON).

**Code:**
- Install `expo-speech` (`expo-haptics` already installed).
- `lib/audio-cues.ts` (new):
  - `prepareAudioSession()` — set `expo-av` audio category to
    `PlaybackCategoryAmbient` with `interruptionModeMixWithOthers` so
    voice ducks/mixes with the user's music instead of stopping it.
  - `speakManeuver(step, distanceM)` — formats: "In 200 meters, turn
    right onto Main Street" / "In 100 meters, turn right" /
    "Turn right now."
  - Tracks fired-prompt set per step ID to prevent duplicates.
- `lib/AppContext.tsx` — extend `RunPreferences` with
  `voicePrompts: boolean`, `hapticPrompts: boolean`. Persist to
  AsyncStorage like other prefs.
- Settings UI in `ProfileDrawer` — two toggles.
- `app/run.tsx` — when current-step changes, fire haptic (if enabled);
  on each distance threshold (250m, 100m, 25m, 0m), fire voice (if
  enabled).
- `app.json` — add `"audio"` to `ios.infoPlist.UIBackgroundModes` (was
  `["location"]`, becomes `["location", "audio"]`). Required so voice
  prompts play with screen locked / app backgrounded.

**Ships via:** TestFlight build (UIBackgroundModes is a native config
change). Bumps `expo.ios.buildNumber` from 40 → 41.

## Phase 3 — Map arrow + audible off-course cue

User-visible: directional arrow marker on the map at the next maneuver
point; one audio cue ("off course") on first transition into off-route.

**Code:**
- `components/RouteMap.tsx` — accept `nextManeuver?: { lat, lng, type, modifier }`
  prop. Render a `Marker` with a directional icon (Ionicons
  arrow-forward / arrow-back / etc., rotated to match the modifier).
- `app/run.tsx` — pass current next-maneuver from the turn-by-turn
  state into the RouteMap. On `isOffRoute` transitioning false → true,
  fire `Speech.speak("Off course")` (if voice enabled).
- `RunStats` — add a small "Next turn in X" line above the existing
  stats when running and a step is active.

**Ships via:** EAS Update on top of the Phase 2 TestFlight build.

## Risks + mitigations

1. **False turn alerts from GPS noise.** Mitigation: 3-consecutive-sample
   confirmation before committing to a step change. Also: ignore any
   sample with `accuracy > 25m`. Also: never go backward in the step
   index — once committed, only advance.
2. **OSRM steps with no street name.** Mitigation: render bare
   "Turn right" (Strava does the same). The icon plus bearing is
   typically enough on the ground.
3. **Background audio session interfering with music.** Mitigation:
   `interruptionModeMixWithOthers` + `shouldDuckAndroid: true`.
4. **Battery.** Mitigation: turn-by-turn calc throttled to once per
   GPS sample (not per-frame). expo-speech / expo-haptics are
   negligible. Background audio adds ~3–5%/hr; acceptable.
5. **TestFlight cycle blocks shipping Phases 1+3.** Mitigation: ship
   1+2+3 together as one TestFlight bump. Phase 1+3 are useless without
   Phase 2's voice anyway (visual-only is just free Strava).

## Build implications

- Phases 1 + 3 alone could OTA, but Phase 2's UIBackgroundModes change
  forces a TestFlight build. Bundle all three. Bump iOS buildNumber
  40 → 41.
- No new permissions (audio is already implicitly available; we just
  need the background-mode entitlement).

## Out of scope (Phase 4 / later)

- Re-routing on prolonged off-course (Strava itself doesn't handle this
  well; defer until users ask).
- Apple Watch turn-by-turn (separate native module project).
- Voice language localization (English-only v1).
- "Approaching final turn" / mileage marker callouts.
