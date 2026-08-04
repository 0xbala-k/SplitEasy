// mobile/lib/vacationErrors.ts
export class VacationConflictError extends Error {
  reason: 'overlap' | 'already_active';

  constructor(reason: 'overlap' | 'already_active', message: string) {
    super(message);
    this.name = 'VacationConflictError';
    this.reason = reason;
  }
}
