import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text as RNText, View } from 'react-native';
import { type HelpKey, MOBILE_HELP } from '../lib/help';
import { useAppearanceTheme } from '../lib/appearance';
import { alpha } from '../lib/theme';

export type HelpKind = 'screen' | 'section' | 'field';

/**
 * The "i" icon: tap it to read what a screen, card or field is for, how to use it and when. The words live in
 * src/lib/help.ts. The help opens as a small sheet that a tap outside, the Got it button or the back gesture closes.
 *
 * Its name is "More about this screen" (or section, field) rather than the thing's own label, so a screen reader user
 * or a test looking for the field itself still finds one control; the thing's title is read as the hint.
 */
export function HelpTip({ help, kind = 'section' }: { help: HelpKey; kind?: HelpKind }) {
  const t = useAppearanceTheme();
  const [open, setOpen] = useState(false);
  const entry = MOBILE_HELP[help] as { title: string; what: string; how?: string; where?: string };
  const close = () => setOpen(false);
  const part = (label: string, body?: string) =>
    body ? (
      <View style={{ gap: 2 }}>
        <RNText style={{ color: t.accent, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' }}>{label}</RNText>
        <RNText style={{ color: t.fg, fontSize: 15, lineHeight: 21 }}>{body}</RNText>
      </View>
    ) : null;
  return (
    <>
      <Pressable
        testID={`help-${help}`}
        accessibilityRole="button"
        accessibilityLabel={`More about this ${kind}`}
        accessibilityHint={entry.title}
        aria-expanded={open}
        hitSlop={10}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          width: 22,
          height: 22,
          borderRadius: 11,
          borderWidth: 1.5,
          borderColor: alpha(t.accent, 0.55),
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <RNText style={{ color: t.accent, fontSize: 12, fontWeight: '800', fontStyle: 'italic', lineHeight: 14 }} aria-hidden>
          i
        </RNText>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <View style={{ flex: 1, justifyContent: 'flex-end', padding: 16, backgroundColor: 'rgba(0,0,0,0.45)' }}>
          <Pressable style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} onPress={close} accessibilityLabel="Close help" accessibilityRole="button" />
          <View
            testID="help-sheet"
            accessibilityViewIsModal
            aria-modal
            role="dialog"
            aria-label={entry.title}
            style={{ backgroundColor: t.card, borderRadius: t.neon ? 20 : 14, borderWidth: 1, borderColor: t.neon ? alpha(t.accent, 0.25) : t.border, padding: 18, gap: 12, maxHeight: '80%' }}
          >
            <RNText accessibilityRole="header" style={{ color: t.fg, fontSize: 18, fontWeight: '700' }}>{entry.title}</RNText>
            <ScrollView contentContainerStyle={{ gap: 12 }}>
              {part('What it is for', entry.what)}
              {part('How to use it', entry.how)}
              {part('Where and when', entry.where)}
            </ScrollView>
            <Pressable
              testID="help-close"
              accessibilityRole="button"
              onPress={close}
              style={({ pressed }) => ({ alignSelf: 'stretch', alignItems: 'center', borderRadius: 10, paddingVertical: 12, backgroundColor: t.accent, opacity: pressed ? 0.8 : 1 })}
            >
              <RNText style={{ color: t.accentFg, fontWeight: '600', fontSize: 15 }}>Got it</RNText>
            </Pressable>
          </View>
        </View>
      </Modal>
    </>
  );
}

/** Screen options that put the screen's "i" icon in the header, for Stack and Tabs screens. */
export function screenHelp(help: HelpKey) {
  return {
    headerRight: () => (
      <View style={{ marginRight: 14 }}>
        <HelpTip help={help} kind="screen" />
      </View>
    ),
  };
}
