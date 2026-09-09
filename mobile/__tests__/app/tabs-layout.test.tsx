// Rendering the real expo-router <Tabs> navigator needs a router context this
// test doesn't set up, so Tabs is stubbed down to its children (mirroring how
// other __tests__/app/*.test.tsx files replace expo-router wholesale). The
// friend/vacation stores are stubbed too — their real `load`/`reconcile`
// reach into @/lib/db and the network, which is irrelevant to what this test
// is checking: that TabsLayout wires flushQueue to app-foreground events.
jest.mock('expo-router', () => {
  const React = require('react');
  const Tabs = ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  Tabs.Screen = () => null;
  return { Tabs };
});
jest.mock('@/stores/transactionStore', () => ({
  useTransactionStore: (selector: (s: { transactions: unknown[] }) => unknown) =>
    selector({ transactions: [] }),
}));
jest.mock('@/stores/friendStore', () => ({
  useFriendStore: (selector: (s: { load: () => void }) => unknown) =>
    selector({ load: jest.fn() }),
}));
jest.mock('@/stores/vacationStore', () => ({
  useVacationStore: (selector: (s: { reconcile: () => void }) => unknown) =>
    selector({ reconcile: jest.fn() }),
}));
jest.mock('@/lib/db', () => ({ pruneOldTransactions: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/splitwiseQueue');

import { AppState } from 'react-native';
import { render } from '@testing-library/react-native';
import TabsLayout from '@/app/(tabs)/_layout';
import { flushQueue } from '@/lib/splitwiseQueue';

it('flushes the queue when the app returns to the foreground', () => {
  const listeners: Record<string, (s: string) => void> = {};
  jest.spyOn(AppState, 'addEventListener').mockImplementation((ev, cb) => {
    listeners[ev] = cb as (s: string) => void;
    return { remove: jest.fn() } as any;
  });

  render(<TabsLayout />);
  (flushQueue as jest.Mock).mockClear();
  listeners['change']('active');

  expect(flushQueue).toHaveBeenCalled();
});
