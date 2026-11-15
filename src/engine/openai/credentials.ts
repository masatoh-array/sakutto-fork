import { browser } from 'wxt/browser';

// Never use storage.local/sync: content scripts can read those areas by default.
// Session storage is restricted to trusted extension contexts and cleared on browser restart.
const KEY = 'openaiApiKey';
export const OPENAI_ORIGIN = 'https://api.openai.com/*';

export async function hasOpenAIKey(): Promise<boolean> {
  return (await readOpenAIKey()).length > 0;
}

export async function readOpenAIKey(): Promise<string> {
  const value = (await browser.storage.session.get(KEY))[KEY];
  return typeof value === 'string' ? value : '';
}

export async function saveOpenAIKey(key: string): Promise<void> {
  await browser.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  if (key.trim()) await browser.storage.session.set({ [KEY]: key.trim() });
  else await browser.storage.session.remove(KEY);
}
