import { Alert, Card, CardHeader, PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load, loadOptional } from '@/lib/api';
import type { Catalogue, DocDetail } from '../types';
import { fmtDate, fmtSize, fmtWhen } from '../format';
import { DocStatusBadge, FileActions, HistoryList, LiveDocuments, PreviewPanel, RequestDocumentButton, RequestStatusBadge } from '../ui';

export const metadata: Metadata = { title: 'Document' };

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await load<DocDetail>(`/documents/center/documents/${id}`);
  const catalogue = d.canRequestReplacement ? await loadOptional<Catalogue>('/documents/catalogue') : null;
  const owner = d.ownerType === 'hr_workspace' ? d.hrWorkspace?.name ?? 'HR Workspace' : d.employee?.name ?? 'Employee';
  return (
    <>
      <LiveDocuments />
      <PageHeader
        eyebrow={`Document · ${d.reference}`}
        title={d.title}
        description={`${d.typeName ?? d.categoryName} · ${owner}`}
        actions={
          <span className="flex flex-wrap items-center gap-3">
            {catalogue && d.employee && (
              <RequestDocumentButton catalogue={catalogue} variant="secondary" label="Request replacement"
                preset={{ target: 'employee', employeeIds: [d.employee.id], employeeName: d.employee.name, replacesDocumentId: d.id, typeKey: d.typeKey ?? undefined }} />
            )}
            <Link className="text-sm font-medium text-accent hover:underline" href="/documents?tab=all">All documents</Link>
          </span>
        }
      />
      {d.supersededAt && <div className="mb-4"><Alert tone="info" title="Replaced">A newer version replaced this document on {fmtDate(d.supersededAt)}. It is kept for the record.</Alert></div>}
      {d.expired && <div className="mb-4"><Alert tone="warning" title="Expired">This document expired on {fmtDate(d.expiresOn)}. Request a replacement to collect a current one.</Alert></div>}
      {d.verificationRemarks && (
        <div className="mb-4">
          <Alert tone={d.verificationStatus === 'rejected' ? 'danger' : d.verificationStatus === 'correction_required' ? 'warning' : 'success'}
            title={`${d.verificationStatus === 'rejected' ? 'Reason for rejection' : d.verificationStatus === 'correction_required' ? 'What must be corrected' : 'Comment on approval'}${d.verifiedBy?.name ? ` from ${d.verifiedBy.name}` : ''}`}>
            {d.verificationRemarks}
          </Alert>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <div className="grid content-start gap-5">
          <Card>
            <CardHeader title="Preview" description="Opened through a short-lived, permission-checked link. Every preview and download is recorded." action={<FileActions d={d} />} />
            <div className="px-5 pb-5"><PreviewPanel d={d} /></div>
          </Card>
          {d.versions.length > 1 && (
            <Card>
              <CardHeader title="Versions" description="Every version of this document, newest first." />
              <ul className="grid gap-2 px-5 pb-5 text-sm">
                {d.versions.map((v) => (
                  <li key={v.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ${v.id === d.id ? 'border-accent' : 'border-border'}`}>
                    <span><Link className="font-medium hover:underline" href={`/documents/${v.id}`}>v{v.version}</Link> · {fmtWhen(v.createdAt)} <DocStatusBadge status={v.status} label={v.statusLabel} /></span>
                    <FileActions d={v} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <CardHeader title="Document history" description="Requests, uploads, decisions, previews and downloads. This record cannot be changed." />
            <HistoryList rows={d.history} />
          </Card>
        </div>
        <div className="grid content-start gap-5">
          <Card>
            <CardHeader title="Document details" />
            <dl className="grid gap-3 px-5 pb-5 text-sm">
              <Row k="Status"><DocStatusBadge status={d.status} label={d.statusLabel} /></Row>
              <Row k="Owner">{owner}{d.employee?.code ? <span className="text-fg-subtle"> · {d.employee.code}</span> : null}{d.employee && <Link className="ml-2 text-accent hover:underline" href={`/employees/${d.employee.id}?tab=documents`}>Profile</Link>}</Row>
              {d.ownerType === 'employee' && d.hrWorkspace && <Row k="HR Workspace">{d.hrWorkspace.name ?? '—'}</Row>}
              <Row k="Category">{d.categoryName}</Row>
              <Row k="File">{d.fileName}<span className="block text-xs text-fg-muted">{fmtSize(d.sizeBytes)} · version {d.version}</span></Row>
              <Row k="Uploaded">{fmtWhen(d.createdAt)}{d.submittedBy ? <span className="block text-xs text-fg-muted">by {d.submittedBy}</span> : null}</Row>
              <Row k="Requested by">{d.requestedBy ? <>{d.requestedBy.label}<span className="block text-xs text-fg-muted">{d.requestedBy.name}</span></> : 'Uploaded directly'}</Row>
              {d.verifiedBy && <Row k="Verified by">{d.verifiedBy.name}{d.verifiedBy.designation ? `, ${d.verifiedBy.designation}` : ''}<span className="block text-xs text-fg-muted">{d.verifiedBy.level}{d.verifiedAt ? ` · ${fmtWhen(d.verifiedAt)}` : ''}</span></Row>}
              {d.verificationRemarks && <Row k={d.verificationStatus === 'rejected' ? 'Reason' : 'Reviewer comment'}>{d.verificationRemarks}</Row>}
              {d.submitterRemarks && <Row k="Note from uploader">{d.submitterRemarks}</Row>}
              <Row k="Expires">{d.expiresOn ? fmtDate(d.expiresOn) : 'Does not expire'}</Row>
              {d.sensitive && <Row k="Sensitive">Yes: file name hidden from people who cannot download</Row>}
            </dl>
          </Card>
          {d.request && (
            <Card>
              <CardHeader title="Request" description={d.request.reason} />
              <div className="flex flex-wrap items-center gap-2 px-5 pb-5 text-sm">
                <Link className="font-medium text-accent hover:underline" href={`/documents/requests/${d.request.id}`}>{d.request.reference}</Link>
                <RequestStatusBadge r={d.request} />
                {d.request.dueOn && <span className="text-fg-muted">due {fmtDate(d.request.dueOn)}</span>}
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2">
      <dt className="text-fg-muted">{k}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
