import { HELP_KIND_LABEL, type HelpArticleView } from '@crew/contracts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { useSession } from '../../../src/lib/session';
import { Badge, Button, Card, CardTitle, Notice, Row, Screen, Text, Title, errorText, useLoad, useTheme } from '../../../src/ui';
import { ArticleItem } from '../index';

/** Paragraphs and "- " lists, as plain text (no HTML from content). */
function Body({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <View style={{ gap: 10 }} testID="help-body">
      {text.replace(/\r/g, '').split(/\n{2,}/).map((b, i) => <Text key={i} size={15}>{b.split('\n').map((l) => l.replace(/^\s*[-*] /, '•  ').replace(/\*\*([^*]+)\*\*/g, '$1')).join('\n')}</Text>)}
    </View>
  );
}

export default function HelpArticleScreen() {
  const { api } = useSession();
  const router = useRouter();
  const t = useTheme();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { data: a, error } = useLoad(() => api.get<HelpArticleView>(`/help/articles/${encodeURIComponent(slug ?? '')}`), [api, slug]);
  const [done, setDone] = useState<number[]>([]);
  const [vote, setVote] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (a) { setDone(a.mine.doneSteps); setVote(a.mine.helpful); } }, [a]);
  const toggle = async (i: number) => {
    if (!a) return;
    const next = !done.includes(i);
    setDone((cur) => (next ? [...cur, i] : cur.filter((x) => x !== i)));
    try { await api.put(`/help/articles/${a.slug}/progress`, { step: i, done: next }); } catch (e) { setMsg(errorText(e)); }
  };
  const sendVote = async (helpful: boolean) => {
    if (!a) return;
    setVote(helpful);
    try { await api.put(`/help/articles/${a.slug}/feedback`, { helpful }); } catch (e) { setMsg(errorText(e)); }
  };
  return (
    <Screen>
      {error && <Notice tone="danger">{error}</Notice>}
      {msg && <Notice tone="danger">{msg}</Notice>}
      {a && (
        <>
          <Row style={{ gap: 6 }}><Badge tone="info">{HELP_KIND_LABEL[a.kind]}</Badge><Text muted size={13}>{a.categoryName}</Text></Row>
          <Title>{a.title}</Title>
          {!!a.summary && <Text muted>{a.summary}</Text>}
          <Card testID="help-article-body">
            <Body text={a.body} />
            {a.videoUrl && <Button title="Watch the video" kind="secondary" onPress={() => void Linking.openURL(a.videoUrl!)} testID="help-video" />}
          </Card>
          {a.stepList.length > 0 && (
            <Card testID="help-steps">
              <CardTitle right={<Text muted size={13}>{`${done.length} of ${a.stepList.length} done`}</Text>}>Step by step</CardTitle>
              {a.stepList.map((s, i) => {
                const ok = done.includes(i);
                return (
                  <Pressable key={i} accessibilityRole="checkbox" accessibilityState={{ checked: ok }} onPress={() => void toggle(i)} testID="help-step"
                    style={{ flexDirection: 'row', gap: 10, paddingVertical: 8, borderTopWidth: i ? 1 : 0, borderColor: t.border }}>
                    <View style={{ width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: ok ? t.ok : t.card, borderWidth: 2, borderColor: ok ? t.ok : t.border }}>
                      <Text size={12} weight="700" style={{ color: ok ? '#fff' : t.muted }}>{ok ? '✓' : String(i + 1)}</Text>
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text weight="600">{s.title}</Text>
                      {!!s.body && <Text muted size={13}>{s.body}</Text>}
                    </View>
                  </Pressable>
                );
              })}
            </Card>
          )}
          <Card testID="help-feedback">
            <CardTitle>Was this helpful?</CardTitle>
            <Row style={{ gap: 8 }}>
              <View style={{ flex: 1 }}><Button title={vote === true ? '👍 Yes (thanks!)' : '👍 Yes'} kind={vote === true ? 'primary' : 'secondary'} onPress={() => void sendVote(true)} testID="help-yes" /></View>
              <View style={{ flex: 1 }}><Button title="👎 No" kind={vote === false ? 'primary' : 'secondary'} onPress={() => void sendVote(false)} testID="help-no" /></View>
            </Row>
          </Card>
          {a.related.length > 0 && (
            <Card>
              <CardTitle>Related articles</CardTitle>
              {a.related.map((r) => <ArticleItem key={r.id} a={r} />)}
            </Card>
          )}
          <Button title="Still need help? Raise a Query" onPress={() => router.push(`/help/ask?article=${a.id}`)} testID="help-raise" />
        </>
      )}
    </Screen>
  );
}
