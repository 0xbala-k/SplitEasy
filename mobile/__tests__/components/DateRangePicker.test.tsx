import { useState } from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { DateRangePicker } from '@/components/DateRangePicker';
import {
  addMonths,
  formatDayLabelWithYear,
  formatMonthLabel,
  toLocalDateString,
  yearMonthOf,
} from '@/lib/date';

// Days are addressed by their real accessibility label rather than a
// hard-coded date, so the suite doesn't drift as the calendar month changes.
const thisMonth = yearMonthOf(null);
const dayLabel = (day: number) =>
  formatDayLabelWithYear(toLocalDateString(new Date(thisMonth.year, thisMonth.month, day)));
const dayValue = (day: number) => toLocalDateString(new Date(thisMonth.year, thisMonth.month, day));

function Harness({ onChange }: { onChange?: (s: string | null, e: string | null) => void } = {}) {
  const [range, setRange] = useState<{ start: string | null; end: string | null }>({
    start: null,
    end: null,
  });
  return (
    <DateRangePicker
      startDate={range.start}
      endDate={range.end}
      onChange={(start, end) => {
        setRange({ start, end });
        onChange?.(start, end);
      }}
    />
  );
}

function openCalendar() {
  fireEvent.press(screen.getByLabelText('Select dates'));
}

test('the calendar is collapsed until the trigger is tapped', () => {
  render(<Harness />);

  expect(screen.getByText('Any dates')).toBeTruthy();
  expect(screen.queryByLabelText(dayLabel(10))).toBeNull();

  openCalendar();

  expect(screen.getByLabelText(dayLabel(10))).toBeTruthy();
  expect(screen.getByText(formatMonthLabel(thisMonth))).toBeTruthy();
});

test('picking a start then an end emits the range and collapses the calendar', () => {
  const onChange = jest.fn();
  render(<Harness onChange={onChange} />);
  openCalendar();

  fireEvent.press(screen.getByLabelText(dayLabel(10)));
  expect(onChange).toHaveBeenLastCalledWith(dayValue(10), null);
  // Still open, prompting for the other half of the range.
  expect(screen.getByText('Now pick the end date')).toBeTruthy();

  fireEvent.press(screen.getByLabelText(dayLabel(17)));
  expect(onChange).toHaveBeenLastCalledWith(dayValue(10), dayValue(17));
  expect(screen.queryByLabelText(dayLabel(10))).toBeNull();
});

test('tapping before the pending start restarts the range instead of inverting it', () => {
  const onChange = jest.fn();
  render(<Harness onChange={onChange} />);
  openCalendar();

  fireEvent.press(screen.getByLabelText(dayLabel(17)));
  fireEvent.press(screen.getByLabelText(dayLabel(10)));

  // An end date before the start would break the `start_date <= end_date`
  // invariant the vacation reconciler depends on, so it becomes a new start.
  expect(onChange).toHaveBeenLastCalledWith(dayValue(10), null);
  expect(screen.getByText('Now pick the end date')).toBeTruthy();
});

test('a single-day trip is allowed', () => {
  const onChange = jest.fn();
  render(<Harness onChange={onChange} />);
  openCalendar();

  fireEvent.press(screen.getByLabelText(dayLabel(12)));
  fireEvent.press(screen.getByLabelText(dayLabel(12)));

  expect(onChange).toHaveBeenLastCalledWith(dayValue(12), dayValue(12));
});

test('the month arrows move the visible month without touching the selection', () => {
  render(<Harness />);
  openCalendar();

  fireEvent.press(screen.getByLabelText('Next month'));
  expect(screen.getByText(formatMonthLabel(addMonths(thisMonth, 1)))).toBeTruthy();

  fireEvent.press(screen.getByLabelText('Previous month'));
  fireEvent.press(screen.getByLabelText('Previous month'));
  expect(screen.getByText(formatMonthLabel(addMonths(thisMonth, -1)))).toBeTruthy();

  expect(screen.getByText('Tap a start and end date')).toBeTruthy();
});

test('clear resets a chosen range', () => {
  const onChange = jest.fn();
  render(<Harness onChange={onChange} />);
  openCalendar();

  fireEvent.press(screen.getByLabelText(dayLabel(10)));
  fireEvent.press(screen.getByLabelText(dayLabel(17)));
  expect(screen.queryByText('Any dates')).toBeNull();

  openCalendar();
  fireEvent.press(screen.getByLabelText('Clear dates'));

  expect(onChange).toHaveBeenLastCalledWith(null, null);
  expect(screen.getByText('Any dates')).toBeTruthy();
});

test('reopening returns to the month holding the selected range', () => {
  render(<Harness />);
  openCalendar();

  fireEvent.press(screen.getByLabelText(dayLabel(10)));
  fireEvent.press(screen.getByLabelText(dayLabel(17)));

  openCalendar();
  fireEvent.press(screen.getByLabelText('Next month'));
  fireEvent.press(screen.getByLabelText('Select dates')); // collapse
  openCalendar();

  // Browsing away and closing must not leave the calendar parked on an
  // unrelated month the next time it opens.
  expect(screen.getByText(formatMonthLabel(thisMonth))).toBeTruthy();
});
