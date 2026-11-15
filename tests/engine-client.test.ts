import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { EngineClient } from '@/background/engine-client';
import type { OffscreenController } from '@/background/offscreen-lifecycle';
import type { TranslateOptions, TranslationChunk } from '@/engine/types';
import { FakePort, flushTasks } from './support/ports';

const cloudMocks = vi.hoisted(() => ({
  localGet: vi.fn<() => Promise<Record<string, unknown>>>(async () => ({})),
  contains: vi.fn(async () => true),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: { id: 'test-extension', connect: vi.fn() },
    storage: {
      local: { get: cloudMocks.localGet },
      session: {
        get: vi.fn(async () => ({ openaiApiKey: 'test-key-not-real' })),
        setAccessLevel: vi.fn(async () => undefined),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    permissions: { contains: cloudMocks.contains },
    i18n: { getUILanguage: () => 'en' },
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const connect = vi.mocked(browser.runtime.connect);

function options(signal = new AbortController().signal): TranslateOptions {
  return { tgt: 'ja', form: 'polite', priority: 10, signal };
}

function controller(): OffscreenController {
  return {
    ensure: vi.fn(async () => undefined),
    recreate: vi.fn(async () => undefined),
  } as unknown as OffscreenController;
}

describe('EngineClient', () => {
  it('fails every open stream when the host port disconnects', async () => {
    const port = new FakePort();
    connect.mockReturnValue(port.port);
    const client = new EngineClient(controller());

    const iterator = client
      .translate([{ id: 'a', text: 'Hello.' }], options())
      [Symbol.asyncIterator]();
    const first = iterator.next();
    await flushTasks();
    expect(port.messagesOfType('translate')).toHaveLength(1);

    port.disconnect();

    await expect(first).rejects.toMatchObject({ code: 'offscreen-unavailable' });
  });

  it('recreates the offscreen document once after a request times out', async () => {
    vi.useFakeTimers();
    try {
      const port = new FakePort();
      connect.mockReturnValue(port.port);
      const offscreen = controller();
      const client = new EngineClient(offscreen);

      const pending = client.status();
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'offscreen-unavailable',
      });
      await vi.advanceTimersByTimeAsync(15_000);

      await rejection;
      expect(offscreen.recreate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps chunk provenance from the host', async () => {
    const port = new FakePort();
    connect.mockReturnValue(port.port);
    const client = new EngineClient(controller());
    const chunks: TranslationChunk[] = [];

    const pending = (async () => {
      for await (const chunk of client.translate([{ id: 'a', text: 'Hello.' }], options())) {
        chunks.push(chunk);
      }
    })();
    await flushTasks();

    port.emit({
      type: 'chunk',
      requestId: (port.messagesOfType('translate')[0] as { requestId: string }).requestId,
      chunk: { id: 'a', final: '邁｡譏楢ｨｳ', engine: 'chrome' },
    });
    port.emit({
      type: 'done',
      requestId: (port.messagesOfType('translate')[0] as { requestId: string }).requestId,
    });
    await pending;

    expect(chunks).toEqual([{ id: 'a', final: '邁｡譏楢ｨｳ', engine: 'chrome' }]);
  });
});

describe('EngineClient OpenAI routing', () => {
  it('routes to OpenAI without opening the local model host', async () => {
    cloudMocks.localGet.mockResolvedValueOnce({
      settings: { schemaVersion: 1, translationProvider: 'openai', openaiModel: 'test-model' },
    });
    cloudMocks.localGet.mockResolvedValueOnce({
      settings: { schemaVersion: 1, translationProvider: 'openai', openaiModel: 'test-model' },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: '訳文' }] }],
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const offscreen = controller();
    const client = new EngineClient(offscreen);
    const chunks: TranslationChunk[] = [];
    for await (const chunk of client.translate([{ id: 'a', text: 'Hello' }], options()))
      chunks.push(chunk);
    expect(chunks).toEqual([{ id: 'a', final: '訳文', engine: 'openai' }]);
    expect(offscreen.ensure).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(browser.storage.onChanged.removeListener).toHaveBeenCalled();
  });
  it('does not fall back to a local model when OpenAI permission is missing', async () => {
    cloudMocks.localGet.mockResolvedValueOnce({
      settings: { schemaVersion: 1, translationProvider: 'openai' },
    });
    cloudMocks.contains.mockResolvedValueOnce(false);
    const offscreen = controller();
    const iterator = new EngineClient(offscreen)
      .translate([{ id: 'a', text: 'Hello' }], options())
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow('Enable OpenAI access');
    expect(offscreen.ensure).not.toHaveBeenCalled();
  });
});

describe('OpenAI authorization changes', () => {
  it('does not send a stale cloud request if provider changes during permission check', async () => {
    cloudMocks.localGet.mockResolvedValueOnce({
      settings: { schemaVersion: 1, translationProvider: 'openai' },
    });
    cloudMocks.localGet.mockResolvedValueOnce({
      settings: { schemaVersion: 1, translationProvider: 'local' },
    });
    cloudMocks.contains.mockImplementationOnce(async () => {
      await Promise.resolve();
      return true;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const offscreen = controller();
    const iterator = new EngineClient(offscreen)
      .translate([{ id: 'a', text: 'Hello' }], options())
      [Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(offscreen.ensure).not.toHaveBeenCalled();
  });

  it.each(['key removal', 'provider change'])(
    'aborts pending cloud translation on %s',
    async (change) => {
      for (let i = 0; i < 2; i += 1)
        cloudMocks.localGet.mockResolvedValueOnce({
          settings: { schemaVersion: 1, translationProvider: 'openai', openaiModel: 'test-model' },
        });
      const fetchMock = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const iterator = new EngineClient(controller())
        .translate([{ id: 'a', text: 'Hello' }], options())
        [Symbol.asyncIterator]();
      const pending = iterator.next();
      await flushTasks();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const listener = vi.mocked(browser.storage.onChanged.addListener).mock.calls.at(-1)![0];
      if (change === 'key removal')
        listener({ openaiApiKey: { oldValue: 'test-key-not-real' } }, 'session');
      else listener({ settings: { newValue: { translationProvider: 'local' } } }, 'local');
      expect(await pending).toEqual({ done: true, value: undefined });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(browser.storage.onChanged.removeListener).toHaveBeenCalledWith(listener);
    },
  );
});
