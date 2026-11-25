const OPENAI_ERROR_MESSAGES = {
  'openai-key-missing': 'openaiKeyMissing',
  'openai-permission': 'openaiPermission',
  'openai-credential-store': 'openaiCredentialStore',
  'openai-auth': 'openaiAuth',
  'openai-model-access': 'openaiModelAccess',
  'openai-quota': 'openaiQuota',
  'openai-rate-limit': 'openaiRateLimit',
  'openai-timeout': 'openaiTimeout',
  'openai-network': 'openaiNetwork',
  'openai-invalid-response': 'openaiInvalidResponse',
  'openai-service': 'openaiService',
  'openai-rejected': 'openaiRejected',
} as const;

export type EngineErrorCode =
  | keyof typeof OPENAI_ERROR_MESSAGES
  | 'invalid-input'
  | 'unsupported-language'
  | 'model-missing'
  | 'model-integrity'
  | 'model-load-failed'
  | 'gpu-unavailable'
  | 'download-failed'
  | 'storage-insufficient'
  | 'chrome-unavailable'
  | 'chrome-not-ready'
  | 'offscreen-unavailable'
  | 'aborted'
  | 'unknown';

export class EngineError extends Error {
  override readonly name = 'EngineError';
  readonly retryable: boolean;

  constructor(
    readonly code: EngineErrorCode,
    message: string,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message);
    if (options && 'cause' in options) this.cause = options.cause;
    this.retryable = options?.retryable ?? true;
  }
}

export function isEngineError(value: unknown): value is EngineError {
  return value instanceof EngineError;
}

const ENGINE_ERROR_CODES: ReadonlySet<string> = new Set<EngineErrorCode>([
  'invalid-input',
  'unsupported-language',
  'model-missing',
  'model-integrity',
  'model-load-failed',
  'gpu-unavailable',
  'download-failed',
  'storage-insufficient',
  'chrome-unavailable',
  'chrome-not-ready',
  'offscreen-unavailable',
  'aborted',
  'unknown',
  ...(Object.keys(OPENAI_ERROR_MESSAGES) as (keyof typeof OPENAI_ERROR_MESSAGES)[]),
]);

export function isEngineErrorCode(value: unknown): value is EngineErrorCode {
  return typeof value === 'string' && ENGINE_ERROR_CODES.has(value);
}

export function isAbortError(value: unknown): boolean {
  if (value instanceof EngineError) return value.code === 'aborted';
  if (typeof value !== 'object' || value === null) return false;
  const name = 'name' in value && typeof value.name === 'string' ? value.name : '';
  return name === 'AbortError' || name === 'WllamaAbortError';
}

export function abortError(message = 'The operation was aborted.'): EngineError {
  return new EngineError('aborted', message);
}

export function toEngineError(value: unknown): EngineError {
  if (isEngineError(value)) return value;
  if (isAbortError(value)) return abortError();
  const message = value instanceof Error ? value.message : String(value);
  return new EngineError('unknown', message, { cause: value });
}

/** Localized UI copy is derived from an allowlist, never the API's or a transport's text. */
export type OpenAIErrorMessageKey =
  | (typeof OPENAI_ERROR_MESSAGES)[keyof typeof OPENAI_ERROR_MESSAGES]
  | 'openaiConnectionClosed'
  | 'openaiFailed';

export function openAIErrorMessageKey(value: unknown): OpenAIErrorMessageKey {
  if (!isEngineError(value)) return 'openaiFailed';
  if (value.code === 'offscreen-unavailable') return 'openaiConnectionClosed';
  return Object.hasOwn(OPENAI_ERROR_MESSAGES, value.code)
    ? OPENAI_ERROR_MESSAGES[value.code as keyof typeof OPENAI_ERROR_MESSAGES]
    : 'openaiFailed';
}
