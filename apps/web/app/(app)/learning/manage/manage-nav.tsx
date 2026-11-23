'use client';
import { usePathname } from 'next/navigation';
import { SubNav } from '@/components/sub-nav';
import type { LearningAccessView } from '../types';

export function ManageNav({ access }: { access: LearningAccessView }) {
  const path = usePathname();
  const items = [
    { href: '/learning/manage', label: 'Dashboard' },
    { href: '/learning/manage/library', label: 'Learning library' },
    ...(access.caps.create ? [{ href: '/learning/manage/new', label: 'New module', testId: 'nav-new-module' }] : []),
    ...(access.caps.grade ? [{ href: '/learning/manage/reviews', label: 'Reviews' }] : []),
    ...(access.caps.reports ? [{ href: '/learning/manage/reports', label: 'Reports' }] : []),
    ...(access.level === 'super' ? [{ href: '/learning/manage/settings', label: 'Permissions & categories' }] : []),
  ];
  const current = items.filter((i) => path === i.href || path.startsWith(`${i.href}/`)).sort((a, b) => b.href.length - a.href.length)[0]?.href
    ?? (path.startsWith('/learning/manage/modules') ? '/learning/manage/library' : '/learning/manage');
  return <SubNav label="Learning management" items={items} current={current} />;
}
