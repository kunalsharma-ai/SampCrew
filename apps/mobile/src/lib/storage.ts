import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { KeyValue } from './outbox';
import type { Tokens, TokenStore } from './api';

/**
 * Secrets (tokens, the installation id) live in the phone's keychain or keystore. The web build is a preview
 * for testing in a browser: there is no keychain, so it falls back to the browser's local storage and says so
 * on the sign-in screen.
 */
export const secureStorageAvailable = Platform.OS !== 'web';

const web = {
  get: async (k: string) => (typeof localStorage === 'undefined' ? null : localStorage.getItem(k)),
  set: async (k: string, v: string) => localStorage.setItem(k, v),
  del: async (k: string) => localStorage.removeItem(k),
};

export const secret = {
  get: (k: string) => (secureStorageAvailable ? SecureStore.getItemAsync(k) : web.get(k)),
  set: (k: string, v: string) => (secureStorageAvailable ? SecureStore.setItemAsync(k, v, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }) : web.set(k, v)),
  del: (k: string) => (secureStorageAvailable ? SecureStore.deleteItemAsync(k) : web.del(k)),
};

const TOKENS = 'crew.tokens';

export const tokenStore: TokenStore = {
  async get() {
    const raw = await secret.get(TOKENS);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Tokens;
    } catch {
      return null;
    }
  },
  set: (t) => secret.set(TOKENS, JSON.stringify({ accessToken: t.accessToken, refreshToken: t.refreshToken })),
  clear: () => secret.del(TOKENS),
};

/** Ordinary app data (the punch queue, preferences). Not secret, but kept across restarts. */
export const kv: KeyValue = {
  get: (k) => AsyncStorage.getItem(k),
  set: (k, v) => AsyncStorage.setItem(k, v),
};
