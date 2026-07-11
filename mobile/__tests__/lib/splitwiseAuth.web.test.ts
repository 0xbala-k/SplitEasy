import { signInWithSplitwise, getWebRedirectUri } from '@/lib/splitwiseAuth.web';

describe('splitwiseAuth (web)', () => {
  const assignMock = jest.fn();

  beforeEach(() => {
    assignMock.mockReset();
    (globalThis as Record<string, unknown>).window = Object.assign(
      (globalThis as { window?: object }).window ?? {},
      { location: { origin: 'https://app.example', assign: assignMock } },
    );
  });

  it('derives the redirect uri from the page origin', () => {
    expect(getWebRedirectUri()).toBe('https://app.example/oauth/callback');
  });

  it('navigates to the Splitwise authorize URL and resolves null', async () => {
    const result = await signInWithSplitwise('client-1');
    expect(result).toBeNull();
    const url = assignMock.mock.calls[0][0] as string;
    expect(url).toContain('https://secure.splitwise.com/oauth/authorize');
    expect(url).toContain('client_id=client-1');
    expect(url).toContain(encodeURIComponent('https://app.example/oauth/callback'));
  });
});
