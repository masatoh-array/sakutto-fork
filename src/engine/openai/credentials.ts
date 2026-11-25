import { browser } from 'wxt/browser';
import { EngineError } from '../errors';

export const OPENAI_ORIGIN = 'https://api.openai.com/*';
export const OPENAI_NATIVE_HOST = 'com.sakutto.openai_vault';
// This sentinel is only an opaque vault slot plus a change marker, never a credential.
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

export async function saveOpenAIKey(input: string): Promise<void> {
  const key = input.trim();
  if (key && !validKey(key)) throw new Error('Invalid API key format.');
  // Options tabs share the extension origin. Serialize changes so they cannot allocate two slots.
  await navigator.locks.request(OPENAI_VAULT_REF, async () => {
    const ref = await readOpenAIVaultRef();
    if (!key && !ref) return;
    const slot = ref?.slot ?? crypto.randomUUID();
    const revision = crypto.randomUUID();
    if (!ref) await browser.storage.local.set({ [OPENAI_VAULT_REF]: { slot, revision } });
    await callVault(key ? 'save' : 'remove', slot, key || undefined);
    // Keep the non-secret slot after deleting the key to make later saves predictable.
    if (ref) await browser.storage.local.set({ [OPENAI_VAULT_REF]: { slot, revision } });
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
