/** A date or timestamp as a short day, such as 26 Nov 2026. Safe to use on the server and in the browser. */
export const fmtDay = (d: string | null | undefined) => (d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
