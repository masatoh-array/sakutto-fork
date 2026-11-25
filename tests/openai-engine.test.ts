import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAIEngine,
  OPENAI_RESPONSES_URL,
  openAIBatches,
  parseBatchTranslations,
  responseText,
} from '@/engine/openai/engine';
import { openAIErrorMessageKey } from '@/engine/errors';
import {
  errorFromPayload,
  errorPayload,
  isTranslationServerMessage,
} from '@/engine/offscreen/protocol';
import type { TranslateOptions, TranslationChunk } from '@/engine/types';

const options = (): TranslateOptions => ({
  tgt: 'ja',
  form: 'polite',
  priority: 0,
  signal: new AbortController().signal,
});
const completed = (text: string) => ({
  status: 'completed',
  output: [
    {
      type: 'message',
      content: [
        {
          type: 'output_text',
          text: text ? JSON.stringify({ translations: [{ id: '0', text }] }) : '',
        },
      ],
    },
  ],
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
      segments: [{ id: '0', text: 'Hello <i0>world</i0>.' }],
      context: 'A greeting',
      glossary: [{ source: 'world', target: '世界' }],
    });
  });

  it('does not make a request without a key', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(collect(new OpenAIEngine('', 'test-model'))).rejects.toMatchObject({
      code: 'openai-key-missing',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, '', 'openai-auth', 'openaiAuth'],
    [403, '', 'openai-model-access', 'openaiModelAccess'],
    [404, '', 'openai-model-access', 'openaiModelAccess'],
    [429, 'rate_limit_exceeded', 'openai-rate-limit', 'openaiRateLimit'],
    [429, 'insufficient_quota', 'openai-quota', 'openaiQuota'],
    [500, '', 'openai-service', 'openaiService'],
    [400, '', 'openai-rejected', 'openaiRejected'],
  ])(
    'sanitizes HTTP %s errors through the translation protocol without retry',
    async (status, apiCode, code, uiKey) => {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: apiCode, message: 'private API error text' } }),
            { status },
          ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const error = await collect(new OpenAIEngine('test-key-not-real', 'test-model')).catch(
        (failure: unknown) => failure,
      );
      expect(error).toMatchObject({ code, retryable: false });
      const payload = errorPayload(error);
      expect(payload).toMatchObject({ code, message: `OpenAI request failed (HTTP ${status}).` });
      expect(JSON.stringify(payload)).not.toContain('private API error text');
      expect(isTranslationServerMessage({ type: 'error', requestId: 'test', error: payload })).toBe(
        true,
      );
      expect(openAIErrorMessageKey(errorFromPayload(payload))).toBe(uiKey);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [() => Promise.reject(new TypeError('private network error')), 'openai-network'],
    [() => Promise.resolve(new Response('private malformed response')), 'openai-invalid-response'],
  ])('assigns safe diagnoses for network and parse failures', async (fetchMock, code) => {
    vi.stubGlobal('fetch', fetchMock);
    const error = await collect(new OpenAIEngine('test-key-not-real', 'test-model')).catch(
      (failure: unknown) => failure,
    );
    expect(error).toMatchObject({ code, retryable: false });
    expect(JSON.stringify(errorPayload(error))).not.toContain('private');
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
    const assertion = expect(pending).rejects.toMatchObject({ code: 'openai-timeout' });
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

async function collectMany(engine: OpenAIEngine, count: number, opts = options()) {
  const chunks: TranslationChunk[] = [];
  for await (const chunk of engine.translate(
    Array.from({ length: count }, (_, i) => ({ id: `page-${i}`, text: `Text ${i} <i0>tag</i0>` })),
    opts,
  ))
    chunks.push(chunk);
  return chunks;
}
function batchResponse(init: RequestInit, reverse = false) {
  const input = JSON.parse(JSON.parse(init.body as string).input[0].content);
  const translations = input.segments.map((s: { id: string; text: string }) => ({
    id: s.id,
    text: s.text,
  }));
  if (reverse) translations.reverse();
  return new Response(
    JSON.stringify({
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify({ translations }) }],
        },
      ],
    }),
  );
}

it('sends eight adjacent segments together, validates IDs and accepts reordered responses', async () => {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => batchResponse(init, true));
  vi.stubGlobal('fetch', fetchMock);
  const chunks = await collectMany(new OpenAIEngine('test-key-not-real', 'test-model'), 8);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(chunks.map((c) => c.id)).toEqual(Array.from({ length: 8 }, (_, i) => `page-${i}`));
  const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
  expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
});

