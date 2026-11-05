import { Badge, Card, CardHeader, EmptyState, Input, PageHeader, Table, TBody, TD, TH, THead, TR } from '@crew/ui';
import { Wallet } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import { amount } from '../labels';
import type { SalaryRow } from '../types';

export const metadata: Metadata = { title: 'Salaries' };

export default async function SalariesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const rows = await load<SalaryRow[]>(`/payroll/salaries${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  const missing = rows.filter((r) => !r.annualCtc).length;
  return (
    <>
      <PageHeader title="Salaries" description="Annual CTC and its monthly breakdown for each employee, effective-dated. Open someone to add a revision." />
      <Card>
        <CardHeader
          title="Employees"
          description={missing ? `${missing} without a salary; they are left out of payroll until one is assigned.` : 'Everyone has a salary.'}
          action={<form><Input name="q" defaultValue={q} placeholder="Search name or code" className="w-56" /></form>}
        />
        {rows.length ? (
          <Table>
            <THead><tr><TH>Employee</TH><TH>Legal entity</TH><TH>Structure</TH><TH>Effective from</TH><TH className="text-right">Annual CTC</TH></tr></THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <Link className="font-medium text-accent hover:underline" href={`/payroll/salaries/${r.id}`}>{r.name}</Link>
                    <div className="text-xs text-fg-muted"><span className="font-mono">{r.code}</span>{r.departmentName ? ` · ${r.departmentName}` : ''}</div>
                  </TD>
                  <TD>{r.legalEntityName ?? '–'}</TD>
                  <TD>{r.structureName ?? '–'}</TD>
                  <TD className="text-fg-muted">{r.effectiveFrom ?? '–'}{r.upcomingRevisions > 0 && <Badge tone="info" className="ml-2">revision scheduled</Badge>}</TD>
                  <TD className="text-right tabular-nums">{r.annualCtc ? amount(r.annualCtc, r.currency) : <Badge tone="warning">No salary</Badge>}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <EmptyState icon={<Wallet className="size-5" />} title="No employees found" description="Employees in the legal entities you look after appear here." />
        )}
      </Card>
    </>
  );
}
