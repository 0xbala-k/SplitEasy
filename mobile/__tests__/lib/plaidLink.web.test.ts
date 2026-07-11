import { isPlaidLinkAvailable, openPlaidLink, disposePlaidLink } from '@/lib/plaidLink.web';

interface FakePlaidConfig {
  token: string;
  onSuccess: (publicToken: string, metadata: { institution?: { name?: string } }) => void;
  onExit: () => void;
}

describe('plaidLink (web)', () => {
  let lastConfig: FakePlaidConfig | null = null;
  const openMock = jest.fn();
  const destroyMock = jest.fn();

  beforeEach(() => {
    lastConfig = null;
    openMock.mockReset();
    destroyMock.mockReset();
    (globalThis as Record<string, unknown>).window = Object.assign(
      (globalThis as { window?: object }).window ?? {},
      {
        Plaid: {
          create: (cfg: FakePlaidConfig) => {
            lastConfig = cfg;
            return { open: openMock, exit: jest.fn(), destroy: destroyMock };
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

  it('destroys the previous handler when opening again', async () => {
    await openPlaidLink('t1', { onSuccess: jest.fn(), onExit: jest.fn() });
    destroyMock.mockClear();
    await openPlaidLink('t2', { onSuccess: jest.fn(), onExit: jest.fn() });
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it('disposePlaidLink destroys the current handler', async () => {
    await openPlaidLink('t', { onSuccess: jest.fn(), onExit: jest.fn() });
    destroyMock.mockClear();
    await disposePlaidLink();
    expect(destroyMock).toHaveBeenCalledTimes(1);
    destroyMock.mockClear();
    await disposePlaidLink(); // handler already cleared — no double destroy
    expect(destroyMock).not.toHaveBeenCalled();
  });
});

describe('plaidLink (web) script injection', () => {
  interface FakeScript {
    src?: string;
    async?: boolean;
    onload: (() => void) | null;
    onerror: (() => void) | null;
  }

  const openMock = jest.fn();
  let win: { Plaid?: { create: (cfg: FakePlaidConfig) => unknown } };
  let scriptEl: FakeScript | null;
  let appendedScripts: FakeScript[];
  let onAppend: (() => void) | null;

  function installPlaid() {
    win.Plaid = {
      create: () => ({ open: openMock, exit: jest.fn(), destroy: jest.fn() }),
    };
  }

  beforeEach(() => {
    jest.resetModules();
    openMock.mockReset();
    scriptEl = null;
    appendedScripts = [];
    onAppend = null;
    win = {};
    (globalThis as Record<string, unknown>).window = win;
    (globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => {
        expect(tag).toBe('script');
        scriptEl = { onload: null, onerror: null };
        return scriptEl;
      },
      head: {
        appendChild: (el: FakeScript) => {
          appendedScripts.push(el);
          // Browsers fire script load/error events asynchronously, after the
          // script element is appended and the current task completes.
          queueMicrotask(() => onAppend?.());
        },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
  });

  it('injects the Plaid script, resolves on load, and opens the handler', async () => {
    onAppend = () => {
      installPlaid();
      scriptEl!.onload!();
    };
    const mod = jest.requireActual<typeof import('@/lib/plaidLink.web')>('@/lib/plaidLink.web');
    await mod.openPlaidLink('tok', { onSuccess: jest.fn(), onExit: jest.fn() });
    expect(appendedScripts).toHaveLength(1);
    expect(appendedScripts[0].src).toBe('https://cdn.plaid.com/link/v2/stable/link-initialize.js');
    expect(openMock).toHaveBeenCalled();
  });

  it('rejects with PLAID_SCRIPT_LOAD_FAILED on error and retries injection next call', async () => {
    let failNext = true;
    onAppend = () => {
      if (failNext) {
        failNext = false;
        scriptEl!.onerror!();
      } else {
        installPlaid();
        scriptEl!.onload!();
      }
    };
    const mod = jest.requireActual<typeof import('@/lib/plaidLink.web')>('@/lib/plaidLink.web');
    await expect(
      mod.openPlaidLink('tok', { onSuccess: jest.fn(), onExit: jest.fn() }),
    ).rejects.toThrow('PLAID_SCRIPT_LOAD_FAILED');
    expect(openMock).not.toHaveBeenCalled();

    // scriptPromise was reset — a second attempt injects a fresh script and succeeds
    await mod.openPlaidLink('tok', { onSuccess: jest.fn(), onExit: jest.fn() });
    expect(appendedScripts).toHaveLength(2);
    expect(openMock).toHaveBeenCalled();
  });
});