it('limits concurrent requests globally across engine instances to two', async () => {
  let active = 0;
  let maximum = 0;
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return batchResponse(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      collectMany(new OpenAIEngine('test-key-not-real', 'test-model'), 17),
    ),
  );
  expect(results.map((result) => result.length)).toEqual([17, 17, 17]);
  expect(fetchMock).toHaveBeenCalledTimes(9);
  expect(maximum).toBe(2);
});

it('aborts queued work without sending it and releases concurrency for later calls', async () => {
  const controller = new AbortController();
  let started = 0;
  const fetchMock = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
        if (++started === 2) queueMicrotask(() => controller.abort());
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  await Promise.all(
    Array.from({ length: 3 }, () =>
      collectMany(new OpenAIEngine('test-key-not-real', 'test-model'), 17, {
        ...options(),
        signal: controller.signal,
      }),
    ),
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => batchResponse(init)),
  );
  expect(await collectMany(new OpenAIEngine('test-key-not-real', 'test-model'), 1)).toHaveLength(1);
});

it.each(
  [
    [
      { id: '0', text: 'hello' },
      { id: '0', text: 'hello' },
    ],
    [{ id: '0', text: 'hello' }],
    [
      { id: '0', text: 'hello' },
      { id: '9', text: 'hello' },
    ],
    [
      { id: '0', text: 'hello' },
      { id: '1', text: '' },
    ],
    [
      { id: '0', text: 'missing tags' },
      { id: '1', text: 'hello <i0>tag</i0>' },
    ],
    [
      { id: '0', text: '<i0>broken' },
      { id: '1', text: 'hello <i0>tag</i0>' },
    ],
    [
      { id: '0', text: '<i0>tag</i0><i1>extra</i1>' },
      { id: '1', text: 'hello <i0>tag</i0>' },
    ],
  ].map((translations) => ({ translations })),
)('rejects invalid batch output atomically without retry', async ({ translations }) => {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: JSON.stringify({ translations }) }],
            },
          ],
        }),
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  await expect(
    collectMany(new OpenAIEngine('test-key-not-real', 'test-model'), 2),
  ).rejects.toMatchObject({ retryable: false });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('does not send blank segments, preserving their IDs and original whitespace', async () => {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => batchResponse(init));
  vi.stubGlobal('fetch', fetchMock);
  const chunks: TranslationChunk[] = [];
  for await (const c of new OpenAIEngine('test-key-not-real', 'test-model').translate(
    [
      { id: 'empty', text: ' ' },
      { id: 'other', text: 'hello' },
    ],
    options(),
  ))
    chunks.push(c);
  expect(chunks).toEqual([
    { id: 'empty', final: ' ', engine: 'openai' },
    { id: 'other', final: 'hello', engine: 'openai' },
  ]);
  expect(
    JSON.parse(JSON.parse(fetchMock.mock.calls[0]![1].body as string).input[0].content).segments,
  ).toHaveLength(1);
});

it('bounds batches by both adjacent segment count and text budget', () => {
  const segments = [3000, 3001, 7000, 1].map((length, i) => ({
    id: String(i),
    text: 'x'.repeat(length),
  }));
  expect(openAIBatches(segments).map((batch) => batch.map((s) => s.id))).toEqual([
    ['0'],
    ['1'],
    ['2'],
    ['3'],
  ]);
});

it('allows sibling reordering but rejects changed placeholder nesting or malformed JSON', () => {
  const segments = [{ id: 'a', text: '<i0>one<i1>nested</i1></i0><i2>two</i2>' }];
  const parse = (text: string) =>
    parseBatchTranslations(JSON.stringify({ translations: [{ id: '0', text }] }), segments);
  expect(parse('<i2>two</i2><i0>one<i1>nested</i1></i0>').get('a')).toContain('nested');
  expect(() => parse('<i0>one</i0><i1>nested</i1><i2>two</i2>')).toThrow();
  expect(() => parseBatchTranslations('not json', segments)).toThrow();
});

it('cancels an in-flight sibling after failure without starting later batches or retrying', async () => {
  let aborted = false;
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    if (fetchMock.mock.calls.length === 1)
      return Promise.resolve(new Response('', { status: 429 }));
    return new Promise<Response>((_resolve, reject) =>
      init.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  await expect(
    collectMany(new OpenAIEngine('test-key-not-real', 'test-model'), 24),
  ).rejects.toThrow('HTTP 429');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(aborted).toBe(true);
});
