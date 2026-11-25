import { browser } from 'wxt/browser';
import { EngineError } from '../errors';

export const OPENAI_ORIGIN = 'https://api.openai.com/*';
export const OPENAI_NATIVE_HOST = 'com.sakutto.openai_vault';
// This sentinel is only an opaque vault slot plus a change marker, never a credential.
const SESSION_KEY = 'openaiVaultSession';
export const OPENAI_VAULT_REF = 'openaiVaultRef';
type VaultRef = { slot: string; revision: string };
type VaultOperation = 'has' | 'read' | 'save' | 'remove';

function vaultError(): EngineError {
  return new EngineError('openai-credential-store', 'OpenAI credential store unavailable.', {
    retryable: false,
  });
}

export async function readOpenAIVaultRef(): Promise<VaultRef | undefined> {
  try {
    const ref = (await browser.storage.local.get(OPENAI_VAULT_REF))[OPENAI_VAULT_REF];
    if (ref === undefined) return undefined;
    if (
      typeof ref !== 'object' ||
      ref === null ||
      !('slot' in ref) ||
      !('revision' in ref) ||
      !isUuid(ref.slot) ||
      !isUuid(ref.revision)
    )
      throw vaultError();
    return { slot: ref.slot, revision: ref.revision };
  } catch {
    throw vaultError();
  }
}

async function callVault(operation: VaultOperation, slot: string, key?: string): Promise<unknown> {
  try {
    const response: unknown = await browser.runtime.sendNativeMessage(OPENAI_NATIVE_HOST, {
      operation,
      slot,
      ...(key === undefined ? {} : { key }),
    });
    if (
      typeof response !== 'object' ||
      response === null ||
      !('ok' in response) ||
      response.ok !== true
    )
      throw vaultError();
    return response;
  } catch {
    // Extension/OS errors and native replies are never sent to page contexts.
    throw vaultError();
  }
}

export async function hasOpenAIKey(): Promise<boolean> {
  const ref = await readOpenAIVaultRef();
  if (!ref) return false;
  const response = await callVault('has', ref.slot);
  if (
    typeof response !== 'object' ||
    response === null ||
    !('present' in response) ||
    typeof response.present !== 'boolean'
  )
    throw vaultError();
  return response.present;
}

export async function readOpenAIKey(ref: VaultRef): Promise<string> {
  const response = await callVault('read', ref.slot);
  if (
    typeof response !== 'object' ||
    response === null ||
    !('key' in response) ||
    typeof response.key !== 'string'
  )
    throw vaultError();
  if (response.key !== '' && !validKey(response.key)) throw vaultError();
  return response.key;
}

// Serialize cache population and credential edits across the service worker and options tabs.
async function withVaultLock<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await navigator.locks.request(OPENAI_VAULT_REF, action);
  } catch {
    throw vaultError();
  }
}

async function trustedSession(): Promise<typeof browser.storage.session> {
  const session = browser.storage.session;
  // Never read or write a key if the browser cannot restrict access to extension contexts.
  await session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  return session;
}

export function removesOpenAIAccess(removed: {
  permissions?: string[];
  origins?: string[];
}): boolean {
  // Wildcard host grants can authorize the API as well.
  return (
    removed.permissions?.includes('nativeMessaging') === true ||
    removed.origins?.some(
      (pattern) =>
        pattern === '<all_urls>' ||
        /^(?:https|\*):\/\/(?:\*\.)?(?:api\.openai\.com|openai\.com|\*)\//.test(pattern),
    ) === true
  );
}

export function clearOpenAIKeySession(): Promise<void> {
  return withVaultLock(async () => {
    await (await trustedSession()).remove(SESSION_KEY);
  });
}

export async function readOpenAIKeyForTranslation(signal: AbortSignal): Promise<string> {
  return withVaultLock(async () => {
    if (signal.aborted) return '';
    const ref = await readOpenAIVaultRef();
    if (!ref || signal.aborted) return '';
    const session = await trustedSession();
    const cached: unknown = (await session.get(SESSION_KEY))[SESSION_KEY];
    if (signal.aborted) return '';
    if (
      cached !== null &&
      typeof cached === 'object' &&
      'slot' in cached &&
      cached.slot === ref.slot &&
      'revision' in cached &&
      cached.revision === ref.revision &&
      'key' in cached &&
      typeof cached.key === 'string' &&
      validKey(cached.key)
    )
      return cached.key;

    const key = await readOpenAIKey(ref);
    if (signal.aborted) return '';
    if (key) await session.set({ [SESSION_KEY]: { ...ref, key } });
    return key;
  });
}

export async function saveOpenAIKey(input: string): Promise<void> {
  const key = input.trim();
  if (key && !validKey(key)) throw new Error('Invalid API key format.');
  await withVaultLock(async () => {
    const ref = await readOpenAIVaultRef();
    if (!key && !ref) return;
    const slot = ref?.slot ?? crypto.randomUUID();
    const revision = crypto.randomUUID();
    // Notify active translations before changing the native vault. Waiting readers cannot
    // use this revision until the write finishes and releases the lock.
    await browser.storage.local.set({ [OPENAI_VAULT_REF]: { slot, revision } });
    await (await trustedSession()).remove(SESSION_KEY);
    await callVault(key ? 'save' : 'remove', slot, key || undefined);
  });
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  );
}

function validKey(value: string): boolean {
  return /^[\x21-\x7e]{1,1024}$/.test(value);
}
