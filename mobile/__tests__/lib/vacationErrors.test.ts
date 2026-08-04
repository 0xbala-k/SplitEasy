import { VacationConflictError } from '@/lib/vacationErrors';

test('carries a reason and is catchable via instanceof', () => {
  const err = new VacationConflictError('overlap', 'dates overlap an existing vacation');
  expect(err).toBeInstanceOf(Error);
  expect(err).toBeInstanceOf(VacationConflictError);
  expect(err.reason).toBe('overlap');
  expect(err.message).toBe('dates overlap an existing vacation');
});
