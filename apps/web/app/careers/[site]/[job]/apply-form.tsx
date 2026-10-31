'use client';
import { Alert, Button, Card, CardBody, CardHeader, Checkbox, Field, Input, Textarea } from '@crew/ui';
import { useState, useTransition } from 'react';
import { applyAction } from '../../actions';

const MAX = 5 * 1024 * 1024;

export function ApplyForm({ site, job, privacyNotice, organisation }: { site: string; job: string; privacyNotice: string; organisation: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  if (done) {
    return (
      <Alert tone="success" title="Thank you, we have your application">
        {organisation} will review it and be in touch. A confirmation email is on its way to you.
      </Alert>
    );
  }
  return (
    <Card id="apply">
      <CardHeader title="Apply for this job" />
      <CardBody>
        <form
          className="grid grid-cols-2 gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const cv = form.get('cv');
            if (!(cv instanceof File) || !cv.size) return setFe({ cv: 'Attach your CV' });
            if (cv.size > MAX) return setFe({ cv: 'Your CV must be 5 MB or smaller' });
            if (!/\.(pdf|docx)$/i.test(cv.name)) return setFe({ cv: 'Attach a PDF or Word (.docx) file' });
            setError(null);
            setFe({});
            start(async () => {
              const r = await applyAction(site, job, form);
              if (r.ok) setDone(true);
              else { setError(r.message); setFe(r.fieldErrors ?? {}); }
            });
          }}
        >
          {error && <Alert tone="danger" className="col-span-2">{error}</Alert>}
          <Field label="First name" required error={fe.firstName} className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="firstName" required autoComplete="given-name" />}</Field>
          <Field label="Last name" error={fe.lastName} className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="lastName" autoComplete="family-name" />}</Field>
          <Field label="Email" required error={fe.email} className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="email" type="email" required autoComplete="email" />}</Field>
          <Field label="Phone" error={fe.phone} className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="phone" type="tel" autoComplete="tel" />}</Field>
          <Field label="Where you are based" error={fe.locationText} className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="locationText" />}</Field>
          <Field label="Profile or portfolio link" error={fe.profileUrl} className="col-span-2 sm:col-span-1">{(p) => <Input {...p} name="profileUrl" type="url" placeholder="https://" />}</Field>
          <Field label="CV" required hint="PDF or Word (.docx), up to 5 MB" error={fe.cv} className="col-span-2">
            {(p) => <Input {...p} name="cv" type="file" required accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />}
          </Field>
          <Field label="Anything you would like to add" error={fe.coverNote} className="col-span-2">{(p) => <Textarea {...p} name="coverNote" rows={4} />}</Field>
          {/* Hidden from people; bots tend to fill it in. */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
            <label>Website<input name="website" type="text" tabIndex={-1} autoComplete="off" /></label>
          </div>
          <div className="col-span-2 grid gap-2 rounded-md border border-border bg-bg-subtle p-3 text-[13px]">
            <div className="font-medium">How {organisation} uses your details</div>
            <p className="whitespace-pre-wrap text-fg-muted">{privacyNotice}</p>
            <Checkbox name="consent" value="true" required label="I have read this and agree to my details being used to consider my application" />
            {fe.consent && <span className="text-danger">{fe.consent}</span>}
          </div>
          <div className="col-span-2"><Button type="submit" loading={pending}>Submit application</Button></div>
        </form>
      </CardBody>
    </Card>
  );
}
