import { streamExport } from '@/lib/download';

/** The import template for existing employees, with a column per leave type in this workspace. */
export async function GET() {
  return streamExport('/employees/import/template.xlsx');
}
