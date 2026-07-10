import { isPlaidLinkAvailable, openPlaidLink } from '@/lib/plaidLink.web';

interface FakePlaidConfig {
  token: string;
  onSuccess: (publicToken: string, metadata: { institution?: { name?: string } }) => void;
  onExit: () => void;
}

describe('plaidLink (web)', () => {
  let lastConfig: FakePlaidConfig | null = null;
  const openMock = jest.fn();

  beforeEach(() => {
    lastConfig = null;
    openMock.mockReset();
    (globalThis as Record<string, unknown>).window = Object.assign(
      (globalThis as { window?: object }).window ?? {},
      {
        Plaid: {
          create: (cfg: FakePlaidConfig) => {
            lastConfig = cfg;
            return { open: openMock, exit: jest.fn(), destroy: jest.fn() };
          },
        },
      },
    );
  });

  it('is always available on web', () => {
    expect(isPlaidLinkAvailable()).toBe(true);
  });

  it('creates a handler with the link token and opens it', async () => {
    await openPlaidLink('link-token-1', { onSuccess: jest.fn(), onExit: jest.fn() });
    expect(lastConfig?.token).toBe('link-token-1');
    expect(openMock).toHaveBeenCalled();
  });

  it('maps onSuccess to the shared result shape', async () => {
    const onSuccess = jest.fn();
    await openPlaidLink('t', { onSuccess, onExit: jest.fn() });
    lastConfig!.onSuccess('public-1', { institution: { name: 'Chase' } });
    expect(onSuccess).toHaveBeenCalledWith({ publicToken: 'public-1', institutionName: 'Chase' });
  });

  it('defaults institution name when metadata is missing', async () => {
    const onSuccess = jest.fn();
    await openPlaidLink('t', { onSuccess, onExit: jest.fn() });
    lastConfig!.onSuccess('public-1', {});
    expect(onSuccess).toHaveBeenCalledWith({ publicToken: 'public-1', institutionName: 'Your bank' });
  });
});
