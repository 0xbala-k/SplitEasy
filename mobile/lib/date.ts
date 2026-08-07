// mobile/lib/date.ts
//
// Calendar dates vs. instants — the app deals in both, and they need opposite
// treatment:
//
//   * A *calendar date* ("YYYY-MM-DD": Transaction.date, Vacation.start_date /
//     end_date) names a day on the user's wall calendar. It has no time and no
//     zone, and must always be produced and read back in the device's local
//     time. `new Date("2026-08-06")` does NOT do that: ECMA-262 parses the
//     date-only form as UTC midnight, so in any zone west of UTC it renders as
//     the previous day. Likewise `new Date().toISOString().slice(0, 10)` yields
//     the UTC date, which in PDT flips over at 5pm local. Use the helpers here
//     instead of either.
//
//   * An *instant* (created_at, started_at, ended_at) is a moment in time, and
//     stays stored as a UTC ISO-8601 string. That keeps it unambiguous and
//     keeps lexicographic string comparison equal to chronological order, which
//     `pruneOldTransactions` relies on. Convert to local only when displaying.

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, '0');

/** The calendar date of `d` in the device's local time, as "YYYY-MM-DD". */
export function toLocalDateString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today's calendar date on the device, as "YYYY-MM-DD". */
export function todayLocal(): string {
  return toLocalDateString(new Date());
}

/**
 * Parse a stored date for display. A bare "YYYY-MM-DD" becomes local midnight
 * of that same day (never shifted by the zone offset); anything else is an
 * instant and is parsed as-is, since `Date` already renders those in local
 * time.
 */
export function parseLocalDate(value: string): Date {
  const match = DATE_ONLY_RE.test(value);
  if (!match) return new Date(value);
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Short "Aug 6"-style label for a stored date, in the device's local time.
 * The locale stays pinned to en-US to match the rest of the app's copy; only
 * the zone handling is what changed here.
 */
export function formatDayLabel(value: string): string {
  return parseLocalDate(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}
