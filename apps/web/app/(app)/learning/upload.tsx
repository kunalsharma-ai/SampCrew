'use client';
import { Button } from '@crew/ui';
import { Paperclip, Upload } from 'lucide-react';
import { useRef, useState } from 'react';

export interface UploadedFile { id: string; name: string; type: string; size: number }

/** Sends one file to the learning library through the web server (never straight to the API). */
export async function uploadLearningFile(file: File, purpose: 'content' | 'submission'): Promise<{ ok: true; data: UploadedFile } | { ok: false; message: string }> {
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await fetch(`/learning-upload?purpose=${purpose}`, { method: 'POST', body: form });
    const json = (await res.json().catch(() => ({ ok: false, message: 'The upload failed. Try again.' }))) as { ok: boolean; data?: UploadedFile; message?: string };
    return json.ok && json.data ? { ok: true, data: json.data } : { ok: false, message: json.message ?? 'The upload failed. Try again.' };
  } catch {
    return { ok: false, message: 'The upload did not finish. Check your connection and try again.' };
  }
}

export const sizeLabel = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** A button that picks a file and uploads it, showing progress and the error if it is refused. */
export function UploadButton({ purpose, accept, label, onUploaded, testId, variant = 'secondary' }: {
  purpose: 'content' | 'submission'; accept?: string; label: string; onUploaded: (f: UploadedFile) => void; testId?: string; variant?: 'secondary' | 'ghost' | 'primary';
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-grid gap-1">
      <input
        ref={input}
        type="file"
        className="sr-only"
        accept={accept}
        data-testid={testId}
        aria-label={label}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setBusy(true);
          setError(null);
          const r = await uploadLearningFile(f, purpose);
          setBusy(false);
          if (r.ok) onUploaded(r.data);
          else setError(r.message);
        }}
      />
      <Button type="button" size="sm" variant={variant} loading={busy} onClick={() => input.current?.click()}>
        {purpose === 'content' ? <Upload className="size-4" aria-hidden /> : <Paperclip className="size-4" aria-hidden />}
        {busy ? 'Uploading…' : label}
      </Button>
      {error && <span role="alert" className="text-xs text-danger">{error}</span>}
    </span>
  );
}

export const ACCEPT = {
  video: 'video/mp4,video/webm',
  audio: 'audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/webm',
  document: 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain',
  presentation: 'application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation',
  image: 'image/png,image/jpeg,image/webp',
  any: 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,image/png,image/jpeg,image/webp',
} as const;
