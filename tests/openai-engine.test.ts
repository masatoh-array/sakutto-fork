import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIEngine, OPENAI_RESPONSES_URL, responseText } from '@/engine/openai/engine';
import type { TranslateOptions, TranslationChunk } from '@/engine/types';

const options = (): TranslateOptions => ({
  tgt: 'ja',
  form: 'polite',
  priority: 0,
  signal: new AbortController().signal,
});
const completed = (text: string) => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
});
async function collect(engine: OpenAIEngine, opts = options()): Promise<TranslationChunk[]> {
  const chunks: TranslationChunk[] = [];
  for await (const chunk of engine.translate([{ id: 'a', text: 'Hello <i0>world</i0>.' }], opts))
    chunks.push(chunk);
  return chunks;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('OpenAI translation', () => {
  it('uses only the fixed Responses endpoint, opts out of storage, and preserves segment identity', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(completed('こんにちは <i0>世界</i0>。'))),
    );
    vi.stubGlobal('fetch', fetchMock);
    const opts = {
      ...options(),
      context: 'A greeting',
      glossary: [
        { source: 'world', target: '世界' },
        { source: 'secret-unrelated-term', target: 'do-not-send' },
      ],
    };
    expect(await collect(new OpenAIEngine('test-key-not-real', 'gpt-4.1-mini'), opts)).toEqual([
      { id: 'a', final: 'こんにちは <i0>世界</i0>。', engine: 'openai' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(OPENAI_RESPONSES_URL);
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'gpt-4.1-mini', store: false });
    expect(body.instructions).toContain('<i0>');
    expect(JSON.parse(body.input[0].content)).toEqual({
      text: 'Hello <i0>world</i0>.',
      context: 'A greeting',
      glossary: [{ source: 'world', target: '世界' }],
    });
  });

  it('does not make a request without a key', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(collect(new OpenAIEngine('', 'test-model'))).rejects.toMatchObject({
      code: 'invalid-input',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 429, 500])('sanitizes HTTP %s errors and does not retry', async (status) => {
    const fetchMock = vi.fn(
      async () => new Response('private text and key must not escape', { status }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(collect(new OpenAIEngine('test-key-not-real', 'test-model'))).rejects.toThrow(
      `HTTP ${status}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects incomplete, refusal and empty output', () => {
    expect(responseText({ ...completed('partial'), status: 'incomplete' })).toBeNull();
    expect(responseText(completed(''))).toBeNull();
    expect(
      responseText({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
      }),
    ).toBeNull();
  });

  it('does not send when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await collect(new OpenAIEngine('test-key-not-real', 'test-model'), {
        ...options(),
        signal: controller.signal,
      }),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts an in-flight request when cancelled', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          controller.abort();
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await collect(new OpenAIEngine('test-key-not-real', 'test-model'), {
        ...options(),
        signal: controller.signal,
      }),
    ).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out with a safe error and does not retry', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const pending = collect(new OpenAIEngine('test-key-not-real', 'test-model'));
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

it('keeps the key out of object serialization and enumerable properties', () => {
  const engine = new OpenAIEngine('test-key-not-real', 'test-model');
  expect(JSON.stringify(engine)).not.toContain('test-key-not-real');
  expect(Object.values({ ...engine })).not.toContain('test-key-not-real');
});
