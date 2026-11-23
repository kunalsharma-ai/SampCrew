import { HELP_ICONS, HELP_KIND_LABEL, type HelpArticleSummary, type HelpHome, type HelpIcon } from '@crew/contracts';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSession } from '../../src/lib/session';
import { Button, Card, CardTitle, Empty, Field, Hero, ListItem, Notice, QuickActions, Screen, Text, useLoad, useReloadOnFocus, useTheme } from '../../src/ui';

export function ArticleItem({ a }: { a: HelpArticleSummary }) {
  const router = useRouter();
  return <ListItem title={a.title} subtitle={`${HELP_KIND_LABEL[a.kind]} · ${a.categoryName}${a.steps ? ` · ${a.steps} steps` : ''}`} onPress={() => router.push(`/help/article/${a.slug}`)} testID="help-article" />;
}

/** Help & Support on the phone: search, quick buttons, categories, quick starts, FAQs, popular and recently viewed. */
export default function HelpHomeScreen() {
  const { api } = useSession();
  const router = useRouter();
  const t = useTheme();
  const [q, setQ] = useState('');
  const { data: home, error, reload, loading } = useLoad(() => api.get<HelpHome>('/help'), [api]);
  useReloadOnFocus(reload);
  const search = () => { if (q.trim()) router.push(`/help/search?q=${encodeURIComponent(q.trim())}`); };
  const actions = [
    { label: 'Guides', icon: '📘', tone: 'violet' as const, onPress: () => router.push('/help/search?kind=guide'), testID: 'help-quick-guides' },
    { label: 'FAQs', icon: '❓', tone: 'blue' as const, onPress: () => router.push('/help/search?kind=faq'), testID: 'help-quick-faqs' },
    { label: 'Tutorials', icon: '🎓', tone: 'green' as const, onPress: () => router.push('/help/search?kind=tutorial'), testID: 'help-quick-tutorials' },
    ...(home?.queries.raise ? [{ label: 'Raise a Query', icon: '🎫', tone: 'orange' as const, onPress: () => router.push('/help/ask'), testID: 'help-quick-raise' }] : []),
  ];
  return (
    <Screen onRefresh={reload} refreshing={loading && !!home}>
      <Hero eyebrow={home ? `Help & Support · ${home.levelLabel}` : 'Help & Support'} title="How can we help?" subtitle={home?.welcome} testID="help-hero" />
      {error && <Notice tone="danger">{error}</Notice>}
      <Card>
        <Field label="Search help" placeholder="Features, questions or error messages" value={q} onChangeText={setQ} onSubmitEditing={search} returnKeyType="search" testID="help-search" />
        <Button title="Search" onPress={search} disabled={!q.trim()} testID="help-search-go" />
      </Card>
      <QuickActions actions={actions} />
      {home?.queries.raise && (
        <Card testID="help-my-queries">
          <CardTitle>My queries</CardTitle>
          <ListItem title={home.queries.open ? `${home.queries.open} open ${home.queries.open === 1 ? 'query' : 'queries'}` : 'Your queries'} subtitle="Follow replies and statuses" onPress={() => router.push('/help/queries')} testID="help-open-queries" />
        </Card>
      )}
      {home && home.quickstarts.length > 0 && (
        <Card testID="help-quickstarts">
          <CardTitle>Quick start</CardTitle>
          {home.quickstarts.map((a) => <ArticleItem key={a.id} a={a} />)}
        </Card>
      )}
      {home && (
        <Card testID="help-categories">
          <CardTitle>Browse by category</CardTitle>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {home.categories.filter((c) => !c.parentId).map((c) => (
              <Pressable key={c.id} accessibilityRole="button" onPress={() => router.push(`/help/category/${c.key}`)} testID="help-category"
                style={{ width: '48%', borderWidth: 1, borderColor: t.border, borderRadius: 14, padding: 12, gap: 4, backgroundColor: t.card }}>
                <Text size={22}>{HELP_ICONS[c.icon as HelpIcon] ?? '📘'}</Text>
                <Text weight="600" size={14} numberOfLines={2}>{c.name}</Text>
                <Text muted size={12}>{`${c.count} articles`}</Text>
              </Pressable>
            ))}
          </View>
        </Card>
      )}
      {home && (
        <Card testID="help-faqs">
          <CardTitle>Frequently asked questions</CardTitle>
          {home.faqs.map((a) => <ArticleItem key={a.id} a={a} />)}
        </Card>
      )}
      {home && home.recent.length > 0 && (
        <Card testID="help-recent">
          <CardTitle>Recently viewed</CardTitle>
          {home.recent.map((a) => <ArticleItem key={a.id} a={a} />)}
        </Card>
      )}
      {home && (
        <Card testID="help-popular">
          <CardTitle>Popular articles</CardTitle>
          {home.popular.length ? home.popular.map((a) => <ArticleItem key={a.id} a={a} />) : <Empty>Nothing yet.</Empty>}
        </Card>
      )}
    </Screen>
  );
}
