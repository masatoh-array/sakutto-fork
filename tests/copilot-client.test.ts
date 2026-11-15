import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { CopilotClient, COPILOT_SCOPES, copilotHttpError } from '@/engine/copilot/client';
const id = '00000000-1111-2222-3333-444444444444';
const redirect = 'https://extension-test.chromiumapp.org/';
const token = 'mock-token-not-a-real-credential';
function tokenResponse(extra = {}) {
  return new Response(
    JSON.stringify({
      token_type: 'Bearer',
      access_token: token,
      expires_in: 3600,
      scope: COPILOT_SCOPES.join(' '),
      ...extra,
    }),
  );
}
function setup(callback?: (url: URL) => string | Promise<string>) {
  const identity = {
    getRedirectURL: () => redirect,
    launchWebAuthFlow: vi.fn(async ({ url }: { url: string; interactive: boolean }) =>
      callback
        ? callback(new URL(url))
        : `${redirect}?code=fake-code&state=${new URL(url).searchParams.get('state')}`,
    ),
  };
  return { client: new CopilotClient(identity), identity };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('isolated Copilot client', () => {
  it('uses PKCE state and exact fixed authority without secret, refresh or identity scopes', async () => {
    const { client, identity } = setup();
    const fetchMock = vi.fn(async () => tokenResponse());
    vi.stubGlobal('fetch', fetchMock);
    await client.signIn(id, id);
    const auth = new URL(identity.launchWebAuthFlow.mock.calls[0]![0].url);
    expect(auth.origin).toBe('https://login.microsoftonline.com');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('state')!.length).toBeGreaterThanOrEqual(43);
    expect(auth.searchParams.get('scope')).not.toMatch(/offline_access|openid/);
    const [url, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://login.microsoftonline.com/${id}/oauth2/v2.0/token`);
    expect(request).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
    const body = request.body as URLSearchParams;
    expect(body.has('client_secret')).toBe(false);
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')!)),
    );
    expect(Buffer.from(digest).toString('base64url')).toBe(auth.searchParams.get('code_challenge'));
    expect(client.connected).toBe(true);
    expect(JSON.stringify(client)).not.toContain(token);
    client.disconnect();
    expect(client.connected).toBe(false);
  });
  it.each([
    'https://evil.test/?code=123&state=correct',
    `${redirect}?code=123&state=wrong`,
    `${redirect}?code=123&state=correct&state=correct`,
    `${redirect}other?code=123&state=correct`,
  ])('rejects callback %s before token request', async (value) => {
    const { client } = setup((url) => value.replaceAll('correct', url.searchParams.get('state')!));
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    await expect(client.signIn(id, id)).rejects.toThrow('認証応答');
    expect(network).not.toHaveBeenCalled();
  });
  it('rejects invalid app/tenant without launching sign in', async () => {
    const { client, identity } = setup();
    await expect(client.signIn('https://evil.test', id)).rejects.toThrow('ID');
    expect(identity.launchWebAuthFlow).not.toHaveBeenCalled();
  });
  it('discards sign in completed after disconnect', async () => {
    let finish!: (url: string) => void;
    let auth!: URL;
    const { client } = setup((url) => {
      auth = url;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const signing = client.signIn(id, id);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    client.disconnect();
    finish(`${redirect}?code=123&state=${auth.searchParams.get('state')}`);
    await expect(signing).rejects.toThrow('キャンセル');
    expect(network).not.toHaveBeenCalled();
    expect(client.connected).toBe(false);
  });
  it.each([
    { scope: 'Mail.Read' },
    { token_type: 'Basic' },
    { expires_in: 0 },
    { access_token: '' },
  ])('rejects invalid/insufficient token response %j', async (extra) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tokenResponse(extra)),
    );
    const { client } = setup();
    await expect(client.signIn(id, id)).rejects.toThrow();
    expect(client.connected).toBe(false);
  });
  it('creates fresh conversations and disables web grounding on every translation', async () => {
    const network = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ id })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ text: 'prompt' }, { text: '翻訳' }] })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ text: 'prompt' }, { text: '二度目' }] })),
      );
    vi.stubGlobal('fetch', network);
    const { client } = setup();
    await client.signIn(id, id);
    expect(await client.translate('hello', 'ja')).toBe('翻訳');
    expect(await client.translate('again', 'ja')).toBe('二度目');
    for (const n of [1, 3])
      expect(network.mock.calls[n]![0]).toBe(
        'https://graph.microsoft.com/beta/copilot/conversations',
      );
    for (const n of [2, 4]) {
      const request = network.mock.calls[n]![1] as RequestInit;
      expect(request).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
      expect(JSON.parse(request.body as string)).toMatchObject({
        contextualResources: { webContext: { isWebEnabled: false } },
        locationHint: { timeZone: 'Etc/UTC' },
      });
    }
  });
  it.each([401, 403, 404, 429, 500])(
    'sanitizes service HTTP %s without retries',
    async (status) => {
      const network = vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response(`private text ${token}`, { status }));
      vi.stubGlobal('fetch', network);
      const { client } = setup();
      await client.signIn(id, id);
      await expect(client.translate('hello', 'ja')).rejects.not.toThrow(token);
      expect(network).toHaveBeenCalledTimes(2);
      if (status === 401) expect(client.connected).toBe(false);
    },
  );
  it('does not claim 403 proves missing license', () =>
    expect(copilotHttpError(403).message).toContain('判別できません'));
  it('does not translate expired tokens or empty text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => tokenResponse()),
    );
    const { client } = setup();
    await client.signIn(id, id);
    await expect(client.translate('', 'ja')).rejects.toThrow('文字');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600_000);
    await expect(client.translate('hi', 'ja')).rejects.toThrow('期限切れ');
    vi.restoreAllMocks();
  });
  it('discards output arriving after disconnect', async () => {
    let finish!: (response: Response) => void;
    const network = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ id })))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    vi.stubGlobal('fetch', network);
    const { client } = setup();
    await client.signIn(id, id);
    const result = client.translate('hi', 'ja');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    client.disconnect();
    finish(new Response(JSON.stringify({ messages: [{ text: 'hi' }, { text: 'secret' }] })));
    await expect(result).rejects.toThrow('キャンセル');
  });
  it('discards token body arriving after disconnect', async () => {
    let finish!: (value: unknown) => void;
    const response = {
      ok: true,
      json: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    const { client } = setup();
    const signing = client.signIn(id, id);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    client.disconnect();
    finish({
      token_type: 'Bearer',
      access_token: token,
      expires_in: 3600,
      scope: COPILOT_SCOPES.join(' '),
    });
    await expect(signing).rejects.toThrow('キャンセル');
    expect(client.connected).toBe(false);
  });
  it('rejects repeated sign in while an identity window is open', async () => {
    let finish!: (value: string) => void;
    const { client } = setup(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const signing = client.signIn(id, id);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await expect(client.signIn(id, id)).rejects.toThrow('処理中');
    client.disconnect();
    finish(redirect);
    await expect(signing).rejects.toThrow('キャンセル');
  });
  it('keeps Copilot out of page routes and renders output only in an extension textarea', () => {
    const ui = readFileSync('src/entrypoints/copilot/App.svelte', 'utf8');
    expect(ui).toMatch(/<textarea\s+value=\{output\}/);
    expect(ui).not.toContain('{@html');
    expect(ui).not.toMatch(/sendMessage|tabs\.query|executeScript|storage\./);
    expect(readFileSync('src/background/engine-client.ts', 'utf8')).not.toContain('copilot');
    expect(readFileSync('src/engine/copilot/client.ts', 'utf8')).not.toMatch(/storage\.|console\./);
  });
});
