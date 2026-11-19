import { Paperclip } from 'lucide-react';
import type { AnnouncementFile } from '../helpdesk/types';

const size = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** An announcement's attachments, downloaded through a short signed link. */
export function AnnouncementFiles({ files }: { files: AnnouncementFile[] }) {
  if (!files.length) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Attachments" data-testid="announcement-files">
      {files.map((f) => (
        <li key={f.id}>
          <a href={f.href} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-bg-subtle" download>
            <Paperclip className="size-3.5" aria-hidden />{f.name}<span className="text-fg-subtle">{size(f.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
