import { redirect } from 'next/navigation';

/** The Add Employee form is set up in Settings > Form management now (issue #91). */
export default function EmployeeFormPage() {
  redirect('/settings/forms?form=add_employee');
}
