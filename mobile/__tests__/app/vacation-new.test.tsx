// mobile/__tests__/app/vacation-new.test.tsx
jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@/stores/vacationStore', () => ({ useVacationStore: jest.fn() }));
jest.mock('@/lib/splitwise', () => ({ getGroups: jest.fn() }));
jest.mock('@/components/ToastProvider', () => ({ useToast: () => ({ show: jest.fn() }) }));

import { render, fireEvent, screen, waitFor, act } from '@testing-library/react-native';
import NewVacationScreen from '@/app/vacation/new';
import { useVacationStore } from '@/stores/vacationStore';
import { getGroups } from '@/lib/splitwise';
import { SplitwiseGroup } from '@/lib/types';

const mockGetGroups = getGroups as jest.Mock;

const groups: SplitwiseGroup[] = [
  { id: '1', name: 'Hawaii Crew', member_ids: ['1', '2'], member_names: ['A', 'B'] },
  { id: '2', name: 'Roommates', member_ids: ['1', '3'], member_names: ['A', 'C'] },
];

beforeEach(() => {
  jest.clearAllMocks();
  (useVacationStore as unknown as jest.Mock).mockImplementation((sel) => sel({ create: jest.fn() }));
  mockGetGroups.mockResolvedValue(groups);
});

test('the group dropdown is collapsed by default and reveals options on tap', async () => {
  render(<NewVacationScreen />);
  await waitFor(() => expect(screen.getByLabelText('Select Splitwise group')).toBeTruthy());

  expect(screen.queryByLabelText('Hawaii Crew')).toBeNull();
  expect(screen.queryByLabelText('Roommates')).toBeNull();

  await act(async () => {
    fireEvent.press(screen.getByLabelText('Select Splitwise group'));
  });

  expect(screen.getByLabelText('Hawaii Crew')).toBeTruthy();
  expect(screen.getByLabelText('Roommates')).toBeTruthy();
});

test('selecting a group updates the trigger label and collapses the list', async () => {
  render(<NewVacationScreen />);
  await waitFor(() => expect(screen.getByLabelText('Select Splitwise group')).toBeTruthy());

  await act(async () => {
    fireEvent.press(screen.getByLabelText('Select Splitwise group'));
  });
  expect(screen.getByLabelText('None')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('Roommates'));

  expect(screen.getByText('Roommates')).toBeTruthy();
  expect(screen.queryByLabelText('Hawaii Crew')).toBeNull();
});
