import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import {
  hasOpenAIKey,
  OPENAI_NATIVE_HOST,
  OPENAI_VAULT_REF,
  readOpenAIKey,
  readOpenAIVaultRef,
  saveOpenAIKey,
} from '@/engine/openai/credentials';

const state = vi.hoisted(() => ({
  refs: {} as Record<string, unknown>,
  vault: new Map<string, string>(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      sendNativeMessage: vi.fn(async (_host, request) => {
        const { slot, operation, key } = request;
        if (operation === 'save') state.vault.set(slot, key);
        if (operation === 'remove') state.vault.delete(slot);
        if (operation === 'has') return { ok: true, present: state.vault.has(slot) };
        if (operation === 'read') return { ok: true, key: state.vault.get(slot) ?? '' };
        return { ok: true };
      }),
    },
    storage: {
      local: {
        get: vi.fn(async () => state.refs),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(state.refs, values);
        }),
      },
      session: { set: vi.fn() },
      sync: { set: vi.fn() },
    },
  },
}));

beforeEach(() => {
  state.refs = {};
  state.vault.clear();
  vi.clearAllMocks();
  vi.stubGlobal('navigator', { locks: { request: (_name: string, fn: () => unknown) => fn() } });
});

describe('OpenAI Windows vault bridge', () => {
  it('persists only a slot reference in Chrome and can use it in a fresh module instance', async () => {
    await saveOpenAIKey(' test-key-not-real ');
    const ref = (await readOpenAIVaultRef())!;
    expect(browser.runtime.sendNativeMessage).toHaveBeenCalledWith(OPENAI_NATIVE_HOST, {
      operation: 'save',
      slot: ref.slot,
      key: 'test-key-not-real',
    });
    expect(state.refs).toEqual({ [OPENAI_VAULT_REF]: ref });
    expect(JSON.stringify(state.refs)).not.toContain('test-key-not-real');
    expect(browser.storage.session.set).not.toHaveBeenCalled();
    expect(browser.storage.sync.set).not.toHaveBeenCalled();

    vi.resetModules();
    const restarted = await import('@/engine/openai/credentials');
    expect(await restarted.hasOpenAIKey()).toBe(true);
    expect(await restarted.readOpenAIKey((await restarted.readOpenAIVaultRef())!)).toBe(
      'test-key-not-real',
    );
  });

  it('keeps the slot stable while replacing or removing its key', async () => {
    expect(await hasOpenAIKey()).toBe(false);
    expect(browser.runtime.sendNativeMessage).not.toHaveBeenCalled();
    await saveOpenAIKey('test-key-not-real');
    const first = (await readOpenAIVaultRef())!;
    await saveOpenAIKey('replacement-not-real');
    const second = (await readOpenAIVaultRef())!;
    expect(second.slot).toBe(first.slot);
    expect(second.revision).not.toBe(first.revision);
    expect(await readOpenAIKey(second)).toBe('replacement-not-real');
    await saveOpenAIKey('');
    expect(await hasOpenAIKey()).toBe(false);
    expect(state.vault.size).toBe(0);
  });

  it('treats a missing or denied host as unavailable, never as a successful save', async () => {
    vi.mocked(browser.runtime.sendNativeMessage).mockRejectedValueOnce(
      new Error('raw native error'),
    );
    await expect(saveOpenAIKey('test-key-not-real')).rejects.toMatchObject({
      code: 'openai-credential-store',
      message: 'OpenAI credential store unavailable.',
    });
    expect(state.vault.size).toBe(0);
    expect(JSON.stringify(state.refs)).not.toContain('test-key-not-real');
  });

  it('rejects malformed stored references without calling the host', async () => {
    state.refs[OPENAI_VAULT_REF] = { slot: '../invalid', revision: 0 };
    await expect(hasOpenAIKey()).rejects.toMatchObject({ code: 'openai-credential-store' });
    expect(browser.runtime.sendNativeMessage).not.toHaveBeenCalled();
  });

  it.each(['test\nkey', 'test key', 'test\u0000key', 'x'.repeat(1025)])(
    'rejects malformed keys before storage or messaging',
    async (key) => {
      await expect(saveOpenAIKey(key)).rejects.toThrow('Invalid API key format.');
      expect(browser.runtime.sendNativeMessage).not.toHaveBeenCalled();
      expect(browser.storage.local.set).not.toHaveBeenCalled();
    },
  );
});
