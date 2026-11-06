/** The address of an employee's photo, or null when they have none. The version makes a new photo show at once. */
export function photoUrl(e: { id: string; photoUpdatedAt?: string | null }): string | null {
  return e.photoUpdatedAt ? `/employee-photos/${e.id}?v=${encodeURIComponent(new Date(e.photoUpdatedAt).getTime())}` : null;
}
