import { Stack, useLocalSearchParams } from 'expo-router';
import * as ScreenCapture from 'expo-screen-capture';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useSession } from '../../src/lib/session';
import type { Payslip } from '../../src/lib/types';
import { Card, fmt, Loading, Notice, Row, Screen, Text, useLoad } from '../../src/ui';

/** Pay details are private: screenshots and screen recording are blocked on this screen (iOS and Android). */
function useNoCapture() {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const key = 'payslip';
    void ScreenCapture.preventScreenCaptureAsync(key).catch(() => undefined);
    return () => void ScreenCapture.allowScreenCaptureAsync(key).catch(() => undefined);
  }, []);
}

export default function PayslipScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  useNoCapture();
  const { data: p, error } = useLoad(() => api.get<Payslip>(`/payslips/${id}`), [api, id]);
  if (!p) return <Screen>{error ? <Notice tone="danger">{error}</Notice> : <Loading />}</Screen>;
  const money = (v: string) => fmt.money(v, p.currency);
  const section = (title: string, kind: string, total: string) => {
    const lines = p.lines.filter((l) => l.kind === kind);
    if (!lines.length) return null;
    return (
      <Card>
        <Text weight="700">{title}</Text>
        {lines.map((l) => (
          <Row key={l.code} style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <Text style={{ flex: 1 }}>{l.name}</Text>
            <Text weight="600">{money(l.amount)}</Text>
          </Row>
        ))}
        <Row style={{ justifyContent: 'space-between' }}>
          <Text weight="700">Total</Text>
          <Text weight="700">{money(total)}</Text>
        </Row>
      </Card>
    );
  };
  return (
    <Screen>
      <Stack.Screen options={{ title: fmt.month(p.month) }} />
      {p.isDemo && <Notice tone="warn">Demo workspace: this payslip is made from sample data.</Notice>}
      <Card testID="payslip-summary">
        <Text muted size={13}>{p.legalEntityName}</Text>
        <Text size={13} muted>{`${p.name} (${p.code}) · paid ${fmt.date(p.payDate)}`}</Text>
        <Text size={13} muted>{`Paid days ${p.paidDays} of ${p.daysInPeriod}${Number(p.lopDays) > 0 ? ` · loss of pay ${p.lopDays}` : ''}`}</Text>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text weight="700">Net pay</Text>
          <Text size={20} weight="700" testID="net-pay">{money(p.net)}</Text>
        </Row>
      </Card>
      {section('Earnings', 'earning', p.gross)}
      {section('Deductions', 'deduction', p.deductions)}
      {section('Reimbursements', 'reimbursement', p.reimbursements)}
      <Text muted size={13}>The Web Portal shows how each line was worked out and lets you print the payslip.</Text>
    </Screen>
  );
}
