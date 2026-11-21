import { useRouter } from 'expo-router';
import { useSession } from '../../src/lib/session';
import type { PayslipRow } from '../../src/lib/types';
import { Card, fmt, Notice, Screen, Text, useLoad } from '../../src/ui';
import { EmptyState, IconRow, ModuleGate, SkeletonCard } from '../../src/ui/kit';

/** The person's published payslips, newest first. */
function Payslips() {
  const { api } = useSession();
  const router = useRouter();
  const { data, error, loading, reload } = useLoad(() => api.get<PayslipRow[]>('/payslips?mine=true'), [api]);
  return (
    <Screen onRefresh={reload} refreshing={loading && !!data}>
      {error && <Notice tone="danger">{error}</Notice>}
      {!data && !error && <SkeletonCard lines={4} />}
      {data?.length === 0 && <EmptyState icon="wallet" tone="teal" title="No payslips yet" body="Your payslip shows here once payroll for the month is finalised." />}
      {data && data.length > 0 && (
        <Card testID="payslips-list">
          {data.map((p) => (
            <IconRow key={p.id} icon="wallet" tone="teal" title={fmt.month(p.month)} subtitle={`Paid ${fmt.date(p.payDate)}`} right={<Text weight="700">{fmt.money(p.net, p.currency)}</Text>} onPress={() => router.push(`/payslips/${p.id}`)} />
          ))}
        </Card>
      )}
    </Screen>
  );
}

export default function PayslipsScreen() {
  return (
    <ModuleGate module="payslips">
      <Payslips />
    </ModuleGate>
  );
}
