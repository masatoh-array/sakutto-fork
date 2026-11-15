<script lang="ts">
  import { onDestroy } from 'svelte';
  import { browser } from 'wxt/browser';
  import {
    CopilotClient,
    CopilotError,
    COPILOT_ORIGINS,
    COPILOT_SCOPES,
  } from '@/engine/copilot/client';
  // identity is optional: do not read its namespace before the user grants permission.
  const redirect = `https://${browser.runtime.id}.chromiumapp.org/`;
  const client = new CopilotClient({
    getRedirectURL: () => browser.identity.getRedirectURL(),
    launchWebAuthFlow: (details) => browser.identity.launchWebAuthFlow(details),
  });
  let clientId = $state('');
  let tenantId = $state('');
  let consent = $state(false);
  let connected = $state(false);
  let busy = $state(false);
  let source = $state('');
  let output = $state('');
  let target = $state('ja');
  let message = $state('');
  let generation = 0;
  onDestroy(() => {
    client.disconnect();
    source = '';
    output = '';
  });
  function disconnect() {
    generation++;
    client.disconnect();
    connected = false;
    source = '';
    output = '';
    message =
      'この画面のトークンと文章を破棄しました。Microsoft側の同意・会話履歴は削除されません。';
  }
  async function signIn() {
    if (busy || !consent) return;
    const turn = generation;
    busy = true;
    message = '';
    try {
      const allowed = await browser.permissions.request({
        permissions: ['identity'],
        origins: COPILOT_ORIGINS,
      });
      if (turn !== generation) return;
      if (!allowed) {
        message = '接続権限が許可されませんでした。';
        return;
      }
      await client.signIn(clientId.trim(), tenantId.trim());
      if (turn !== generation) {
        client.disconnect();
        return;
      }
      connected = client.connected;
      message = 'サインインしました。ライセンスとCopilot API利用権限は最初の翻訳で確認されます。';
    } catch (error) {
      if (turn === generation)
        message = error instanceof CopilotError ? error.message : '接続できませんでした。';
    } finally {
      busy = false;
    }
  }
  async function translate() {
    if (busy || !consent) return;
    busy = true;
    output = '';
    message = '';
    const turn = generation;
    try {
      const result = await client.translate(source, target);
      if (turn === generation) output = result;
    } catch (error) {
      if (turn === generation)
        message = error instanceof CopilotError ? error.message : '翻訳できませんでした。';
    } finally {
      connected = client.connected;
      busy = false;
    }
  }
</script>

<main>
  <h1>Microsoft 365 Copilot 翻訳（実験版・別画面）</h1>
  <p>
    ページ全体の翻訳ではありません。文章をここへ貼り付けて翻訳します。結果はこの拡張機能の画面だけに表示し、元のWebサイトには送りません。
  </p>
  <p role="note">
    Copilotは組織内の情報を参照できるため、悪意ある原文によって組織情報を含む回答が返る可能性があります。Web検索は無効にしますが、組織内検索を無効にする保証はありません。結果を他のサイトへ貼り付ける前に内容を確認してください。
  </p>
  <details>
    <summary>最初に必要な設定（Entraアプリ登録）</summary>
    <ol>
      <li>
        Microsoft 365
        Copilot追加ライセンスのある職場・学校アカウントを使います。個人用Microsoftアカウントは対象外です。
      </li>
      <li>
        組織で許可されたEntraアプリを登録し、SPAのリダイレクトURIに次をそのまま登録します。クライアントシークレットは作らず、入力しません。
      </li>
    </ol>
    <p><code>{redirect}</code></p>
    <p>
      下記7つのMicrosoft
      Graph委任アクセス許可を登録し、組織で必要な管理者の同意を得てください。登録や権限の付与はこの画面では自動実行しません。拡張機能IDが変わるとリダイレクトURIの再登録が必要です。
    </p>
  </details>
  <label
    >アプリケーション（クライアント）ID<input
      bind:value={clientId}
      disabled={busy || connected}
      autocomplete="off"
      spellcheck="false"
    /></label
  >
  <label
    >ディレクトリ（テナント）ID<input
      bind:value={tenantId}
      disabled={busy || connected}
      autocomplete="off"
      spellcheck="false"
    /></label
  >
  <p>要求する権限（翻訳専用の狭い権限ではありません）:</p>
  <ul>
    {#each COPILOT_SCOPES as scope (scope)}<li><code>{scope}</code></li>{/each}
  </ul>
  <p>
    サイト・メール・人物・会議文字起こし・チャット・チャネルメッセージ・外部項目の読み取りに関係する権限です。組織の承認なしで利用しないでください。入力文はMicrosoftへ送られ、Copilotの会話として保存される可能性があります。
  </p>
  <p>
    この機能はプレビューAPIを使います。<a
      href="https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/overview"
      target="_blank"
      rel="noopener noreferrer">Microsoftの仕様と利用条件</a
    >を確認してください。実アカウントでの動作は未検証です。
  </p>
  <label class="consent"
    ><input
      type="checkbox"
      bind:checked={consent}
      disabled={busy || connected}
    />送信先・広いアクセス権・組織内検索・プレビュー利用条件を確認し、利用に同意します</label
  >
  <button disabled={busy || connected || !consent} onclick={signIn}>Microsoftにサインイン</button>
  <button onclick={disconnect}>接続解除・文章を消去</button>
  <p>
    接続: {connected
      ? 'この画面のメモリ内のみ'
      : '未接続'}。画面を閉じる／再読み込みすると再サインインが必要です。トークンをブラウザストレージへ保存しません。
  </p>
  <label
    >翻訳先<select bind:value={target} disabled={busy}
      ><option value="ja">日本語</option><option value="en">English</option><option value="zh"
        >中文</option
      ><option value="ko">한국어</option><option value="fr">Français</option><option value="de"
        >Deutsch</option
      ><option value="es">Español</option></select
    ></label
  >
  <label
    >原文（最大10,000文字）<textarea
      bind:value={source}
      maxlength="10000"
      rows="8"
      disabled={busy}
      spellcheck="false"
      autocomplete="off"></textarea></label
  >
  <button disabled={busy || !connected || !source.trim() || !consent} onclick={translate}
    >Microsoftへ送信して翻訳</button
  >
  {#if busy}<p role="status">処理中です。接続解除で結果の受け取りをキャンセルできます。</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  <label
    >結果（機密情報が混入していないか確認してください）<textarea
      value={output}
      readonly
      rows="10"
      spellcheck="false"></textarea></label
  >
</main>

<style>
  main {
    max-width: 760px;
    margin: 24px auto;
    padding: 20px;
    font:
      14px/1.7 system-ui,
      sans-serif;
  }
  h1 {
    font-size: 23px;
  }
  label {
    display: grid;
    margin: 14px 0;
    gap: 6px;
  }
  label.consent {
    display: block;
  }
  input:not([type='checkbox']),
  textarea,
  select {
    font: inherit;
    padding: 8px;
    box-sizing: border-box;
    width: 100%;
  }
  button {
    padding: 9px 14px;
    margin: 6px 8px 6px 0;
  }
  code {
    overflow-wrap: anywhere;
  }
  p[role='note'] {
    border-left: 4px solid #b56b00;
    padding: 10px;
    background: #fff4db;
    color: #342100;
  }
</style>
