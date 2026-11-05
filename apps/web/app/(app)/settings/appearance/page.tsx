import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import { ThemeStudio } from './theme-studio';

export const metadata: Metadata = { title: 'Appearance' };

export default function AppearancePage() {
  return (
    <>
      <PageHeader eyebrow="Theme Studio" title="Appearance" description="Choose how CREW looks and moves for you. Changes apply straight away and follow you to every device you sign in on." />
      <ThemeStudio />
    </>
  );
}
