// mobile/stores/vacationStore.ts
import { create } from 'zustand';
import {
  getVacations,
  createVacation,
  startVacation as dbStartVacation,
  endVacation as dbEndVacation,
  deleteVacation as dbDeleteVacation,
  reconcileVacationStatuses,
} from '@/lib/db';
import { Vacation, CreateVacationInput } from '@/lib/types';

interface VacationState {
  vacations: Vacation[];
  activeVacation: Vacation | null;
  isLoading: boolean;
  load: () => Promise<void>;
  reconcile: () => Promise<void>;
  create: (input: CreateVacationInput) => Promise<Vacation>;
  startVacation: (id: string) => Promise<void>;
  endVacation: (id: string) => Promise<void>;
  deleteVacation: (id: string) => Promise<void>;
}

export const useVacationStore = create<VacationState>((set, get) => ({
  vacations: [],
  activeVacation: null,
  isLoading: false,

  load: async () => {
    set({ isLoading: true });
    const vacations = await getVacations();
    const activeVacation = vacations.find((v) => v.status === 'active') ?? null;
    set({ vacations, activeVacation, isLoading: false });
  },

  reconcile: async () => {
    await reconcileVacationStatuses();
    await get().load();
  },

  create: async (input) => {
    const vacation = await createVacation(input);
    // Reconcile (not just reload) so a vacation whose start_date is today
    // activates immediately, per spec — see reconcile()'s comment.
    await get().reconcile();
    return vacation;
  },

  startVacation: async (id) => {
    await dbStartVacation(id);
    await get().load();
  },

  endVacation: async (id) => {
    await dbEndVacation(id);
    await get().load();
  },

  deleteVacation: async (id) => {
    await dbDeleteVacation(id);
    await get().load();
  },
}));
