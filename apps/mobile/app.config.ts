import type { ExpoConfig } from 'expo/config';

/**
 * The API address is set per build with EXPO_PUBLIC_CREW_API_URL (for example https://api.example.com).
 * Push needs an Expo project id (EAS_PROJECT_ID); without it the app runs and says push is not set up.
 */
const config: ExpoConfig = {
  name: 'CREW',
  slug: 'crew',
  scheme: 'crew',
  version: '0.7.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: process.env.CREW_IOS_BUNDLE_ID ?? 'com.sampledge.crew',
    supportsTablet: false,
    infoPlist: {
      NSFaceIDUsageDescription: 'CREW uses Face ID to unlock the app.',
      NSLocationWhenInUseUsageDescription: 'CREW checks your location when you punch in or out, if your workplace requires it.',
    },
  },
  android: {
    package: process.env.CREW_ANDROID_PACKAGE ?? 'com.sampledge.crew',
    permissions: ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'USE_BIOMETRIC', 'USE_FINGERPRINT'],
    blockedPermissions: ['ACCESS_BACKGROUND_LOCATION'],
  },
  web: { bundler: 'metro', output: 'single' },
  plugins: [
    'expo-router',
    'expo-secure-store',
    ['expo-local-authentication', { faceIDPermission: 'CREW uses Face ID to unlock the app.' }],
    ['expo-location', { locationWhenInUsePermission: 'CREW checks your location when you punch in or out, if your workplace requires it.' }],
    'expo-notifications',
  ],
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_CREW_API_URL ?? 'http://localhost:4000',
    ...(process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {}),
  },
};

export default config;
