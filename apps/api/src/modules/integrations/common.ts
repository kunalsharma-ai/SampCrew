/** Display name for a membership (employee name, else the login's full name). Needs m, u, e aliases. */
export const WHO = (u: string, e: string) => `coalesce(nullif(trim(coalesce(${e}.preferred_name, ${e}.first_name) || ' ' || ${e}.last_name), ''), ${u}.full_name)`;
export const BY = (col: string, alias: string) =>
  `left join memberships ${alias}m on ${alias}m.id = ${col} left join users ${alias}u on ${alias}u.id = ${alias}m.user_id left join employees ${alias}e on ${alias}e.id = ${alias}m.employee_id`;
