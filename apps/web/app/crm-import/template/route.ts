import { crmDownload } from '@/lib/crm-download';

/** The sample spreadsheet for Candidate CRM imports, with the organisation's import custom fields as columns. */
export async function GET() {
  return crmDownload('/import-template.xlsx', 'The template is not available');
}
