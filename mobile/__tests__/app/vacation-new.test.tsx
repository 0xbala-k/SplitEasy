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
import { formatDayLabelWithYear, toLocalDateString, yearMonthOf } from '@/lib/date';
import { SplitwiseGroup } from '@/lib/types';

const mockGetGroups = getGroups as jest.Mock;
const mockCreate = jest.fn();

// Addressed by real label rather than a fixed date so the suite doesn't drift
// as the calendar month changes.
const thisMonth = yearMonthOf(null);
const dayOf = (day: number) => toLocalDateString(new Date(thisMonth.year, thisMonth.month, day));
const dayLabel = (day: number) => formatDayLabelWithYear(dayOf(day));

const groups: SplitwiseGroup[] = [
  { id: '1', name: 'Hawaii Crew', member_ids: ['1', '2'], member_names: ['A', 'B'] },
  { id: '2', name: 'Roommates', member_ids: ['1', '3'], member_names: ['A', 'C'] },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({ id: 'vac_1' });
  (useVacationStore as unknown as jest.Mock).mockImplementation((sel) => sel({ create: mockCreate }));
  mockGetGroups.mockResolvedValue(groups);
});

async function renderScreen() {
  render(<NewVacationScreen />);
  await waitFor(() => expect(screen.getByLabelText('Select dates')).toBeTruthy());
}

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

test('a range picked on the calendar is saved as the vacation dates', async () => {
  await renderScreen();

  fireEvent.changeText(screen.getByLabelText('Vacation name'), 'Hawaii');
  fireEvent.press(screen.getByLabelText('Select dates'));
  fireEvent.press(screen.getByLabelText(dayLabel(10)));
  fireEvent.press(screen.getByLabelText(dayLabel(17)));

  await act(async () => {
    fireEvent.press(screen.getByLabelText('Save vacation'));
  });

  expect(mockCreate).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'Hawaii', start_date: dayOf(10), end_date: dayOf(17) })
  );
});

test('a vacation with no dates saves them as null', async () => {
  await renderScreen();

  fireEvent.changeText(screen.getByLabelText('Vacation name'), 'Manual');
  await act(async () => {
    fireEvent.press(screen.getByLabelText('Save vacation'));
  });

  expect(mockCreate).toHaveBeenCalledWith(
    expect.objectContaining({ start_date: null, end_date: null })
  );
});

test('a half-picked range blocks saving until the end date is chosen', async () => {
  await renderScreen();

  fireEvent.changeText(screen.getByLabelText('Vacation name'), 'Hawaii');
  fireEvent.press(screen.getByLabelText('Select dates'));
  fireEvent.press(screen.getByLabelText(dayLabel(10)));

  await act(async () => {
    fireEvent.press(screen.getByLabelText('Save vacation'));
  });
  // Saving now would persist a start with no end, which the reconciler would
  // treat as an open-ended vacation the user never asked for.
  expect(mockCreate).not.toHaveBeenCalled();
  expect(screen.getByText('Pick an end date to finish the range.')).toBeTruthy();

  fireEvent.press(screen.getByLabelText(dayLabel(17)));
  await act(async () => {
    fireEvent.press(screen.getByLabelText('Save vacation'));
  });
  expect(mockCreate).toHaveBeenCalledTimes(1);
});
