// mobile/__tests__/lib/db.parity.test.ts
// Metro resolves `@/lib/db` to db.web.ts on web, so any function db.ts exports
// but db.web.ts doesn't is `undefined` at runtime in the PWA — it throws only
// when the feature is used, after side effects (e.g. a created Splitwise
// expense) have already happened. Fail at test time instead.
jest.mock('expo-sqlite');

import * as native from '@/lib/db';
import * as web from '@/lib/db.web';

test('db.web implements every function db.ts exports', () => {
  const missing = Object.keys(native).filter(
    (name) => typeof (web as Record<string, unknown>)[name] !== 'function'
  );
  expect(missing).toEqual([]);
});
