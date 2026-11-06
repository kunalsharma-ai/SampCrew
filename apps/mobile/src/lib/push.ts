import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * Push uses Expo's push service. It needs a real phone and an Expo project id in the build
 * (EAS_PROJECT_ID). The server only sends when push is turned on there too. Messages are generic
 * ("You have something new in SampCrew") and the app fetches the details after sign-in.
 */
export type PushTokenResult = { ok: true; token: string } | { ok: false; message: string };

export function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

export async function getPushToken(): Promise<PushTokenResult> {
  if (Platform.OS === 'web') return { ok: false, message: 'Push is not available in the browser preview.' };
  if (!Device.isDevice) return { ok: false, message: 'Push needs a real phone, not a simulator.' };
  const id = projectId();
  if (!id) return { ok: false, message: 'Push is not set up for this build (no Expo project id).' };
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'SampCrew', importance: Notifications.AndroidImportance.DEFAULT });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return { ok: false, message: 'Notifications are turned off for SampCrew in your phone settings.' };
  try {
    const t = await Notifications.getExpoPushTokenAsync({ projectId: id });
    return { ok: true, token: t.data };
  } catch {
    return { ok: false, message: 'Could not get a push token. Check your connection and try again.' };
  }
}

export function configureForeground() {
  if (Platform.OS === 'web') return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldPlaySound: false, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
  });
}
