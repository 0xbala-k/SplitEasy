// mobile/__tests__/lib/editLocks.test.ts
import { parseLocks, serializeLocks, addLocks, applyLocks, removeLocks } from '@/lib/editLocks';

describe('parseLocks', () => {
  test('returns [] for null, undefined and empty string', () => {
    expect(parseLocks(null)).toEqual([]);
    expect(parseLocks(undefined)).toEqual([]);
    expect(parseLocks('')).toEqual([]);
  });

  test('parses a JSON array string', () => {
    expect(parseLocks('["amount","date"]')).toEqual(['amount', 'date']);
  });

  test('passes an array through unchanged (web records store it parsed)', () => {
    expect(parseLocks(['amount'])).toEqual(['amount']);
  });

  test('returns [] for malformed JSON rather than throwing', () => {
    expect(parseLocks('{not json')).toEqual([]);
  });

  test('returns [] for valid JSON that is not an array', () => {
    expect(parseLocks('{"amount":true}')).toEqual([]);
  });

  test('drops non-string entries', () => {
    expect(parseLocks('["amount",3,null]')).toEqual(['amount']);
  });
});

describe('serializeLocks', () => {
  test('returns null for an empty list, so the column stays NULL', () => {
    expect(serializeLocks([])).toBeNull();
  });

  test('dedupes and sorts for a stable stored representation', () => {
    expect(serializeLocks(['date', 'amount', 'amount'])).toBe('["amount","date"]');
  });
});

describe('addLocks', () => {
  test('unions new fields onto existing locks', () => {
    expect(addLocks('["amount"]', ['date'])).toBe('["amount","date"]');
  });

  test('adding an already-locked field is idempotent', () => {
    expect(addLocks('["amount"]', ['amount'])).toBe('["amount"]');
  });

  test('starts from nothing when the column is NULL', () => {
    expect(addLocks(null, ['merchant_name'])).toBe('["merchant_name"]');
  });
});

describe('applyLocks', () => {
  const incoming = { merchant_name: 'Cafe', amount: 20, date: '2026-07-01' };

  test('passes every field through when nothing is locked', () => {
    expect(applyLocks(incoming, null)).toEqual(incoming);
  });

  test('drops only the locked field, leaving siblings writable', () => {
    expect(applyLocks(incoming, '["amount"]')).toEqual({
      merchant_name: 'Cafe',
      date: '2026-07-01',
    });
  });

  test('drops every field when all are locked', () => {
    expect(applyLocks(incoming, '["merchant_name","amount","date"]')).toEqual({});
  });

  test('ignores locks naming a field this write does not carry', () => {
    expect(applyLocks({ amount: 20 }, '["merchant_name"]')).toEqual({ amount: 20 });
  });

  test('does not mutate its input', () => {
    const copy = { ...incoming };
    applyLocks(incoming, '["amount"]');
    expect(incoming).toEqual(copy);
  });
});

describe('removeLocks', () => {
  test('drops the named field, leaving other locks alone', () => {
    expect(removeLocks('["amount","merchant_name"]', ['amount'])).toBe('["merchant_name"]');
  });

  test('returns null when the last lock is removed', () => {
    expect(removeLocks('["amount"]', ['amount'])).toBeNull();
  });

  test('is a no-op when the field was never locked', () => {
    expect(removeLocks('["merchant_name"]', ['amount'])).toBe('["merchant_name"]');
  });

  test('returns null for a NULL column', () => {
    expect(removeLocks(null, ['amount'])).toBeNull();
  });

  test('accepts the web array representation', () => {
    expect(removeLocks(['amount', 'date'], ['amount'])).toBe('["date"]');
  });
});
