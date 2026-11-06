import { PageHeader } from '@crew/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/api';
import type { Course, LearningPath } from '../../talent/types';
import { CatalogueView } from './catalogue-view';

export const metadata: Metadata = { title: 'Course catalogue' };

export default async function CataloguePage() {
  const [courses, paths] = await Promise.all([load<Course[]>('/learning/courses?includeArchived=true'), load<LearningPath[]>('/learning/paths')]);
  return (
    <>
      <PageHeader eyebrow={<Link href="/learning" className="hover:underline">Learning</Link>} title="Course catalogue" description="Courses and learning paths everyone can see. Links must use https; SampCrew does not host course content." />
      <CatalogueView courses={courses} paths={paths} />
    </>
  );
}
