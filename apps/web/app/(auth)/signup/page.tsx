import type { Metadata } from 'next';
import { SignupForm } from './signup-form';

export const metadata: Metadata = { title: 'Create your workspace' };

export default function SignupPage() {
  return <SignupForm />;
}
