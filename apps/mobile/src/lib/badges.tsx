import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';
import { useMobileApp } from './mobile-app';
import { useSession } from './session';

/** How often the open app refreshes its unread counts (the same answers are shared by every screen that shows them). */
const POLL_MS = 60_000;

export interface Badges {
  chat: number;
  notifications: number;
  refresh(): void;
}

const Ctx = createContext<Badges>({ chat: 0, notifications: 0, refresh: () => undefined });

export const useBadges = () => useContext(Ctx);

/**
 * Unread chat messages and notifications for the bottom bar, the More menu and the bell. Asked only for modules the
 * person has in the app, once a minute while the app is open and whenever it comes back to the front.
 */
export function BadgesProvider({ children }: { children: ReactNode }) {
  const { api, status } = useSession();
  const { has } = useMobileApp();
  const chatOn = has('chat');
  const notesOn = has('notifications');
  const [chat, setChat] = useState(0);
  const [notifications, setNotifications] = useState(0);

  const refresh = useCallback(() => {
    if (status !== 'ready') return;
    if (chatOn) void api.get<{ unread: number }>('/communication/unread').then((r) => setChat(r.unread)).catch(() => undefined);
    else setChat(0);
    if (notesOn) void api.get<{ unread: number }>('/notifications?limit=1').then((r) => setNotifications(r.unread)).catch(() => undefined);
    else setNotifications(0);
  }, [api, status, chatOn, notesOn]);

  // The app icon shows the unread count (iOS badge, Android launchers that support it), in step with the bell.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    void Notifications.setBadgeCountAsync(status === 'ready' ? notifications : 0).catch(() => undefined);
  }, [notifications, status]);

  // A push arriving while the app is open updates the counts at once, not on the next minute.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = Notifications.addNotificationReceivedListener(() => refresh());
    return () => sub.remove();
  }, [refresh]);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => AppState.currentState === 'active' && refresh(), POLL_MS);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && refresh());
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [refresh]);

  const value = useMemo(() => ({ chat, notifications, refresh }), [chat, notifications, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
