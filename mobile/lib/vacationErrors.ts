// mobile/lib/vacationErrors.ts
export class VacationConflictError extends Error {
  reason: 'overlap' | 'already_active';

  constructor(reason: 'overlap' | 'already_active', message: string) {
    super(message);
    this.name = 'VacationConflictError';
    this.reason = reason;
  }
}

/**
 * Thrown when something tries to re-tag a transaction that belongs to a
 * vacation. A trip's spend is Travel by definition; the way out is to remove
 * the transaction from the trip, not to relabel it.
 */
export class BucketLockedError extends Error {
  constructor(message = 'This transaction is part of a vacation, so it counts as Travel.') {
    super(message);
    this.name = 'BucketLockedError';
  }
}
