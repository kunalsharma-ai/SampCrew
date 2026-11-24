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
  if (Platform.OS === 'android') await createChannels();
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

/**
 * Android channels the server picks per notice: "Important" (high and urgent notices, heads-up with sound), "SampCrew"
 * (everything else) and "Silent" (categories the person or the organisation keeps quiet). People can change each one
 * in the phone's own settings, which always win.
 */
export async function createChannels() {
  await Notifications.setNotificationChannelAsync('default', { name: 'SampCrew', importance: Notifications.AndroidImportance.DEFAULT, sound: 'default' });
  await Notifications.setNotificationChannelAsync('important', { name: 'Important', description: 'Urgent and important notices, such as approvals waiting for you', importance: Notifications.AndroidImportance.HIGH, sound: 'default', vibrationPattern: [0, 180, 120, 180] });
  await Notifications.setNotificationChannelAsync('silent', { name: 'Silent', description: 'Notices you or your organisation keep quiet', importance: Notifications.AndroidImportance.LOW, sound: null });
}

/**
 * While the app is open, a push shows as a banner and makes its short sound once, unless the notice was sent silent
 * (sound off for its category, or the organisation keeps notifications silent). The phone's own sound and
 * do-not-disturb settings still apply on top.
 */
export function shouldSoundInApp(data: Record<string, unknown> | undefined): boolean {
  return data?.silent !== true;
}

export function configureForeground() {
  if (Platform.OS === 'web') return;
  const recent = new Set<string>();
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const data = n.request.content.data as Record<string, unknown> | undefined;
      // One sound per notice, even if the same notice reaches the phone twice.
      const id = String(data?.notificationId ?? n.request.identifier);
      const again = recent.has(id);
      recent.add(id);
      if (recent.size > 100) recent.delete(recent.values().next().value!);
      return { shouldPlaySound: !again && shouldSoundInApp(data), shouldSetBadge: true, shouldShowBanner: true, shouldShowList: true };
    },
  });
}
