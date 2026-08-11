// Manual mock for lib/worker — keeps WorkerError as a real class
// so instanceof checks and .code property access work in tests.
const actual = jest.requireActual('../worker');

export const WorkerError = actual.WorkerError;
export const getLinkToken = jest.fn();
export const exchangePublicToken = jest.fn();
export const fetchTransactions = jest.fn();
export const exchangeSplitwiseCode = jest.fn();
export const parseReceipt = jest.fn();
