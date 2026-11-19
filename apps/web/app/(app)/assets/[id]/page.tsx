import { ASSET_STATUS_LABEL } from '@crew/contracts';
import { Badge, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { load, loadOptional } from '@/lib/api';
import type { Me } from '@/lib/types';
import { STATUS_TONE } from '../labels';
import type { AssetDetail, Category } from '../types';
import { AssetView } from './asset-view';
import { CustomFieldsCard, type FieldValue } from '@/components/custom-fields-card';

export const metadata: Metadata = { title: 'Asset' };

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [a, categories, me, fields] = await Promise.all([load<AssetDetail>(`/assets/${id}`), loadOptional<Category[]>('/assets/categories'), load<Me>('/me'), loadOptional<FieldValue[]>(`/custom-fields/values/asset/${id}`)]);
  return (
    <>
      <PageHeader
        eyebrow={<span className="font-mono">{a.assetCode}</span>}
        title={<span className="flex flex-wrap items-center gap-3">{a.name}<Badge tone={STATUS_TONE[a.status]}>{ASSET_STATUS_LABEL[a.status as keyof typeof ASSET_STATUS_LABEL]}</Badge></span>}
        description={[a.category, a.brand, a.model].filter(Boolean).join(' · ') || undefined}
      />
      <AssetView a={a} categories={(categories ?? []).filter((c) => !c.archived)} currency={me.tenant.currency} />
      {fields && fields.length > 0 && <div className="mt-6"><CustomFieldsCard entity="asset" recordId={id} initial={fields} path={`/assets/${id}`} /></div>}
    </>
  );
}
