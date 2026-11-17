import { sha256Hex } from '../model/sha256';
import {
  IndexedDbTranslationCacheStore,
  MemoryTranslationCacheStore,
  type TranslationCacheStore,
} from '../cache/store';
import type { Engine, TranslateOptions, TranslateSegment, TranslationChunk } from '../types';
import { OPENAI_PROMPT_VERSION } from './engine';

/** Background-only database. Neither source text nor credentials appear in its keys. */
export const OPENAI_CACHE_DATABASE = 'sakutto-openai-translations';
const MAX_ENTRIES = 500;

export function openAICacheKey(
  segments: readonly TranslateSegment[],
  options: TranslateOptions,
  model: string,
): string {
  return sha256Hex(
    JSON.stringify({
      version: OPENAI_PROMPT_VERSION,
      origin: options.cacheScope,
      model,
      src: options.src ?? null,
      tgt: options.tgt,
      form: options.form,
      glossary: options.glossary ?? [],
      context: options.context ?? null,
      texts: segments.map(({ text }) => text),
    }),
  );
}

/** Cache whole ordered calls, never partial batches: neighboring text influences wording. */
export class OpenAITranslationCache {
  private storePromise: Promise<TranslationCacheStore> | undefined;
  private generation = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly suppliedStore?: TranslationCacheStore) {}

  private store(): Promise<TranslationCacheStore> {
    return (this.storePromise ??= this.suppliedStore
      ? Promise.resolve(this.suppliedStore)
      : Promise.resolve()
          .then(() => IndexedDbTranslationCacheStore.open(indexedDB, OPENAI_CACHE_DATABASE))
          .catch(() => new MemoryTranslationCacheStore()));
  }

  async clear(): Promise<void> {
    this.generation++;
    const clear = this.writes.then(async () => {
      await (await this.store()).clear();
    });
    this.writes = clear.catch(() => {});
    await clear;
  }

  async *translate(
    inner: Engine,
    segments: readonly TranslateSegment[],
    options: TranslateOptions,
    model: string,
  ): AsyncGenerator<TranslationChunk> {
    // Missing/opaque caller origins must not share a persistent cache namespace.
    if (!options.cacheScope || new Set(segments.map(({ id }) => id)).size !== segments.length) {
      yield* inner.translate(segments, options);
      return;
    }
    if (options.signal.aborted || segments.length === 0) return;
    const generation = this.generation;
    const key = openAICacheKey(segments, options, model);
    try {
      const hit = await (await this.store()).get(key);
      if (options.signal.aborted || generation !== this.generation) return;
      if (hit?.engine === 'openai') {
        const texts: unknown = JSON.parse(hit.text);
        if (
          Array.isArray(texts) &&
          texts.length === segments.length &&
          texts.every((text) => typeof text === 'string')
        ) {
          for (let i = 0; i < segments.length; i++) {
            if (options.signal.aborted || generation !== this.generation) return;
            yield { id: segments[i]!.id, final: texts[i] as string, engine: 'openai' };
          }
          return;
        }
      }
    } catch {
      /* A broken/unavailable cache must not prevent translation. */
    }
    if (options.signal.aborted) return;
    const results = new Map<string, string>();
    const ids = new Set(segments.map(({ id }) => id));
    let valid = true;
    for await (const chunk of inner.translate(segments, options)) {
      if (options.signal.aborted) return;
      if (chunk.final !== undefined) {
        if (!ids.has(chunk.id) || results.has(chunk.id)) valid = false;
        results.set(chunk.id, chunk.final);
      }
      yield chunk;
    }
    if (
      !valid ||
      options.signal.aborted ||
      results.size !== segments.length ||
      generation !== this.generation
    )
      return;
    const text = JSON.stringify(segments.map(({ id }) => results.get(id)));
    this.writes = this.writes
      .then(async () => {
        if (options.signal.aborted || generation !== this.generation) return;
        const store = await this.store();
        const now = Date.now();
        await store.put(key, { text, engine: 'openai', createdAt: now, lastUsedAt: now });
        await store.prune(MAX_ENTRIES);
      })
      .catch(() => {});
    await this.writes;
  }
}
