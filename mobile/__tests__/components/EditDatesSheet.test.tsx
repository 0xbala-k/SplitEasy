// The library's own mock renders `children` only and drops `footerComponent`,
// so the pinned CTA would never appear in the tree. Extend it, as
// AddToVacationSheet's suite does.
jest.mock('@gorhom/bottom-sheet', () => {
  const React = require('react');
  const actual = require('@gorhom/bottom-sheet/mock');
  class BottomSheetModal extends actual.BottomSheetModal {
    render() {
      const content = super.render();
      const Footer = this.props.footerComponent;
      if (!Footer) return content;
      return React.createElement(
        React.Fragment,
        null,
        content,
        React.createElement(Footer, { animatedFooterPosition: { value: 0 } })
      );
    }
  }
  return {
    ...actual,
    BottomSheetModal,
    BottomSheetFooter: ({ children }: { children: React.ReactNode }) => children,
  };
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { EditDatesSheet } from '@/components/EditDatesSheet';
import { formatDayLabelWithYear, toLocalDateString, yearMonthOf } from '@/lib/date';

const thisMonth = yearMonthOf(null);
const dayOf = (day: number) => toLocalDateString(new Date(thisMonth.year, thisMonth.month, day));
const dayLabel = (day: number) => formatDayLabelWithYear(dayOf(day));

const saved = { start: dayOf(3), end: dayOf(6) };

function renderSheet(onSave = jest.fn().mockResolvedValue(undefined), openToken = 1) {
  render(
    <EditDatesSheet
      startDate={saved.start}
      endDate={saved.end}
      openToken={openToken}
      onSave={onSave}
    />
  );
  return onSave;
}

test('the CTA renders and starts disabled, since nothing has changed yet', () => {
  renderSheet();
  // Regression guard: a footer-rendered CTA is invisible if the sheet ever
  // goes back to wrapping content in BottomSheetView.
  const cta = screen.getByLabelText('Save dates');
  expect(cta).toBeTruthy();
  expect(cta.props.accessibilityState?.disabled).toBe(true);
});

test('editing the range enables the CTA and saves the new dates', async () => {
  const onSave = renderSheet();

  fireEvent.press(screen.getByLabelText(dayLabel(10)));
  fireEvent.press(screen.getByLabelText(dayLabel(17)));
  fireEvent.press(screen.getByLabelText('Save dates'));

  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave).toHaveBeenCalledWith(dayOf(10), dayOf(17));
});

test('a half-picked range leaves the CTA disabled', () => {
  const onSave = renderSheet();

  fireEvent.press(screen.getByLabelText(dayLabel(10)));
  fireEvent.press(screen.getByLabelText('Save dates'));

  // Saving a start with no end would read as an open-ended vacation.
  expect(onSave).not.toHaveBeenCalled();
  expect(screen.getByText('Now pick the end date')).toBeTruthy();
});

test('clearing the dates is savable and reports both as null', async () => {
  const onSave = renderSheet();

  fireEvent.press(screen.getByLabelText('Clear dates'));
  fireEvent.press(screen.getByLabelText('Save dates'));

  await waitFor(() => expect(onSave).toHaveBeenCalledWith(null, null));
});

test('the draft reseeds from the saved dates each time the sheet opens', () => {
  const onSave = jest.fn().mockResolvedValue(undefined);
  const { rerender } = render(
    <EditDatesSheet startDate={saved.start} endDate={saved.end} openToken={1} onSave={onSave} />
  );

  fireEvent.press(screen.getByLabelText(dayLabel(20)));
  expect(screen.getByText('Now pick the end date')).toBeTruthy();

  // Reopening must discard the abandoned edit rather than resume it.
  rerender(
    <EditDatesSheet startDate={saved.start} endDate={saved.end} openToken={2} onSave={onSave} />
  );

  expect(screen.getByText('Tap a start and end date')).toBeTruthy();
  expect(screen.getByLabelText('Save dates').props.accessibilityState?.disabled).toBe(true);
});

test('clearing after an edit saves the cleared dates, not the abandoned range', async () => {
  const onSave = renderSheet();

  // The footer is memoized on `disabled`, and this is the one sequence where
  // the draft changes while `disabled` does not: picking a range enables the
  // CTA, and clearing leaves it enabled (empty still differs from saved). The
  // footer is therefore never recreated, so a handler captured in its closure
  // would still be holding the range that was just discarded.
  fireEvent.press(screen.getByLabelText(dayLabel(10)));
  fireEvent.press(screen.getByLabelText(dayLabel(17)));
  fireEvent.press(screen.getByLabelText('Clear dates'));
  fireEvent.press(screen.getByLabelText('Save dates'));

  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave).toHaveBeenCalledWith(null, null);
});
