'use client';
import { Alert, Avatar, Badge, Button, Card, CardBody, CardHeader, Dialog, Field, Input, Select } from '@crew/ui';
import { Camera, Copy, Fingerprint, KeyRound, Mail, Plus, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { photoUrl } from '@/lib/photo';
import type { AttendanceRegistration, EmployeeProfile } from '@/lib/types';
import { createLoginAction, type LoginResult, removePhotoAction, saveAttendanceRegistrationAction, uploadPhotoAction } from '../actions';

const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_PHOTO = 5 * 1024 * 1024;

/** The profile photo. HR and the employee themselves can change it: a button on the photo opens the file picker. */
export function PhotoAvatar({ e, size = 56 }: { e: EmployeeProfile; size?: number }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const canEdit = e.can.update || e.isSelf;
  const src = photoUrl(e);

  const upload = (file: File) => {
    setError(null);
    if (!PHOTO_TYPES.includes(file.type)) return setError('Use a PNG, JPEG or WebP image');
    if (file.size > MAX_PHOTO) return setError('Photos can be up to 5 MB');
    const fd = new FormData();
    fd.set('file', file, file.name);
    start(async () => {
      const r = await uploadPhotoAction(e.id, fd);
      if (!r.ok) setError(r.message);
      router.refresh();
    });
  };

  return (
    <span className="relative inline-flex shrink-0 flex-col items-center">
      <span className="relative">
        <Avatar name={e.displayName} size={size} src={src} />
        {canEdit && (
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={pending}
            aria-label={src ? `Change photo of ${e.displayName}` : `Add a photo of ${e.displayName}`}
            title={src ? 'Change photo' : 'Add photo'}
            className="absolute -bottom-1 -right-1 rounded-full border border-border bg-surface p-1 text-fg-muted shadow-sm hover:text-fg"
          >
            <Camera className="size-3.5" />
          </button>
        )}
      </span>
      {canEdit && (
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          aria-label="Choose a photo"
          tabIndex={-1}
          onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) upload(f); }}
        />
      )}
      {canEdit && src && (
        <button
          type="button"
          className="mt-1 text-[0.6875rem] font-normal text-fg-subtle hover:text-danger"
          disabled={pending}
          onClick={() => { if (confirm('Remove this photo?')) start(async () => { await removePhotoAction(e.id); router.refresh(); }); }}
        >
          Remove photo
        </button>
      )}
      {error && <span role="alert" className="absolute top-full mt-5 w-48 text-xs font-normal text-danger">{error}</span>}
    </span>
  );
}

/** Shows a login's temporary password once, with a copy button. */
export function TemporaryPassword({ login, onClose }: { login: { email: string; temporaryPassword: string } | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open={!!login} onClose={onClose} title="CREW login created" description="Share the temporary password in person or by phone. It is shown only now and is never emailed." footer={<Button onClick={onClose}>Done</Button>}>
      {login && (
        <div className="space-y-3 text-[0.8125rem]">
          <p>Sign-in email: <span className="font-medium">{login.email}</span></p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md border border-border bg-bg-subtle px-3 py-2 font-mono text-sm" data-testid="temporary-password">{login.temporaryPassword}</code>
            <Button variant="secondary" size="sm" onClick={() => { void navigator.clipboard?.writeText(login.temporaryPassword); setCopied(true); }}><Copy className="size-3.5" /> {copied ? 'Copied' : 'Copy'}</Button>
          </div>
          <p className="text-fg-muted">At their first sign-in they choose their own password before they can go on.</p>
        </div>
      )}
    </Dialog>
  );
}

