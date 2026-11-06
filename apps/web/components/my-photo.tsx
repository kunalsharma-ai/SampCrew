'use client';
import { Alert, Avatar, Button, Card, CardBody, CardHeader } from '@crew/ui';
import { Camera, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { removePhotoAction, uploadPhotoAction } from '@/app/(app)/employees/actions';
import { photoUrl } from '@/lib/photo';

const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX = 5 * 1024 * 1024;

/** The signed-in person's own photo: upload, change or remove it. Shown in their settings. */
export function MyPhoto({ employee, name }: { employee: { id: string; photoUpdatedAt: string | null } | null; name: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const src = employee ? photoUrl(employee) : null;
  const upload = (file: File) => {
    if (!employee) return;
    if (!TYPES.includes(file.type)) return setMsg({ tone: 'danger', text: 'Use a PNG, JPEG or WebP image.' });
    if (file.size > MAX) return setMsg({ tone: 'danger', text: 'Photos can be up to 5 MB.' });
    const fd = new FormData();
    fd.set('file', file, file.name);
    start(async () => {
      const r = await uploadPhotoAction(employee.id, fd);
      setMsg(r.ok ? { tone: 'success', text: 'Your photo is saved. Your colleagues see it across SampCrew.' } : { tone: 'danger', text: r.message });
      router.refresh();
    });
  };
  return (
    <Card className="mb-6" aria-label="Your photo">
      <CardHeader title="Your photo" description="Shown on your profile, in the employee list and at the top of every page." />
      <CardBody className="space-y-3 text-[0.8125rem]">
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {employee ? (
          <div className="flex flex-wrap items-center gap-4">
            <Avatar name={name} size={72} src={src} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" loading={pending} onClick={() => input.current?.click()}><Camera className="size-3.5" /> {src ? 'Change photo' : 'Upload photo'}</Button>
              {src && (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(async () => {
                  const r = await removePhotoAction(employee.id);
                  setMsg(r.ok ? { tone: 'success', text: 'Your photo is removed.' } : { tone: 'danger', text: r.message });
                  router.refresh();
                })}><Trash2 className="size-3.5" /> Remove</Button>
              )}
            </div>
            <span className="w-full text-xs text-fg-subtle">PNG, JPEG or WebP, up to 5 MB.</span>
            <input
              ref={input}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              aria-label="Choose your photo"
              tabIndex={-1}
              onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) upload(f); }}
            />
          </div>
        ) : (
          <p className="text-fg-muted">Your login is not linked to an employee record in this workspace, so there is no profile photo to set.</p>
        )}
      </CardBody>
    </Card>
  );
}
