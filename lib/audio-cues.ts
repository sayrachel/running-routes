import * as Speech from 'expo-speech';
import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from 'expo-av';
import * as Haptics from 'expo-haptics';
import type { ManeuverStep } from './route-generator';

/** Distances (meters) from the maneuver point at which we fire pre-turn voice
 *  prompts. 250m → "in a quarter-mile, turn right", 100m → "in 100 meters,
 *  turn right", 25m → almost there, 0m → "turn right now". 4 cues bracket
 *  the typical 100–500 m walking-pace approach window without bunching. */
const PROMPT_DISTANCES_M = [250, 100, 25, 0];

/** Per-step set of distance thresholds we've already spoken for, keyed by
 *  the step's stable signature. Prevents the banner from firing the same
 *  prompt twice when the runner pauses near a turn or GPS jitter recrosses
 *  the threshold. Reset by `resetSpokenPrompts` on each route change. */
let spokenPrompts: Map<string, Set<number>> = new Map();
let audioSessionReady = false;

/** Configure the iOS audio session so voice prompts duck (and mix with) the
 *  user's music instead of stopping it. Idempotent — safe to call from a
 *  layout effect; only sets up once per app launch. Failures are swallowed
 *  (audio session config errors are not user-visible and not actionable). */
export async function prepareAudioSession(): Promise<void> {
  if (audioSessionReady) return;
  try {
    await Audio.setAudioModeAsync({
      // Prompts must play with the screen locked / app backgrounded.
      // Requires "audio" in app.json's UIBackgroundModes (added separately).
      staysActiveInBackground: true,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      interruptionModeIOS: InterruptionModeIOS.DuckOthers,
      interruptionModeAndroid: InterruptionModeAndroid.DuckOthers,
      allowsRecordingIOS: false,
    });
    audioSessionReady = true;
  } catch {}
}

/** Reset the spoken-prompt cache. Call when the user starts a new run /
 *  selects a different route — otherwise prompts that fired on the previous
 *  run will stay marked as "already spoken" and the new run will skip them. */
export function resetSpokenPrompts(): void {
  spokenPrompts = new Map();
}

/** Stable per-step key. Uses location coords (rounded) instead of array
 *  index so the cache isn't invalidated by route refresh adding/removing
 *  steps elsewhere on the route. */
function stepKey(step: ManeuverStep): string {
  return `${step.location.lat.toFixed(5)},${step.location.lng.toFixed(5)}`;
}

/** Compose the spoken text for a maneuver. Bare phrasing when the street
 *  name is empty (typical on park paths and pedestrian alleys) — mirrors
 *  Strava Premium's behavior. */
function maneuverText(step: ManeuverStep, distanceM: number): string {
  const action = describeAction(step);
  const distancePhrase = describeDistance(distanceM);
  const onto = step.name ? ` onto ${step.name}` : '';
  if (distanceM <= 0) return `${capitalize(action)}${onto} now.`;
  return `${distancePhrase}, ${action}${onto}.`;
}

function describeAction(step: ManeuverStep): string {
  const m = step.modifier ?? '';
  if (m === 'uturn') return 'make a U-turn';
  if (m === 'sharp left') return 'sharp left';
  if (m === 'sharp right') return 'sharp right';
  if (m === 'slight left') return 'bear left';
  if (m === 'slight right') return 'bear right';
  if (m === 'left') return 'turn left';
  if (m === 'right') return 'turn right';
  if (m === 'straight') return 'continue straight';
  // Fall back to the maneuver type for forks / merges / etc.
  if (step.type === 'fork') return 'take the fork';
  if (step.type === 'merge') return 'merge';
  if (step.type === 'roundabout' || step.type === 'rotary') return 'enter the roundabout';
  if (step.type === 'continue') return 'continue';
  return 'turn';
}

function describeDistance(m: number): string {
  if (m >= 1000) {
    const km = Math.round(m / 100) / 10; // one decimal
    return `In ${km} kilometers`;
  }
  if (m >= 100) {
    const rounded = Math.round(m / 50) * 50;
    return `In ${rounded} meters`;
  }
  return `In ${Math.max(10, Math.round(m / 10) * 10)} meters`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Fire any voice / haptic cues that a new GPS update should trigger.
 *  Idempotent in the spoken-prompt cache — calling this every GPS sample
 *  with the same step + distance won't speak the same threshold twice.
 *
 *  `voiceEnabled` and `hapticEnabled` come from user prefs; the helper
 *  itself is silent when both are false (still walks the threshold list
 *  to keep the cache populated, so toggling on mid-run doesn't replay
 *  every prompt the runner already passed).
 */
export function maybeFireCues(opts: {
  step: ManeuverStep;
  distanceM: number;
  advanced: boolean; // true on the GPS sample where this step became "current"
  voiceEnabled: boolean;
  hapticEnabled: boolean;
}): void {
  const { step, distanceM, advanced, voiceEnabled, hapticEnabled } = opts;
  const key = stepKey(step);
  let spoken = spokenPrompts.get(key);
  if (!spoken) {
    spoken = new Set();
    spokenPrompts.set(key, spoken);
  }

  // Find the deepest threshold we've crossed (e.g., if we're 80m away, we've
  // crossed 250 and 100 but not 25 or 0). Speak whichever crossings haven't
  // been spoken yet, in distance-descending order so the runner hears them
  // in the natural sequence (250 → 100 → 25 → now).
  const toSpeak: number[] = [];
  for (const threshold of PROMPT_DISTANCES_M) {
    if (distanceM <= threshold && !spoken.has(threshold)) {
      toSpeak.push(threshold);
      spoken.add(threshold);
    }
  }

  // Speak from largest to smallest so iteration order matches arrival order.
  // PROMPT_DISTANCES_M is already in that order so toSpeak is too.
  if (voiceEnabled) {
    for (const threshold of toSpeak) {
      try {
        Speech.speak(maneuverText(step, threshold), { language: 'en-US', rate: 1.0 });
      } catch {}
    }
  }

  // Haptic on the "now" crossing or the moment a step was committed —
  // whichever fires first. Distinct from voice so silenced phones still get
  // the buzz at the turn point.
  const shouldHaptic = hapticEnabled && (advanced || toSpeak.includes(0));
  if (shouldHaptic) {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    } catch {}
  }
}

/** Speak an off-course alert. Throttled to one announcement per off-course
 *  transition (caller is responsible for only invoking on the false→true
 *  edge of `isOffRoute`). */
export function speakOffCourse(voiceEnabled: boolean): void {
  if (!voiceEnabled) return;
  try {
    Speech.speak('Off course.', { language: 'en-US', rate: 1.0 });
  } catch {}
}
