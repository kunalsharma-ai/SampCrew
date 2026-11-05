'use client';
import { Button } from '@crew/ui';
import { Printer } from 'lucide-react';

export function PrintButton() {
  return <Button size="sm" variant="secondary" onClick={() => window.print()}><Printer className="size-3.5" /> Print or save as PDF</Button>;
}
