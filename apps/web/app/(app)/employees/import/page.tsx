import { redirect } from 'next/navigation';

/** The employee import moved into Data import, which also brings candidates, clients, departments and lists in. */
export default function OldImportPage() {
  redirect('/imports/new?type=employees');
}