/** CREW login for an employee who has none: send an invitation, or create it now with a temporary password. */
export function LoginCard({ e }: { e: EmployeeProfile }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'invite' | 'password'>('password');
  const [own, setOwn] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<LoginResult | null>(null);
  const [pending, start] = useTransition();
  if (e.membershipId || !e.can.update || e.status === 'exited') return null;
  const submit = () => {
    setError(null);
    start(async () => {
      const r = await createLoginAction(e.id, { mode, ...(mode === 'password' && own ? { initialPassword: password } : {}) });
      if (!r.ok) { setError(Object.values(r.fieldErrors ?? {})[0] ?? r.message); return; }
      setOpen(false);
      setDone(r.data ?? {});
      router.refresh();
    });
  };
  return (
    <Card>
      <CardHeader title="CREW login" />
      <CardBody className="space-y-3 text-[0.8125rem]">
        <p className="text-fg-muted">{e.displayName} has no CREW login yet, so they cannot sign in to the web portal or the mobile app.</p>
        {e.workEmail
          ? <Button size="sm" onClick={() => setOpen(true)}><KeyRound className="size-3.5" /> Create login</Button>
          : <p className="text-fg-subtle">Add a work email first: it is their sign-in name.</p>}
        {done?.inviteUrl && <Alert tone="info">Invitation sent. Link for testing: <span className="break-all font-mono text-xs">{done.inviteUrl}</span></Alert>}
      </CardBody>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Create a CREW login for ${e.displayName}`}
        description={`Sign-in email: ${e.workEmail ?? ''}`}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={submit} loading={pending}>{mode === 'invite' ? 'Send invitation' : 'Create login'}</Button></>}
      >
        <div className="space-y-3 text-[0.8125rem]">
          {error && <Alert tone="danger">{error}</Alert>}
          <LoginModeChoice mode={mode} onChange={(m) => setMode(m === 'none' ? 'password' : m)} allowNone={false} />
          {mode === 'password' && <OwnPassword own={own} setOwn={setOwn} password={password} setPassword={setPassword} />}
        </div>
      </Dialog>
      <TemporaryPassword login={done?.login ?? null} onClose={() => setDone((d) => (d ? { ...d, login: undefined } : d))} />
    </Card>
  );
}

export function LoginModeChoice({ mode, onChange, allowNone = true }: { mode: 'none' | 'invite' | 'password'; onChange: (m: 'none' | 'invite' | 'password') => void; allowNone?: boolean }) {
  const options = [
    ...(allowNone ? [{ key: 'none' as const, title: 'No login for now', body: 'Keep the employee record only. You can create the login later from their profile.', icon: X }] : []),
    { key: 'password' as const, title: 'Create the login now', body: 'Works straight away with a temporary password you hand over. They choose their own at first sign-in.', icon: KeyRound },
    { key: 'invite' as const, title: 'Email an invitation', body: 'They get a link at their work email and set their own password.', icon: Mail },
  ];
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-xs font-medium text-fg-muted">CREW login</legend>
      {options.map((o) => (
        <label key={o.key} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${mode === o.key ? 'border-accent bg-accent/5' : 'border-border hover:bg-bg-subtle'}`}>
          <input type="radio" name="loginMode" value={o.key} checked={mode === o.key} onChange={() => onChange(o.key)} className="mt-0.5" />
          <o.icon className="mt-0.5 size-4 text-fg-muted" aria-hidden />
          <span><span className="block font-medium text-fg">{o.title}</span><span className="block text-xs text-fg-muted">{o.body}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

export function OwnPassword({ own, setOwn, password, setPassword, error }: { own: boolean; setOwn: (v: boolean) => void; password: string; setPassword: (v: string) => void; error?: string }) {
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-xs text-fg-muted">
        <input type="checkbox" checked={own} onChange={(ev) => setOwn(ev.target.checked)} /> Type the temporary password myself (otherwise CREW generates a strong one)
      </label>
      {own && (
        <Field label="Temporary password" required error={error} hint="12+ characters with three of: lowercase, uppercase, numbers, symbols">
          {(f) => <Input {...f} name="initialPassword" type="text" autoComplete="off" value={password} onChange={(ev) => setPassword(ev.target.value)} />}
        </Field>
      )}
    </div>
  );
}

export interface ShiftOption { id: string; name: string; code: string; startTime: string; endTime: string }
export interface DeviceOption { id: string; name: string; serialNumber?: string }

