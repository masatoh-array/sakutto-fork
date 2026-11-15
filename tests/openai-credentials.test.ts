import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { hasOpenAIKey, readOpenAIKey, saveOpenAIKey } from '@/engine/openai/credentials';

const state = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      session: {
        get: vi.fn(async () => state.values),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(state.values, values);
        }),
        remove: vi.fn(async (key: string) => {
          delete state.values[key];
        }),
        setAccessLevel: vi.fn(async () => undefined),
      },
      local: { set: vi.fn() },
      sync: { set: vi.fn() },
    },
  },
}));
beforeEach(() => {
  state.values = {};
  vi.clearAllMocks();
});
describe('OpenAI credential storage', () => {
  it('uses only trusted-context session storage, never local or sync', async () => {
    await saveOpenAIKey(' test-key-not-real ');
    expect(browser.storage.session.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: 'TRUSTED_CONTEXTS',
    });
    expect(await hasOpenAIKey()).toBe(true);
    expect(await readOpenAIKey()).toBe('test-key-not-real');
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    expect(browser.storage.sync.set).not.toHaveBeenCalled();
  });
  it('removes credentials and handles a new session without credentials', async () => {
    expect(await hasOpenAIKey()).toBe(false);
    await saveOpenAIKey('test-key-not-real');
    await saveOpenAIKey('');
    expect(browser.storage.session.remove).toHaveBeenCalledWith('openaiApiKey');
    expect(await readOpenAIKey()).toBe('');
  });
});

it('establishes trusted access before reading and fails closed when it is unavailable', async () => {
  vi.mocked(browser.storage.session.setAccessLevel).mockRejectedValueOnce(new Error('unavailable'));
  await expect(readOpenAIKey()).rejects.toThrow('unavailable');
  expect(browser.storage.session.get).not.toHaveBeenCalled();
});

it('does not persist credentials when the trusted boundary cannot be established', async () => {
  vi.mocked(browser.storage.session.setAccessLevel).mockRejectedValueOnce(new Error('unavailable'));
  await expect(saveOpenAIKey('test-key-not-real')).rejects.toThrow('unavailable');
  expect(browser.storage.session.set).not.toHaveBeenCalled();
});

it.each(['test\nkey', 'test key', 'test\u0000key', 'x'.repeat(1025)])(
  'rejects malformed keys without echoing their value',
  async (key) => {
    await expect(saveOpenAIKey(key)).rejects.toThrow('Invalid API key format.');
    expect(browser.storage.session.set).not.toHaveBeenCalled();
    state.values.openaiApiKey = key;
    expect(await readOpenAIKey()).toBe('');
  },
);
