import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import {
  hasOpenAIKey,
  OPENAI_NATIVE_HOST,
  OPENAI_VAULT_REF,
  readOpenAIKey,
  readOpenAIKeyForTranslation,
  clearOpenAIKeySession,
  readOpenAIVaultRef,
  removesOpenAIAccess,
  saveOpenAIKey,
} from '@/engine/openai/credentials';

const state = vi.hoisted(() => ({
  refs: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
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
      session: {
        setAccessLevel: vi.fn(async () => undefined),
        get: vi.fn(async () => state.session),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(state.session, values)),
        remove: vi.fn(async (key: string) => {
          delete state.session[key];
        }),
      },
      sync: { set: vi.fn() },
    },
  },
}));

beforeEach(() => {
  state.refs = {};
  state.session = {};
  state.vault.clear();
  vi.clearAllMocks();
  let tail: Promise<unknown> = Promise.resolve();
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, fn: () => unknown) => {
        const result = tail.then(fn);
        tail = result.catch(() => undefined);
        return result;
      },
    },
  });
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

describe('Chrome session key cache', () => {
  const signal = () => new AbortController().signal;

  it('invalidates on direct or wildcard API access removal, not unrelated site access', () => {
    expect(removesOpenAIAccess({ permissions: ['nativeMessaging'] })).toBe(true);
    for (const origin of [
      'https://api.openai.com/*',
      '*://*.openai.com/*',
      'https://*/*',
      '<all_urls>',
    ])
      expect(removesOpenAIAccess({ origins: [origin] })).toBe(true);
    expect(
      removesOpenAIAccess({ origins: ['https://example.com/*'], permissions: ['identity'] }),
    ).toBe(false);
  });

  it('shares one cold read, survives worker restart, and reloads once after browser restart', async () => {
    await saveOpenAIKey('test-key-not-real');
    const native = vi.mocked(browser.runtime.sendNativeMessage);
    native.mockClear();
    expect(
      await Promise.all(Array.from({ length: 8 }, () => readOpenAIKeyForTranslation(signal()))),
    ).toEqual(Array(8).fill('test-key-not-real'));
    expect(native).toHaveBeenCalledTimes(1);
    expect(browser.storage.session.setAccessLevel).toHaveBeenLastCalledWith({
      accessLevel: 'TRUSTED_CONTEXTS',
    });

    vi.resetModules();
    const worker = await import('@/engine/openai/credentials');
    expect(await worker.readOpenAIKeyForTranslation(signal())).toBe('test-key-not-real');
    expect(native).toHaveBeenCalledTimes(1);

    state.session = {};
    expect(await worker.readOpenAIKeyForTranslation(signal())).toBe('test-key-not-real');
    expect(native).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(state.refs)).not.toContain('test-key-not-real');
    expect(browser.storage.sync.set).not.toHaveBeenCalled();
  });

  it('waits through replacement and deletion instead of issuing a stale key', async () => {
    const native = vi.mocked(browser.runtime.sendNativeMessage);
    await saveOpenAIKey('old-synthetic');
    expect(await readOpenAIKeyForTranslation(signal())).toBe('old-synthetic');
    let finish!: () => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    native.mockImplementationOnce(async (_host, message) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
        started();
      });
      if (
        !('slot' in message) ||
        typeof message.slot !== 'string' ||
        !('key' in message) ||
        typeof message.key !== 'string'
      )
        throw new Error('Invalid test message');
      state.vault.set(message.slot, message.key);
      return { ok: true };
    });
    const replacing = saveOpenAIKey('new-synthetic');
    await writing;
    expect(state.session).toEqual({});
    const reader = readOpenAIKeyForTranslation(signal());
    finish();
    await replacing;
    expect(await reader).toBe('new-synthetic');

    const deleting = saveOpenAIKey('');
    const reading = readOpenAIKeyForTranslation(signal());
    await deleting;
    expect(await reading).toBe('');
    expect(state.session).toEqual({});
  });

  it('does not put a late cancelled native read in session memory', async () => {
    await saveOpenAIKey('old-synthetic');
    let finish!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(browser.runtime.sendNativeMessage).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
        started();
      });
      return { ok: true, key: 'old-synthetic' };
    });
    const controller = new AbortController();
    const pending = readOpenAIKeyForTranslation(controller.signal);
    await waiting;
    controller.abort();
    const clearing = clearOpenAIKeySession();
    finish();
    expect(await pending).toBe('');
    await clearing;
    expect(state.session).toEqual({});
    expect(browser.storage.session.set).not.toHaveBeenCalled();
  });

  it('fails closed without trusted session access', async () => {
    await saveOpenAIKey('test-key-not-real');
    vi.mocked(browser.runtime.sendNativeMessage).mockClear();
    vi.mocked(browser.storage.session.setAccessLevel).mockRejectedValueOnce(new Error('raw error'));
    await expect(readOpenAIKeyForTranslation(signal())).rejects.toMatchObject({
      code: 'openai-credential-store',
    });
    expect(browser.runtime.sendNativeMessage).not.toHaveBeenCalled();
    expect(browser.storage.session.get).not.toHaveBeenCalled();
  });
});
