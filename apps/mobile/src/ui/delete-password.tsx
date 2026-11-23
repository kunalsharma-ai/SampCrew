import { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, Text as RNText, TextInput, View } from 'react-native';
import { deletePrompt } from '../lib/api';
import { useAppearanceTheme } from '../lib/appearance';
import { alpha } from '../lib/theme';

/**
 * The password sheet for deletes (contracts delete-permissions.ts). Mounted once in the root layout; the API client
 * opens it whenever the server answers a delete with delete_password_required, then confirms the password and sends
 * the delete again. Cancelling deletes nothing.
 */
export function DeletePasswordHost() {
  const t = useAppearanceTheme();
  const [ask, setAsk] = useState<{ what: string; error?: string } | null>(null);
  const [password, setPassword] = useState('');
  const resolver = useRef<((v: string | null) => void) | null>(null);

  useEffect(() => {
    deletePrompt.ask = (what, error) => new Promise<string | null>((resolve) => {
      resolver.current = resolve;
      setPassword('');
      setAsk({ what, error });
    });
    return () => { deletePrompt.ask = null; };
  }, []);

  const finish = (v: string | null) => {
    const r = resolver.current;
    resolver.current = null;
    setAsk(null);
    r?.(v);
  };

  return (
    <Modal visible={ask !== null} transparent animationType="fade" onRequestClose={() => finish(null)}>
      <View style={{ flex: 1, justifyContent: 'flex-end', padding: 16, backgroundColor: 'rgba(0,0,0,0.45)' }}>
        <View
          testID="delete-password-sheet"
          accessibilityViewIsModal
          aria-modal
          role="dialog"
          aria-label="Confirm with your password"
          style={{ backgroundColor: t.card, borderRadius: t.neon ? 20 : 14, borderWidth: 1, borderColor: t.neon ? alpha(t.accent, 0.25) : t.border, padding: 18, gap: 12 }}
        >
          <RNText accessibilityRole="header" style={{ color: t.fg, fontSize: 18, fontWeight: '700' }}>Confirm with your password</RNText>
          <RNText style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>
            You are deleting <RNText style={{ color: t.fg, fontWeight: '600' }}>{ask?.what ?? 'this item'}</RNText>. Enter your SampCrew password to continue. It is checked for this one delete only.
          </RNText>
          {ask?.error ? <RNText testID="delete-password-error" style={{ color: t.danger, fontSize: 14 }}>{ask.error}</RNText> : null}
          <TextInput
            testID="delete-password-input"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoFocus
            autoCapitalize="none"
            autoComplete="current-password"
            textContentType="password"
            placeholder="Your password"
            placeholderTextColor={t.muted}
            onSubmitEditing={() => password && finish(password)}
            style={{ borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, color: t.fg, fontSize: 16 }}
          />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable testID="delete-password-cancel" accessibilityRole="button" onPress={() => finish(null)}
              style={({ pressed }) => ({ flex: 1, alignItems: 'center', borderRadius: 10, paddingVertical: 12, borderWidth: 1, borderColor: t.border, opacity: pressed ? 0.7 : 1 })}>
              <RNText style={{ color: t.fg, fontWeight: '600', fontSize: 15 }}>Cancel</RNText>
            </Pressable>
            <Pressable testID="delete-password-submit" accessibilityRole="button" disabled={!password} onPress={() => finish(password)}
              style={({ pressed }) => ({ flex: 1, alignItems: 'center', borderRadius: 10, paddingVertical: 12, backgroundColor: t.danger, opacity: !password ? 0.5 : pressed ? 0.8 : 1 })}>
              <RNText style={{ color: '#fff', fontWeight: '600', fontSize: 15 }}>Confirm and delete</RNText>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
