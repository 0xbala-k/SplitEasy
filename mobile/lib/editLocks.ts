// mobile/lib/editLocks.ts
//
// The per-field edit lock rule, kept as pure functions with no DB dependency.
//
// This exists as its own module because db.ts (SQLite) and db.web.ts
// (IndexedDB) are separate implementations that must agree, and because the
// native test suite mocks expo-sqlite and can only assert on generated SQL —
// it cannot prove behaviour. Testing the rule here is the one place it is
// verified directly for both backends.

/** Reads a stored lock list. Native stores JSON text; web stores an array. */
export function parseLocks(raw: string | string[] | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((f): f is string => typeof f === 'string');
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f): f is string => typeof f === 'string');
  } catch {
    // A corrupt column must not break a sync. Treating it as "nothing locked"
    // loses the user's locks but keeps the app syncing; throwing here would
    // wedge every future refresh.
    return [];
  }
}

/** Null (not "[]") for an empty list, so an untouched row keeps a NULL column. */
export function serializeLocks(fields: string[]): string | null {
  if (fields.length === 0) return null;
  return JSON.stringify([...new Set(fields)].sort());
}

export function addLocks(
  raw: string | string[] | null | undefined,
  fields: string[]
): string | null {
  return serializeLocks([...parseLocks(raw), ...fields]);
}

/**
 * Drop fields from a stored lock list, leaving every other lock alone.
 *
 * Used when a lock has outlived what it was protecting — e.g. deleting a
 * split must drop its `amount` lock, since the row is going back to 'new'
 * and needs to track the bank's amount again.
 */
export function removeLocks(
  raw: string | string[] | null | undefined,
  fields: string[]
): string | null {
  const drop = new Set(fields);
  return serializeLocks(parseLocks(raw).filter((f) => !drop.has(f)));
}

/**
 * Strip every key the user has locked from an upstream write.
 *
 * Returns only the keys the caller may still write, so a caller builds its
 * SET clause from the result's own keys rather than deciding per field.
 */
export function applyLocks<T extends Record<string, unknown>>(
  incoming: T,
  raw: string | string[] | null | undefined
): Partial<T> {
  const locked = new Set(parseLocks(raw));
  const out: Partial<T> = {};
  for (const key of Object.keys(incoming) as (keyof T & string)[]) {
    if (!locked.has(key)) out[key] = incoming[key];
  }
  return out;
}
