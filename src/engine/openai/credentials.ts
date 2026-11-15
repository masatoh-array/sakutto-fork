import { browser } from 'wxt/browser';

// Never use storage.local/sync: content scripts can read those areas by default.
// Session storage is restricted to trusted extension contexts and cleared on browser restart.
const KEY = 'openaiApiKey';
export const OPENAI_ORIGIN = 'https://api.openai.com/*';

export async function hasOpenAIKey(): Promise<boolean> {
  return (await readOpenAIKey()).length > 0;
}

export async function readOpenAIKey(): Promise<string> {
  // Fail closed if the browser cannot enforce the trusted-context boundary.
  await browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const value = (await browser.storage.session.get(KEY))[KEY];
  return typeof value === 'string' && validKey(value) ? value : '';
}

export async function saveOpenAIKey(key: string): Promise<void> {
  const normalized = key.trim();
  if (normalized && !validKey(normalized)) throw new Error('Invalid API key format.');
  await browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  if (normalized) await browser.storage.session.set({ [KEY]: normalized });
  else await browser.storage.session.remove(KEY);
}

// Do not constrain the service's key prefix, but reject control characters, whitespace
// and unreasonable input sizes. Error messages must never interpolate the value.
function validKey(value: string): boolean {
  return /^[\x21-\x7e]{1,1024}$/.test(value);
}