/** Rows of enrolment numbers (the user number on an attendance machine), each for one machine or all of them. */
export function EnrolmentRows({ rows, setRows, devices }: { rows: { deviceUserId: string; deviceId: string }[]; setRows: (r: { deviceUserId: string; deviceId: string }[]) => void; devices: DeviceOption[] }) {
  return (
    <div className="space-y-2 sm:col-span-2">
      <p className="text-xs font-medium text-fg-muted">Attendance machine enrolment numbers</p>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <Field label={`Enrolment number ${i + 1}`}>
            {(f) => <Input {...f} value={r.deviceUserId} maxLength={32} placeholder="1042" onChange={(ev) => setRows(rows.map((x, j) => (j === i ? { ...x, deviceUserId: ev.target.value } : x)))} />}
          </Field>
          <Field label="Machine">
            {(f) => (
              <Select {...f} value={r.deviceId} onChange={(ev) => setRows(rows.map((x, j) => (j === i ? { ...x, deviceId: ev.target.value } : x)))}>
                <option value="">All machines</option>
                {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            )}
          </Field>
          <Button variant="ghost" size="sm" aria-label={`Remove enrolment number ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="size-3.5" /></Button>
        </div>
      ))}
      {rows.length < 5 && <Button variant="secondary" size="sm" onClick={() => setRows([...rows, { deviceUserId: '', deviceId: '' }])}><Plus className="size-3.5" /> Add enrolment number</Button>}
      <p className="text-xs text-fg-subtle">Enrol the person&apos;s fingerprint, face or card on the machine under the same number. Punches from that number count for them.</p>
    </div>
  );
}

/** Attendance registration on the profile: usual shift and enrolment numbers, editable by HR. */
export function AttendanceCard({ e, reg, shifts, devices, canEdit }: { e: EmployeeProfile; reg: AttendanceRegistration; shifts: ShiftOption[] | null; devices: DeviceOption[] | null; canEdit: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(reg.defaultShift?.id ?? '');
  const [rows, setRows] = useState(reg.enrolments.map((x) => ({ deviceUserId: x.deviceUserId, deviceId: x.deviceId ?? '' })));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = () => {
    setError(null);
    start(async () => {
      const r = await saveAttendanceRegistrationAction(e.id, { defaultShiftId: shift || null, enrolments: rows.filter((x) => x.deviceUserId.trim()).map((x) => ({ deviceUserId: x.deviceUserId.trim(), deviceId: x.deviceId || null })) });
      if (!r.ok) { setError(Object.values(r.fieldErrors ?? {})[0] ?? r.message); return; }
      setOpen(false);
      router.refresh();
    });
  };
  return (
    <Card>
      <CardHeader
        title="Attendance registration"
        action={canEdit && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><Fingerprint className="size-3.5" /> {reg.registered ? 'Edit' : 'Register'}</Button>}
      />
      <CardBody>
        <dl className="grid gap-4 text-sm">
          <div>
            <dt className="text-xs text-fg-subtle">Usual shift</dt>
            <dd className="mt-0.5">{reg.defaultShift ? `${reg.defaultShift.name} (${reg.defaultShift.startTime} to ${reg.defaultShift.endTime})` : 'Location default'}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-subtle">Enrolment numbers</dt>
            <dd className="mt-1 flex flex-wrap gap-1.5">
              {reg.enrolments.length ? reg.enrolments.map((x) => <Badge key={x.id}>{x.deviceUserId} · {x.deviceName ?? 'all machines'}</Badge>) : <span className="text-fg-muted">Not enrolled on a machine (web and mobile punches still work)</span>}
            </dd>
          </div>
        </dl>
      </CardBody>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title={`Attendance registration for ${e.displayName}`}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save} loading={pending}>Save registration</Button></>}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {error && <Alert tone="danger" className="sm:col-span-2">{error}</Alert>}
          {shifts ? (
            <Field label="Usual shift" className="sm:col-span-2" hint="Rosters and day-by-day assignments still take priority">
              {(f) => <Select {...f} value={shift} onChange={(ev) => setShift(ev.target.value)}><option value="">Location default</option>{shifts.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.startTime} to {s.endTime})</option>)}</Select>}
            </Field>
          ) : <p className="text-xs text-fg-muted sm:col-span-2">Shifts are not part of this plan, so the location&apos;s default applies.</p>}
          {devices ? <EnrolmentRows rows={rows} setRows={setRows} devices={devices} /> : <p className="text-xs text-fg-muted sm:col-span-2">Managing machine enrolment numbers needs the attendance device permission.</p>}
        </div>
      </Dialog>
    </Card>
  );
}
