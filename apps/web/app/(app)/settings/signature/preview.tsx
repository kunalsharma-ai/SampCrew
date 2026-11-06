import { renderSignature, type SignatureData, type SignatureTemplateKey } from '@crew/contracts';

/**
 * A signature exactly as Outlook will show it. The markup comes from the shared renderer, which escapes everything
 * people type and keeps only safe links and image addresses. Emails are white, so the preview is too, in any theme.
 */
export function SignaturePreview({ template, data, label, className }: { template: SignatureTemplateKey; data: SignatureData; label: string; className?: string }) {
  const { body } = renderSignature(template, data);
  return <div role="img" aria-label={label} className={`overflow-hidden rounded-lg border border-border bg-white p-4 text-left text-black ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: body }} />;
}
