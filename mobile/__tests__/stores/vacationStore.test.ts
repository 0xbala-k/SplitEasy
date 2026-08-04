jest.mock('@/lib/db');

import * as db from '@/lib/db';
import { useVacationStore } from '@/stores/vacationStore';
import { Vacation } from '@/lib/types';

const mockGetVacations = db.getVacations as jest.Mock;
const mockCreateVacation = db.createVacation as jest.Mock;
const mockStart = db.startVacation as jest.Mock;
const mockEnd = db.endVacation as jest.Mock;
const mockDelete = db.deleteVacation as jest.Mock;
const mockReconcile = db.reconcileVacationStatuses as jest.Mock;

function vac(over: Partial<Vacation> = {}): Vacation {
  return {
    id: 'v1', name: 'Hawaii', start_date: null, end_date: null, status: 'draft',
    splitwise_group_id: null, splitwise_group_name: null, splitwise_group_member_ids: null,
    created_at: 'x', started_at: null, ended_at: null, ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useVacationStore.setState({ vacations: [], activeVacation: null, isLoading: false });
  mockGetVacations.mockResolvedValue([]);
  mockCreateVacation.mockResolvedValue(vac());
  mockStart.mockResolvedValue(undefined);
  mockEnd.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
  mockReconcile.mockResolvedValue(undefined);
});

test('load fetches vacations and derives the active one', async () => {
  mockGetVacations.mockResolvedValue([vac({ id: 'v1', status: 'active' }), vac({ id: 'v2', status: 'ended' })]);
  await useVacationStore.getState().load();
  const state = useVacationStore.getState();
  expect(state.vacations).toHaveLength(2);
  expect(state.activeVacation?.id).toBe('v1');
});

test('load with no active vacation leaves activeVacation null', async () => {
  mockGetVacations.mockResolvedValue([vac({ status: 'ended' })]);
  await useVacationStore.getState().load();
  expect(useVacationStore.getState().activeVacation).toBeNull();
});

test('reconcile calls db.reconcileVacationStatuses then reloads', async () => {
  mockGetVacations.mockResolvedValue([vac({ status: 'active' })]);
  await useVacationStore.getState().reconcile();
  expect(mockReconcile).toHaveBeenCalledTimes(1);
  expect(useVacationStore.getState().activeVacation?.status).toBe('active');
});

test('create calls db.createVacation, reconciles, and returns the new vacation', async () => {
  const created = vac({ id: 'new1', name: 'Ski' });
  mockCreateVacation.mockResolvedValue(created);
  mockGetVacations.mockResolvedValue([created]);
  const result = await useVacationStore.getState().create({ name: 'Ski' });
  expect(mockCreateVacation).toHaveBeenCalledWith({ name: 'Ski' });
  // Reconciling (not a plain reload) matters here: a vacation whose
  // start_date is today must activate immediately on creation, not wait for
  // the next sync/foreground reconcile.
  expect(mockReconcile).toHaveBeenCalledTimes(1);
  expect(result).toEqual(created);
  expect(useVacationStore.getState().vacations).toEqual([created]);
});

test('startVacation calls db.startVacation and reloads', async () => {
  mockGetVacations.mockResolvedValue([vac({ status: 'active' })]);
  await useVacationStore.getState().startVacation('v1');
  expect(mockStart).toHaveBeenCalledWith('v1');
  expect(useVacationStore.getState().activeVacation?.id).toBe('v1');
});

test('startVacation propagates a conflict error without reloading', async () => {
  mockStart.mockRejectedValue(new Error('already_active'));
  await expect(useVacationStore.getState().startVacation('v1')).rejects.toThrow();
  expect(mockGetVacations).not.toHaveBeenCalled();
});

test('endVacation calls db.endVacation and reloads', async () => {
  await useVacationStore.getState().endVacation('v1');
  expect(mockEnd).toHaveBeenCalledWith('v1');
  expect(mockGetVacations).toHaveBeenCalled();
});

test('deleteVacation calls db.deleteVacation and reloads', async () => {
  await useVacationStore.getState().deleteVacation('v1');
  expect(mockDelete).toHaveBeenCalledWith('v1');
  expect(mockGetVacations).toHaveBeenCalled();
});
