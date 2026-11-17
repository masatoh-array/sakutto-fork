import { describe, expect, it, vi } from 'vitest';
import { OpenAITranslationCache, openAICacheKey } from '@/engine/openai/cache';
import { MemoryTranslationCacheStore } from '@/engine/cache/store';
import type { Engine, TranslateOptions, TranslationChunk } from '@/engine/types';

const segments = [
  { id: 'a', text: 'Hello' },
  { id: 'b', text: 'World' },
];
function options(): TranslateOptions {
  return {
    tgt: 'ja',
    form: 'polite',
    priority: 1,
    signal: new AbortController().signal,
    cacheScope: 'https://a.example',
  };
}
async function collect(output: AsyncIterable<TranslationChunk>) {
  const chunks = [];
  for await (const chunk of output) chunks.push(chunk);
  return chunks;
}
function engine() {
  const translate = vi.fn(async function* (input: typeof segments) {
    for (const segment of input)
      yield { id: segment.id, final: `${segment.text} translated`, engine: 'openai' as const };
  });
  return { translate };
}

describe('OpenAI persistent call cache', () => {
  it('reuses persisted whole calls and maps IDs from the new caller', async () => {
    const store = new MemoryTranslationCacheStore();
    const inner = engine();
    await collect(new OpenAITranslationCache(store).translate(inner, segments, options(), 'model'));
    const result = await collect(
      new OpenAITranslationCache(store).translate(
        inner,
        segments.map((s) => ({ ...s, id: s.id + '2' })),
        options(),
        'model',
      ),
    );
    expect(inner.translate).toHaveBeenCalledTimes(1);
    expect(result.map((c) => c.id)).toEqual(['a2', 'b2']);
  });

  it('partitions all translation inputs, origin, model and ordered neighbors', () => {
    const base = options();
    const key = openAICacheKey(segments, base, 'model');
    for (const changes of [
      { cacheScope: 'https://b.example' },
      { tgt: 'fr' },
      { src: 'de' },
      { form: 'plain' as const },
      { context: 'technical' },
      { glossary: [{ source: 'Hello', target: 'こんにちは' }] },
    ])
      expect(openAICacheKey(segments, { ...base, ...changes }, 'model')).not.toBe(key);
    expect(openAICacheKey([...segments].reverse(), base, 'model')).not.toBe(key);
    expect(openAICacheKey(segments, base, 'other-model')).not.toBe(key);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });

  it('never shares calls across origins or caches an unknown origin', async () => {
    const cache = new OpenAITranslationCache(new MemoryTranslationCacheStore());
    const inner = engine();
    for (const cacheScope of ['https://a.example', 'https://b.example', undefined, undefined]) {
      await collect(cache.translate(inner, segments, { ...options(), cacheScope }, 'model'));
    }
    expect(inner.translate).toHaveBeenCalledTimes(4);
  });

  it.each(['partial', 'error', 'duplicate', 'aborted'])(
    'does not persist %s results',
    async (mode) => {
      const cache = new OpenAITranslationCache(new MemoryTranslationCacheStore());
      const controller = new AbortController();
      const bad: Engine = {
        async *translate() {
          yield { id: 'a', final: 'one' };
          if (mode === 'error') throw new Error('failed');
          if (mode === 'duplicate') {
            yield { id: 'a', final: 'again' };
            yield { id: 'b', final: 'two' };
          }
          if (mode === 'aborted') {
            controller.abort();
            yield { id: 'b', final: 'two' };
          }
        },
      };
      await collect(
        cache.translate(bad, segments, { ...options(), signal: controller.signal }, 'model'),
      ).catch(() => {});
      const inner = engine();
      await collect(cache.translate(inner, segments, options(), 'model'));
      expect(inner.translate).toHaveBeenCalledTimes(1);
    },
  );

  it('clears persisted results and prevents in-flight calls from repopulating', async () => {
    const cache = new OpenAITranslationCache(new MemoryTranslationCacheStore());
    const inner = engine();
    await collect(cache.translate(inner, segments, options(), 'model'));
    await cache.clear();
    const inFlight: Engine = {
      async *translate() {
        yield { id: 'a', final: 'one' };
        await cache.clear();
        yield { id: 'b', final: 'two' };
      },
    };
    await collect(cache.translate(inFlight, segments, options(), 'model'));
    await collect(cache.translate(inner, segments, options(), 'model'));
    expect(inner.translate).toHaveBeenCalledTimes(2);
  });
});
