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
