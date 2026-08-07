import { formatDayLabel, parseLocalDate, toLocalDateString, todayLocal } from '@/lib/date';

// These assertions hold in every timezone, which is the point: a calendar date
// must survive storage and display unchanged no matter where the device is.
// The old `new Date(str)` / `toISOString()` implementations satisfied them only
// at UTC+0 or east of it.
describe('calendar dates are handled in the device timezone', () => {
  test('a stored date renders as that same day, not the UTC-shifted one', () => {
    expect(formatDayLabel('2026-08-06')).toBe('Aug 6');
    expect(formatDayLabel('2026-01-01')).toBe('Jan 1');
    // New Year's Day is the sharpest case: parsed as UTC midnight it renders as
    // Dec 31 of the previous year anywhere west of UTC.
    expect(formatDayLabel('2026-12-31')).toBe('Dec 31');
  });

  test('parseLocalDate lands on local midnight of the named day', () => {
    const d = parseLocalDate('2026-08-06');
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 7, 6]);
    expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
  });

  test('a full instant still renders in local time', () => {
    // Not a bare date, so it is a real moment and Date already localises it.
    const iso = '2026-08-06T12:00:00.000Z';
    expect(parseLocalDate(iso).getTime()).toBe(Date.parse(iso));
  });

  test('date strings round-trip unchanged', () => {
    for (const s of ['2026-01-01', '2026-06-15', '2026-12-31']) {
      expect(toLocalDateString(parseLocalDate(s))).toBe(s);
    }
  });

  test('todayLocal is the device calendar date, not the UTC one', () => {
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}`;
    expect(todayLocal()).toBe(expected);
  });

  test('todayLocal tracks the device clock across the local midnight boundary', () => {
    // 11:30pm local on Aug 6 is already Aug 7 in UTC for any western zone. The
    // vacation reconciler keys off this value, so getting it wrong starts and
    // ends trips on the wrong day.
    jest.useFakeTimers().setSystemTime(new Date(2026, 7, 6, 23, 30));
    expect(todayLocal()).toBe('2026-08-06');
    jest.setSystemTime(new Date(2026, 7, 7, 0, 30));
    expect(todayLocal()).toBe('2026-08-07');
    jest.useRealTimers();
  });
});
