// mobile/lib/plaidLink.web.ts
import type { PlaidLinkHandlers, PlaidLinkResult } from './plaidLink';

export type { PlaidLinkHandlers, PlaidLinkResult };

const SCRIPT_SRC = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

interface PlaidGlobal {
  create(config: {
    token: string;
    onSuccess: (publicToken: string, metadata: { institution?: { name?: string } }) => void;
    onExit: () => void;
  }): { open(): void; exit(): void; destroy(): void };
}

declare global {
  interface Window { Plaid?: PlaidGlobal }
}

let scriptPromise: Promise<void> | null = null;
let currentHandler: { open(): void; exit(): void; destroy(): void } | null = null;

function loadScript(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT_SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromise = null; // allow retry on next attempt
        reject(new Error('PLAID_SCRIPT_LOAD_FAILED'));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

export function isPlaidLinkAvailable(): boolean {
  return true;
}

export async function openPlaidLink(linkToken: string, handlers: PlaidLinkHandlers): Promise<void> {
  await loadScript();
  currentHandler?.destroy();
  currentHandler = window.Plaid!.create({
    token: linkToken,
    onSuccess: (publicToken, metadata) => {
      handlers.onSuccess({ publicToken, institutionName: metadata.institution?.name ?? 'Your bank' });
    },
    onExit: () => handlers.onExit(),
  });
  currentHandler.open();
}

export async function disposePlaidLink(): Promise<void> {
  currentHandler?.destroy();
  currentHandler = null;
}
