import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import SpendingDonut, { computeSlices } from '@/components/SpendingDonut';

describe('computeSlices', () => {
  it('turns cents into angles covering the full circle', () => {
    const slices = computeSlices([
      { key: 'a', label: 'A', cents: 250, color: '#000' },
      { key: 'b', label: 'B', cents: 250, color: '#111' },
    ]);
    expect(slices[0].startAngle).toBe(0);
    expect(slices[0].endAngle).toBeCloseTo(180);
    expect(slices[1].endAngle).toBeCloseTo(360);
    expect(slices[0].fraction).toBeCloseTo(0.5);
  });

  it('drops zero-value slices so they cannot render a hairline', () => {
    const slices = computeSlices([
      { key: 'a', label: 'A', cents: 100, color: '#000' },
      { key: 'b', label: 'B', cents: 0, color: '#111' },
    ]);
    expect(slices.map((s) => s.key)).toEqual(['a']);
    expect(slices[0].fraction).toBe(1);
  });

  it('returns an empty list when everything is zero', () => {
    expect(computeSlices([{ key: 'a', label: 'A', cents: 0, color: '#000' }])).toEqual([]);
  });

  it('emits a path for every slice', () => {
    const slices = computeSlices([
      { key: 'a', label: 'A', cents: 1, color: '#000' },
      { key: 'b', label: 'B', cents: 2, color: '#111' },
    ]);
    for (const s of slices) expect(s.path).toMatch(/^M /);
  });
});

describe('SpendingDonut', () => {
  const slices = [
    { key: 'needs', label: 'Needs', cents: 6000, color: '#2563EB' },
    { key: 'wants', label: 'Wants', cents: 4000, color: '#F59E0B' },
  ];

  it('renders the center label and caption', () => {
    render(<SpendingDonut slices={slices} centerLabel="$100.00" centerCaption="August 2026" />);
    expect(screen.getByText('$100.00')).toBeTruthy();
    expect(screen.getByText('August 2026')).toBeTruthy();
  });

  it('calls onSlicePress with the slice key', () => {
    const onSlicePress = jest.fn();
    render(
      <SpendingDonut slices={slices} centerLabel="$100.00" centerCaption="August" onSlicePress={onSlicePress} />
    );
    fireEvent.press(screen.getByLabelText('Needs, 60% of spending'));
    expect(onSlicePress).toHaveBeenCalledWith('needs');
  });

  it('renders an empty state when there is no spending', () => {
    render(<SpendingDonut slices={[]} centerLabel="$0.00" centerCaption="August 2026" />);
    expect(screen.getByLabelText('No spending this month')).toBeTruthy();
  });

  it('floors a slice that rounds to 0% instead of announcing 0%', () => {
    // 1 cent out of $100 rounds to 0%, but it is real spending, not the
    // empty state — a screen reader must not conflate the two.
    const tiny = [
      { key: 'misc', label: 'Misc', cents: 1, color: '#94A3B8' },
      { key: 'needs', label: 'Needs', cents: 9999, color: '#2563EB' },
    ];
    render(<SpendingDonut slices={tiny} centerLabel="$100.00" centerCaption="August 2026" />);
    expect(screen.getByLabelText('Misc, less than 1% of spending')).toBeTruthy();
    expect(screen.queryByLabelText('Misc, 0% of spending')).toBeNull();
  });
});
