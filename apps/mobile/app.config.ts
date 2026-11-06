import type { ExpoConfig } from 'expo/config';

/**
 * The API address is set per build with EXPO_PUBLIC_CREW_API_URL (for example https://api.example.com).
 * Push needs an Expo project id (EAS_PROJECT_ID); without it the app runs and says push is not set up.
 */
const config: ExpoConfig = {
  name: 'SampCrew',
  slug: 'crew',
  scheme: 'crew',
  version: '0.7.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  // SampCrew mark: icon.png (1024 x 1024, white behind the mark for iOS) and a transparent copy for Android's adaptive icon.
  icon: './assets/icon.png',
  ios: {
    bundleIdentifier: process.env.CREW_IOS_BUNDLE_ID ?? 'com.sampledge.crew',
    supportsTablet: false,
    infoPlist: {
      NSFaceIDUsageDescription: 'SampCrew uses Face ID to unlock the app.',
      NSLocationWhenInUseUsageDescription: 'SampCrew checks your location when you punch in or out, if your workplace requires it.',
    },
  },
  android: {
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#FFFFFF' },
    package: process.env.CREW_ANDROID_PACKAGE ?? 'com.sampledge.crew',
    permissions: ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'USE_BIOMETRIC', 'USE_FINGERPRINT'],
    blockedPermissions: ['ACCESS_BACKGROUND_LOCATION'],
  },
  web: { bundler: 'metro', output: 'single', favicon: './assets/favicon.png', name: 'SampCrew', shortName: 'SampCrew', description: 'People, simplified.' },
  plugins: [
    'expo-router',
    ['expo-splash-screen', { image: './assets/splash-icon.png', imageWidth: 180, resizeMode: 'contain', backgroundColor: '#FFFFFF', dark: { image: './assets/splash-icon.png', backgroundColor: '#0B1020' } }],
    'expo-secure-store',
    ['expo-local-authentication', { faceIDPermission: 'SampCrew uses Face ID to unlock the app.' }],
    ['expo-location', { locationWhenInUsePermission: 'SampCrew checks your location when you punch in or out, if your workplace requires it.' }],
    'expo-notifications',
    ['expo-image-picker', { photosPermission: 'SampCrew lets you choose a profile photo from your photos.', cameraPermission: 'SampCrew lets you take a profile photo with your camera.', microphonePermission: false }],
  ],
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_CREW_API_URL ?? 'http://localhost:4000',
    ...(process.env.EAS_PROJECT_ID ? { eas: { projectId: process.env.EAS_PROJECT_ID } } : {}),
  },
};

export default config;
