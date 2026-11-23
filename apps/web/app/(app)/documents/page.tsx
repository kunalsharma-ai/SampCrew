import { DOCUMENT_STATUS_LABEL } from '@crew/contracts';
import { Badge, buttonClass, Card, CardHeader, Input, PageHeader, Select, Stat } from '@crew/ui';
import { AlertTriangle, CheckCircle2, Clock, Download, FileStack, FileWarning, Inbox, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { SubNav, type SubNavItem } from '@/components/sub-nav';
import { load, loadOptional } from '@/lib/api';
import { CatalogueManager } from './catalogue-ui';
import type { Catalogue, DocRow, HistoryRow, MyDocAccess, Overview, RequestRow, Targets } from './types';
import { DocumentTable, HistoryList, LiveDocuments, RequestDocumentButton, RequestTable } from './ui';

export const metadata: Metadata = { title: 'Documents' };

type Sp = Record<string, string | undefined>;
type AdminTab = 'overview' | 'all' | 'employee' | 'hr' | 'requests' | 'verify' | 'approved' | 'rejected' | 'correction' | 'history' | 'categories' | 'mine';
type EmployeeTab = 'requests' | 'all' | 'pending' | 'approved' | 'rejected' | 'correction';

const PAGE = 50;
const FILTER_KEYS = ['q', 'category', 'status', 'requestedBy', 'from', 'to', 'hrWorkspaceId'] as const;

export default async function DocumentsPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const sp = await searchParams;
  const [mine, catalogue] = await Promise.all([load<MyDocAccess>('/documents/access/mine'), load<Catalogue>('/documents/catalogue')]);
  if (mine.level === 'employee_workspace') return <EmployeeDocuments sp={sp} mine={mine} />;
  return <CentralDocuments sp={sp} mine={mine} catalogue={catalogue} />;
}

// -------------------------------------------------------------------------------------------------------------
// Super Workspace and HR Workspace: Centralized Document Management
// -------------------------------------------------------------------------------------------------------------

