import * as LocalAuthentication from 'expo-local-authentication';
import { Platform } from 'react-native';
import { kv } from './storage';

const KEY = 'crew.biometricUnlock';

export interface BiometricSupport {
  available: boolean;
  /** What to call it on this phone: "Face ID", "fingerprint" or "biometrics". */
  label: string;
  reason?: string;
}

export async function biometricSupport(): Promise<BiometricSupport> {
  if (Platform.OS === 'web') return { available: false, label: 'biometrics', reason: 'Not available in the browser preview.' };
  const hardware = await LocalAuthentication.hasHardwareAsync();
  if (!hardware) return { available: false, label: 'biometrics', reason: 'This phone has no fingerprint or face sensor.' };
  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  const label = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION) ? 'face unlock' : types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT) ? 'fingerprint' : 'biometrics';
  if (!(await LocalAuthentication.isEnrolledAsync())) return { available: false, label, reason: `Set up ${label} in your phone's settings first.` };
  return { available: true, label };
}

export async function biometricEnabled() {
  return (await kv.get(KEY)) === 'on';
}

/** Turning it on asks for the biometric once, so it cannot be switched on by someone who cannot pass it. */
export async function setBiometric(on: boolean): Promise<{ ok: boolean; message?: string }> {
  if (on) {
    const r = await unlockWithBiometric('Confirm to turn on biometric unlock');
    if (!r.ok) return r;
  }
  await kv.set(KEY, on ? 'on' : 'off');
  return { ok: true };
}

export async function unlockWithBiometric(promptMessage = 'Unlock SampCrew'): Promise<{ ok: boolean; message?: string }> {
  const r = await LocalAuthentication.authenticateAsync({ promptMessage, cancelLabel: 'Cancel', disableDeviceFallback: false });
  if (r.success) return { ok: true };
  return { ok: false, message: r.error === 'user_cancel' || r.error === 'system_cancel' ? 'Cancelled.' : 'Could not confirm it is you.' };
}
