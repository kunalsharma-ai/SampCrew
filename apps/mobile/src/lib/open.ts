import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import type { Api } from './api';

/** Opens a short-lived download link: a new tab in the browser preview, the in-app browser on a phone. */
export async function openUrl(url: string) {
  if (Platform.OS === 'web') {
    window.open(url, '_blank', 'noopener');
    return;
  }
  await WebBrowser.openBrowserAsync(url);
}

/** Asks the server for a signed link (it checks access and records the download) and opens it. */
export async function openSigned(api: Api, path: string) {
  const link = await api.post<{ url: string }>(path);
  await openUrl(link.url);
}