async function CentralDocuments({ sp, mine, catalogue }: { sp: Sp; mine: MyDocAccess; catalogue: Catalogue }) {
  const isSuper = mine.level === 'super_workspace';
  const a = mine.access;
  const [overview, targets, myRequests] = await Promise.all([
    load<Overview>('/documents/center/overview'),
    a?.request || isSuper ? loadOptional<Targets>('/document-requests/targets') : Promise.resolve(null),
    load<{ items: RequestRow[]; total: number }>('/document-requests?scope=mine&status=open&limit=50'),
  ]);
  const tabs: AdminTab[] = ['overview', 'all', 'employee', 'hr', 'requests', 'verify', 'approved', 'rejected', 'correction', 'history', 'categories', ...(myRequests.total ? (['mine'] as AdminTab[]) : [])];
  const tab: AdminTab = tabs.includes(sp.tab as AdminTab) ? (sp.tab as AdminTab) : 'overview';
  const items: SubNavItem[] = [
    { href: '/documents?tab=overview', label: 'Overview', testId: 'doc-tab-overview' },
    { href: '/documents?tab=all', label: 'All documents', count: overview.total, testId: 'doc-tab-all' },
    { href: '/documents?tab=employee', label: 'Employee documents', count: overview.employeeDocuments },
    { href: '/documents?tab=hr', label: 'HR Workspace documents', count: overview.hrWorkspaceDocuments, testId: 'doc-tab-hr' },
    { href: '/documents?tab=requests', label: 'Document requests', count: overview.pendingRequests, alert: overview.overdueRequests > 0, testId: 'doc-tab-requests' },
    { href: '/documents?tab=verify', label: 'Pending verification', count: overview.awaitingMyVerification, alert: overview.awaitingMyVerification > 0, testId: 'doc-tab-verify' },
    { href: '/documents?tab=approved', label: 'Approved', count: overview.approved },
    { href: '/documents?tab=rejected', label: 'Rejected', count: overview.rejected },
    { href: '/documents?tab=correction', label: 'Correction required', count: overview.correction },
    { href: '/documents?tab=history', label: 'Document history' },
    { href: '/documents?tab=categories', label: 'Document categories' },
    ...(myRequests.total ? [{ href: '/documents?tab=mine', label: 'Asked of me', count: myRequests.total, alert: true, testId: 'doc-tab-mine' }] : []),
  ];

  const levelNote = isSuper
    ? 'Every document in the company, whoever owns it and whatever its status.'
    : mine.companyWide
      ? 'Documents of the employees you look after company-wide, within the access Super Workspace set for HR.'
      : `Documents of ${mine.hrWorkspaces.map((w) => w.name).filter(Boolean).join(', ') || 'your HR Workspace'}, within the access Super Workspace set.`;

  let body: React.ReactNode;
  if (tab === 'overview') {
    const [review, activity] = await Promise.all([
      load<{ items: RequestRow[]; total: number }>('/document-requests?scope=review&limit=10'),
      load<HistoryRow[]>('/documents/center/activity?limit=15'),
    ]);
    body = (
      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader title="Waiting for your verification" description="Submitted documents your level asked for. Open one to preview it and approve, reject or ask for a correction." action={review.total > 10 ? <Link className="text-sm text-accent hover:underline" href="/documents?tab=verify">See all {review.total}</Link> : undefined} />
          <RequestTable rows={review.items} showTarget empty="When someone uploads a document you asked for, it waits here and in Approvals." />
        </Card>
        <Card>
          <CardHeader title="Recent document activity" description="Requests, uploads, decisions, previews and downloads, newest first." />
          <HistoryList rows={[...activity].reverse()} />
        </Card>
      </div>
    );
  } else if (tab === 'requests' || tab === 'verify' || tab === 'mine') {
    const status = sp.rstatus && /^[a-z_]{2,30}$/.test(sp.rstatus) ? sp.rstatus : tab === 'requests' ? 'open' : undefined;
    const qs = new URLSearchParams({ scope: tab === 'verify' ? 'review' : tab === 'mine' ? 'mine' : 'all', limit: '200' });
    if (status && tab === 'requests') qs.set('status', status);
    if (tab === 'mine') qs.set('status', 'open');
    if (sp.q) qs.set('q', sp.q.slice(0, 100));
    const list = await load<{ items: RequestRow[]; total: number }>(`/document-requests?${qs}`);
    const copy = {
      requests: { title: 'Document requests', description: 'Every request your level can see, with who asked, the deadline and where it stands.' },
      verify: { title: 'Pending verification', description: 'Submissions waiting for your decision. The same requests appear in Approvals.' },
      mine: { title: 'Documents asked of me', description: 'Requests sent to you or your HR Workspace. Upload the file from the request.' },
    }[tab];
    body = (
      <Card>
        <CardHeader title={copy.title} description={copy.description} />
        {tab === 'requests' && (
          <form className="flex flex-wrap items-end gap-3 px-5 pb-4" method="get">
            <input type="hidden" name="tab" value="requests" />
            <label className="grid gap-1 text-[0.8125rem] font-medium">Search<Input name="q" defaultValue={sp.q ?? ''} placeholder="Name, title or reference" className="w-60" /></label>
            <label className="grid gap-1 text-[0.8125rem] font-medium">Status
              <Select name="rstatus" defaultValue={status ?? ''}>
                <option value="">Any</option>
                <option value="open">Open</option>
                <option value="awaiting_submission">Waiting for upload</option>
                <option value="awaiting_review">Waiting for verification</option>
                <option value="overdue">Overdue</option>
                <option value="correction_required">Correction required</option>
                <option value="rejected">Rejected</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </Select>
            </label>
            <button className={buttonClass('secondary', 'md')} type="submit">Apply</button>
          </form>
        )}
        <RequestTable rows={list.items} showTarget empty={tab === 'verify' ? 'Nothing is waiting for you.' : 'Use "Request document" to ask an employee or an HR Workspace for a document.'} />
      </Card>
    );
  } else if (tab === 'history') {
    const activity = await load<HistoryRow[]>('/documents/center/activity?limit=200');
    body = (
      <Card>
        <CardHeader title="Document history" description="The permanent record of requests, uploads, decisions, previews, downloads and access changes. It cannot be edited or deleted." />
        <HistoryList rows={[...activity].reverse()} />
      </Card>
    );
  } else if (tab === 'categories') {
    body = <CatalogueManager catalogue={catalogue} canAddType={isSuper || !!a?.request} />;
  } else {
    const fixed: Record<string, string> = tab === 'employee' ? { owner: 'employee' } : tab === 'hr' ? { owner: 'hr_workspace' } : tab === 'approved' ? { status: 'verified' } : tab === 'rejected' ? { status: 'rejected' } : tab === 'correction' ? { status: 'correction_required' } : {};
    const qs = new URLSearchParams({ ...fixed, limit: String(PAGE) });
    for (const k of FILTER_KEYS) if (sp[k] && !fixed[k]) qs.set(k, sp[k]!.slice(0, 100));
    const offset = Math.max(0, Number(sp.offset ?? 0) || 0);
    qs.set('offset', String(offset));
    const page = await load<{ items: DocRow[]; total: number }>(`/documents/center/documents?${qs}`);
    const exportQs = new URLSearchParams(qs);
    exportQs.delete('limit');
    exportQs.delete('offset');
    const titles: Record<string, [string, string]> = {
      all: ['All documents', levelNote],
      employee: ['Employee documents', 'Documents in employee profiles.'],
      hr: ['HR Workspace documents', 'Documents HR Workspaces keep or submitted to Super Workspace (registrations, policies, compliance and more).'],
      approved: ['Approved documents', 'Documents that passed verification.'],
      rejected: ['Rejected documents', 'Uploads that were rejected, with the reason kept in their history.'],
      correction: ['Correction required', 'Uploads sent back for a fix. The person has been told what to change.'],
    };
    const [title, description] = titles[tab] ?? titles.all!;
    const more = (o: number) => {
      const q = new URLSearchParams();
      q.set('tab', tab);
      for (const k of FILTER_KEYS) if (sp[k]) q.set(k, sp[k]!);
      q.set('offset', String(o));
      return `/documents?${q}`;
    };
    body = (
      <Card>
        <CardHeader title={title} description={description}
          action={isSuper || a?.export ? <a className={buttonClass('secondary', 'sm')} href={`/documents-export?${exportQs}`}><Download className="size-3.5" aria-hidden /> Export CSV</a> : undefined} />
        <form className="flex flex-wrap items-end gap-3 px-5 pb-4" method="get" aria-label="Filter documents">
          <input type="hidden" name="tab" value={tab} />
          <label className="grid gap-1 text-[0.8125rem] font-medium">Search<Input name="q" defaultValue={sp.q ?? ''} placeholder="Employee, title, type or reference" className="w-64" /></label>
          <label className="grid gap-1 text-[0.8125rem] font-medium">Category
            <Select name="category" defaultValue={sp.category ?? ''}>
              <option value="">Any</option>
              {catalogue.groups.map((g) => <option key={g.key} value={g.key}>{g.name}</option>)}
            </Select>
          </label>
          {!fixed.status && (
            <label className="grid gap-1 text-[0.8125rem] font-medium">Status
              <Select name="status" defaultValue={sp.status ?? ''}>
                <option value="">Any</option>
                {(['pending', 'verified', 'rejected', 'correction_required', 'unverified', 'expired'] as const).map((s) => <option key={s} value={s}>{DOCUMENT_STATUS_LABEL[s]}</option>)}
              </Select>
            </label>
          )}
          <label className="grid gap-1 text-[0.8125rem] font-medium">Requested by
            <Select name="requestedBy" defaultValue={sp.requestedBy ?? ''}>
              <option value="">Anyone</option>
              <option value="super_workspace">Super Workspace</option>
              <option value="hr_workspace">HR Workspace</option>
              <option value="none">Uploaded directly</option>
            </Select>
          </label>
          <label className="grid gap-1 text-[0.8125rem] font-medium">Uploaded from<Input type="date" name="from" defaultValue={sp.from ?? ''} /></label>
          <label className="grid gap-1 text-[0.8125rem] font-medium">to<Input type="date" name="to" defaultValue={sp.to ?? ''} /></label>
          <button className={buttonClass('secondary', 'md')} type="submit">Apply</button>
          {FILTER_KEYS.some((k) => sp[k]) && <Link className="pb-2 text-sm text-accent hover:underline" href={`/documents?tab=${tab}`}>Clear</Link>}
        </form>
        <DocumentTable rows={page.items} showOwner empty="Documents appear here as people upload them or answer requests." />
        {page.total > PAGE && (
          <div className="flex items-center justify-between border-t border-border px-5 py-3 text-sm text-fg-muted">
            <span>{offset + 1}–{Math.min(offset + PAGE, page.total)} of {page.total}</span>
            <span className="flex gap-3">
              {offset > 0 && <Link className="text-accent hover:underline" href={more(Math.max(0, offset - PAGE))}>Previous</Link>}
              {offset + PAGE < page.total && <Link className="text-accent hover:underline" href={more(offset + PAGE)}>Next</Link>}
            </span>
          </div>
        )}
      </Card>
    );
  }

  return (
    <>
      <LiveDocuments />
      <PageHeader
        title={isSuper ? 'Centralized Document Management' : 'Documents'}
        description={levelNote}
        actions={targets && (isSuper || a?.request) ? <RequestDocumentButton catalogue={catalogue} preset={null} targets={targets} /> : undefined}
      />
      {!isSuper && a && !a.enabled && <p className="mb-4 rounded-lg border border-border bg-bg-subtle px-4 py-3 text-sm text-fg-muted">Super Workspace has switched off document management for your HR Workspace. Nothing has been deleted.</p>}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Total documents" value={overview.total} icon={<FileStack className="size-4" />} />
        <Stat label="Pending verification" value={overview.pending} icon={<Clock className="size-4" />} />
        <Stat label="Approved" value={overview.approved} icon={<CheckCircle2 className="size-4" />} />
        <Stat label="Rejected or correction" value={overview.rejected + overview.correction} icon={<FileWarning className="size-4" />} />
        <Stat label="Open requests" value={overview.pendingRequests} icon={<Inbox className="size-4" />} hint={overview.overdueRequests ? <Badge tone="danger">{overview.overdueRequests} overdue</Badge> : 'None overdue'} />
        <Stat label="Expired" value={overview.expired} icon={overview.expired ? <AlertTriangle className="size-4" /> : <ShieldCheck className="size-4" />} />
      </div>
      <SubNav label="Document views" items={items} current={`/documents?tab=${tab}`} />
      {body}
    </>
  );
}

