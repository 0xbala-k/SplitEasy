// Manual mock for @/lib/worker — keeps WorkerError as a real class
// so instanceof checks and property access work in tests.
const actual = jest.requireActual('@/lib/worker');

export const WorkerError = actual.WorkerError;
export const getLinkToken = jest.fn();
export const exchangePublicToken = jest.fn();
export const fetchTransactions = jest.fn();
export const exchangeSplitwiseCode = jest.fn();
