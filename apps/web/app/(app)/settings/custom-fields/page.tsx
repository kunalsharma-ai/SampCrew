import { CUSTOM_FIELD_ENTITIES, FORM_OF_ENTITY, type CustomFieldEntity } from '@crew/contracts';
import { redirect } from 'next/navigation';


/**
 * Custom fields moved into Settings > Form management (issue #91): one place for every form, its built-in fields and
 * its custom fields. Old links (the "Extra fields" link, bookmarks) open the matching form there.
 */
export default async function CustomFieldsPage({ searchParams }: { searchParams: Promise<{ entity?: string }> }) {
  const { entity } = await searchParams;
  const e = (CUSTOM_FIELD_ENTITIES as readonly string[]).includes(entity ?? '') ? (entity as CustomFieldEntity) : 'employee';
  redirect(`/settings/forms?form=${FORM_OF_ENTITY[e]}`);
}
