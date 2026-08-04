import { generateId } from '@/lib/id';

test('generateId prefixes and produces unique values', () => {
  const a = generateId('vac');
  const b = generateId('vac');
  expect(a).toMatch(/^vac_/);
  expect(a).not.toBe(b);
});
