jest.mock('@/stores/vacationStore', () => ({ useVacationStore: jest.fn() }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (cb: () => void) => cb(),
}));
jest.mock('@expo/vector-icons', () => new Proxy({}, { get: () => () => null }));

const mockPush = jest.fn();

import { render, fireEvent, screen } from '@testing-library/react-native';
import { VacationBanner } from '@/components/VacationBanner';
import { useVacationStore } from '@/stores/vacationStore';
import { Vacation } from '@/lib/types';

function vac(over: Partial<Vacation> = {}): Vacation {
  return {
    id: 'v1', name: 'Hawaii', start_date: null, end_date: null, status: 'draft',
    splitwise_group_id: null, splitwise_group_name: null, splitwise_group_member_ids: null,
    created_at: 'x', started_at: null, ended_at: null, ...over,
  };
}

const mockLoad = jest.fn();

function mockStore(state: { vacations: Vacation[]; activeVacation: Vacation | null }) {
  (useVacationStore as unknown as jest.Mock).mockImplementation((sel) => sel({ ...state, load: mockLoad }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('shows a create CTA when there are no vacations at all', () => {
  mockStore({ vacations: [], activeVacation: null });
  render(<VacationBanner />);
  fireEvent.press(screen.getByLabelText('Create a vacation'));
  expect(mockPush).toHaveBeenCalledWith('/vacation');
});

test('shows the in-progress vacation and jumps straight to its detail screen', () => {
  const v = vac({ id: 'v1', status: 'active', name: 'Hawaii' });
  mockStore({ vacations: [v], activeVacation: v });
  render(<VacationBanner />);
  expect(screen.getByText('Hawaii')).toBeTruthy();
  expect(screen.getByText('Active vacation')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Open Hawaii vacation'));
  expect(mockPush).toHaveBeenCalledWith('/vacation/v1');
});

test('shows the date range instead of the status line when the vacation has dates', () => {
  const v = vac({ id: 'v1', status: 'active', name: 'Hawaii', start_date: '2026-08-01', end_date: '2026-08-10' });
  mockStore({ vacations: [v], activeVacation: v });
  render(<VacationBanner />);
  expect(screen.getByText('2026-08-01 – 2026-08-10')).toBeTruthy();
});

test('shows a compact link when only ended vacations exist', () => {
  mockStore({ vacations: [vac({ status: 'ended' })], activeVacation: null });
  render(<VacationBanner />);
  fireEvent.press(screen.getByLabelText('View vacations'));
  expect(mockPush).toHaveBeenCalledWith('/vacation');
});
