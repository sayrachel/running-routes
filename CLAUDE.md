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