// -------------------------------------------------------------------------------------------------------------
// Employee Workspace: my documents
// -------------------------------------------------------------------------------------------------------------

async function EmployeeDocuments({ sp, mine }: { sp: Sp; mine: MyDocAccess }) {
  const [requests, docs] = await Promise.all([
    load<{ items: RequestRow[]; total: number }>('/document-requests?scope=mine&limit=200'),
    mine.employeeId ? load<DocRow[]>(`/employees/${mine.employeeId}/documents`) : Promise.resolve([] as DocRow[]),
  ]);
  const open = requests.items.filter((r) => !['completed', 'cancelled'].includes(r.status));
  const by = (s: string) => docs.filter((d) => d.status === s);
  const tabs: EmployeeTab[] = ['requests', 'all', 'pending', 'approved', 'rejected', 'correction'];
  const tab: EmployeeTab = tabs.includes(sp.tab as EmployeeTab) ? (sp.tab as EmployeeTab) : open.length ? 'requests' : 'all';
  const items: SubNavItem[] = [
    { href: '/documents?tab=requests', label: 'My document requests', count: open.length, alert: open.some((r) => r.overdue || r.status === 'correction_required'), testId: 'doc-tab-my-requests' },
    { href: '/documents?tab=all', label: 'Uploaded documents', count: docs.length, testId: 'doc-tab-uploaded' },
    { href: '/documents?tab=pending', label: 'Pending', count: by('pending').length },
    { href: '/documents?tab=approved', label: 'Approved', count: by('verified').length },
    { href: '/documents?tab=rejected', label: 'Rejected', count: by('rejected').length },
    { href: '/documents?tab=correction', label: 'Correction required', count: by('correction_required').length },
  ];
  const shown = tab === 'all' ? docs : tab === 'pending' ? by('pending') : tab === 'approved' ? by('verified') : tab === 'rejected' ? by('rejected') : tab === 'correction' ? by('correction_required') : [];
  return (
    <>
      <LiveDocuments />
      <PageHeader title="My documents" description="Documents HR Workspace or Super Workspace asked you for, and every document in your profile with its status." />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Waiting for you" value={open.filter((r) => ['new_request', 'pending_submission', 'correction_required', 'rejected'].includes(r.status)).length} icon={<Inbox className="size-4" />} hint={open.some((r) => r.overdue) ? <Badge tone="danger">Overdue</Badge> : undefined} />
        <Stat label="Being verified" value={open.filter((r) => ['submitted', 'resubmitted', 'under_verification'].includes(r.status)).length} icon={<Clock className="size-4" />} />
        <Stat label="Approved" value={by('verified').length} icon={<CheckCircle2 className="size-4" />} />
        <Stat label="Needs a fix" value={by('correction_required').length + by('rejected').length} icon={<FileWarning className="size-4" />} />
      </div>
      <SubNav label="My document views" items={items} current={`/documents?tab=${tab}`} />
      <Card>
        {tab === 'requests' ? (
          <>
            <CardHeader title="My document requests" description="Open a request to see what is needed and upload the file. It then goes for verification." />
            <RequestTable rows={requests.items} empty="When HR Workspace or Super Workspace asks you for a document, it appears here and in My tasks." />
          </>
        ) : (
          <>
            <CardHeader title={items.find((i) => i.href.endsWith(`=${tab}`))?.label ?? 'Documents'} description="Search and filter your documents. Approved documents stay in your profile." />
            <DocumentTable rows={shown} filterable empty="Your documents appear here once you upload them." />
          </>
        )}
      </Card>
    </>
  );
}
