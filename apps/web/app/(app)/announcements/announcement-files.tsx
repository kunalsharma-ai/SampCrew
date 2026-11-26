import { Download, Eye, Paperclip } from 'lucide-react';
import { cn } from '@crew/ui';
import type { AnnouncementFile } from '../helpdesk/types';

const size = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
/** Files a browser shows by itself (opened in a new tab); anything else is downloaded. */
const VIEWABLE = /\.(pdf|png|jpe?g|webp|gif|txt)$/i;

/**
 * An announcement's attachments, downloaded through a short signed link. Each file opens in a new tab when the
 * browser can show it (PDF, pictures, text) and always has its own download button (issue #89: the attachment
 * icons were not clickable). `compact` is the smaller row used on the announcements feed.
 */
export function AnnouncementFiles({ files, compact = false }: { files: AnnouncementFile[]; compact?: boolean }) {
  if (!files.length) return null;
  return (
    <ul className={cn('flex flex-wrap gap-2', compact && 'gap-1.5')} aria-label="Attachments" data-testid="announcement-files">
      {files.map((f) => {
        const viewable = VIEWABLE.test(f.name);
        return (
          <li key={f.id} className={cn('inline-flex items-center overflow-hidden rounded-md border border-border text-xs', compact && 'text-[0.6875rem]')}>
            <a
              href={viewable ? `${f.href}?view=1` : f.href}
              {...(viewable ? { target: '_blank', rel: 'noopener' } : { download: f.name })}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 hover:bg-bg-subtle hover:text-accent"
              title={viewable ? `Open ${f.name}` : `Download ${f.name}`}
              data-testid="announcement-file"
            >
              {viewable ? <Eye className="size-3.5" aria-hidden /> : <Paperclip className="size-3.5" aria-hidden />}
              <span className="max-w-56 truncate">{f.name}</span>
              <span className="text-fg-subtle">{size(f.size)}</span>
            </a>
            <a href={f.href} download={f.name} className="border-l border-border px-2 py-1 text-fg-subtle hover:bg-bg-subtle hover:text-accent" aria-label={`Download ${f.name}`} title="Download">
              <Download className="size-3.5" aria-hidden />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
