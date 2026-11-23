import { useRouter } from 'expo-router';
import { useBadges } from '../../src/lib/badges';
import { useMobileApp } from '../../src/lib/mobile-app';
import { Card, fmt, Notice, Screen, Text } from '../../src/ui';
import { EmptyState, IconRow, MODULE_TONE, Section, SkeletonCard } from '../../src/ui/kit';

/** Every module the person has that is not in the bottom bar, in the order the Super Workspace set. */
export default function More() {
  const router = useRouter();
  const { app, stale, refresh } = useMobileApp();
  const badges = useBadges();
  const modules = app ? app.more.map((k) => app.modules.find((m) => m.key === k)).filter((m): m is NonNullable<typeof m> => !!m) : [];
  const badgeOf = (key: string) => (key === 'chat' ? badges.chat : key === 'notifications' ? badges.notifications : 0);

  return (
    <Screen onRefresh={() => void refresh().then(badges.refresh)}>
      {stale && <Notice tone="warn">Could not reach SampCrew. This menu is the one from your last visit.</Notice>}
      {!app && <SkeletonCard lines={5} />}
      {app && modules.length === 0 && (
        <EmptyState icon="grid" tone="violet" title="Everything is in the bottom bar" body="Your company has no other modules for you in the app right now." />
      )}
      {modules.length > 0 && (
        <>
          <Section title="Modules" />
          <Card testID="more-list">
            {modules.map((m) => (
              <IconRow
                key={m.key}
                testID={`more-${m.key}`}
                icon={m.icon}
                tone={MODULE_TONE[m.key]}
                title={m.name}
                subtitle={m.description}
                badge={badgeOf(m.key)}
                onPress={() => router.push(m.route as never)}
              />
            ))}
          </Card>
        </>
      )}
      {app && (
        <Text muted size={12} style={{ textAlign: 'center' }} testID="more-version">
          {app.version > 0
            ? `${app.levelLabel} menu, set by your company’s Super Workspace (version ${app.version}${app.publishedAt ? `, ${fmt.date(app.publishedAt)}` : ''}).`
            : `${app.levelLabel} menu with SampCrew’s standard modules.`}
        </Text>
      )}
    </Screen>
  );
}
