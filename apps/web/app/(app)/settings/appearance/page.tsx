import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { MyPhoto } from '@/components/my-photo';
import { load } from '@/lib/api';
import type { Me } from '@/lib/types';
import { ThemeStudio } from './theme-studio';

export const metadata: Metadata = { title: 'Appearance' };

export default async function AppearancePage() {
  const me = await load<Me>('/me');
  return (
    <>
      <PageHeader eyebrow="Theme Studio" title="Appearance" description="Your photo, and how CREW looks and moves for you. Changes apply straight away and follow you to every device you sign in on." />
      <MyPhoto employee={me.employee} name={me.user.fullName} />
      <ThemeStudio />
    </>
  );
}
