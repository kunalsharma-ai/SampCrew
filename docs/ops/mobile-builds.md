# Building the SampCrew phone app (Android and iOS)

The phone app (`apps/mobile`, Expo SDK 57) is built on Expo's build servers (EAS Build) and sent to the stores
with EAS Submit. Nothing native is kept in the repository: EAS makes the `android/` and `ios/` folders from
`app.config.ts` on every build, so they are git-ignored.

## What is ready in the repository

| Piece | Where | State |
|---|---|---|
| App identity, icons, splash, permissions | `apps/mobile/app.config.ts` | Ready. Bundle id and package `com.sampledge.crew` (change with `CREW_IOS_BUNDLE_ID` / `CREW_ANDROID_PACKAGE`). |
| Build profiles | `apps/mobile/eas.json` | `preview`: installable test build (Android APK, iOS ad hoc). `production`: Play Store app bundle and App Store build, version numbers raised by EAS. |
| One-click build | GitHub Actions, **Mobile build** (`.github/workflows/mobile-build.yml`) | Runs type checks and tests, then starts the EAS build. Needs the `EXPO_TOKEN` secret. |
| Checks done here | Android and iOS JavaScript bundles compile (Hermes); `expo prebuild` makes both native projects with the right permissions. | Verified 2026-11-19. |

Permissions the store listing must explain:

- **Android:** fine and coarse location (punching in at a geofenced site), biometrics (unlock), internet, vibrate,
  and storage up to Android 12 (choosing a document). Background location, the microphone and "draw over other apps"
  are removed on purpose.
- **iOS:** Face ID, location while the app is open, camera and photo library (profile photo). No "always" location
  and no motion data are asked for.

## What only the account owner can provide

These cannot be created from a build server and never go into the repository.

1. **Expo account and project**
   - An Expo account (free tier is enough to start; paid plans build faster).
   - Run `npx eas-cli@27.7.2 init` once in `apps/mobile` to create the project; it prints the **project id**.
   - Put that id in the build environment as `EAS_PROJECT_ID` (push notifications need it).
   - Create an **access token** (expo.dev > Account settings > Access tokens). Add it to GitHub as the repository
     secret `EXPO_TOKEN`.
2. **API address for each build**
   - `eas env:create --environment production --name EXPO_PUBLIC_CREW_API_URL --value https://<your API host>`.
   - Do the same for `preview`. A build without it stops on purpose instead of pointing at localhost.
3. **Android (Google Play)**
   - A Google Play Console developer account (one-time USD 25 fee) and the app created there with package
     `com.sampledge.crew`.
   - Signing: let EAS create and keep the upload keystore on the first build (recommended), or upload an existing
     one. Back it up from expo.dev; losing it means a new app listing.
   - For automatic upload: a Google Cloud **service account JSON key** with the Play Console "Release manager"
     permission, uploaded to the Expo project (`eas credentials`, Android, Google service account).
   - Firebase project with an Android app for push (FCM): upload its **FCM V1 service account key** to the Expo
     project so notifications reach Android phones.
4. **iOS (App Store)**
   - An Apple Developer Program membership (USD 99 a year) for the organisation, with its **Team ID**.
   - The app record in App Store Connect with bundle id `com.sampledge.crew`; its numeric **App Store Connect app id**.
   - An **App Store Connect API key** (Issuer ID, Key ID and the `.p8` file) with the App Manager role. EAS uses it
     to make the distribution certificate, provisioning profile and push key, and to upload to TestFlight.
   - For `preview` builds on iPhones: register each test iPhone with `eas device:create`.
5. **Store listings**: privacy policy URL, support URL, screenshots (the e2e screenshot hook makes phone-sized
   screens), data safety form (Google) and privacy nutrition label (Apple), and a reviewer login for the demo
   workspace.

## Building

From GitHub: Actions > **Mobile build** > Run workflow. Choose the platform, `preview` or `production`, and whether
to send a production build to Google Play internal testing and TestFlight.

From a computer:

```bash
cd apps/mobile
npx eas-cli@27.7.2 build --platform all --profile preview      # test builds; EAS prints install links and QR codes
npx eas-cli@27.7.2 build --platform all --profile production   # store builds
npx eas-cli@27.7.2 submit --platform all --profile production  # upload the latest store builds
```

## Checking a change before building

```bash
pnpm --filter @crew/mobile typecheck && pnpm --filter @crew/mobile test
cd apps/mobile && EXPO_PUBLIC_CREW_API_URL=https://api.example.com npx expo export --platform android --platform ios --output-dir /tmp/native-check
```

The export compiles the same JavaScript the phones run. `npx expo prebuild --no-install` shows the native projects
and their permissions; delete `android/` and `ios/` afterwards and undo the `package.json` script change it makes.
