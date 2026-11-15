<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { browser } from 'wxt/browser';
  import { hasOpenAIKey, OPENAI_ORIGIN, saveOpenAIKey } from '@/engine/openai/credentials';
  import type { Settings, SettingsPatch } from '@/shared/settings';

  let { settings, onChange }: { settings: Settings; onChange: (patch: SettingsPatch) => void } =
    $props();
  let key = $state('');
  let present = $state(false);
  let model = $state(untrack(() => settings.openaiModel));
  let busy = $state(false);
  let message = $state('');
  onMount(() => {
    void hasOpenAIKey()
      .then((value) => {
        present = value;
      })
      .catch(() => {
        message = 'キーの状態を確認できません。';
      });
  });

  async function enable() {
    if (busy) return;
    message = '';
    if (!key.trim() && !present) {
      message = 'OpenAI APIキーを入力してください。';
      return;
    }
    if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(model.trim())) {
      message = 'モデルIDを確認してください。';
      return;
    }
    busy = true;
    try {
      // Must stay in the click handler: this is an explicit optional host permission.
      const allowed = await browser.permissions.request({ origins: [OPENAI_ORIGIN] });
      if (!allowed) {
        message = 'OpenAIへの接続は許可されませんでした。';
        return;
      }
      if (key.trim()) await saveOpenAIKey(key);
      key = '';
      present = await hasOpenAIKey();
      onChange({ translationProvider: 'openai', openaiModel: model.trim() });
      message = 'キーをこのブラウザセッションに保存しました。';
    } catch {
      message = '設定できませんでした。もう一度お試しください。';
    } finally {
      busy = false;
    }
  }

  async function clear() {
    try {
      await saveOpenAIKey('');
      key = '';
      present = false;
      message = 'キーを削除しました。OpenAIの翻訳は停止し、ローカルへ自動切替はしません。';
    } catch {
      message = 'キーを削除できませんでした。';
    }
  }
</script>

<fieldset>
  <legend>翻訳エンジン / Translation provider</legend>
  <p>
    現在: {settings.translationProvider === 'openai'
      ? 'OpenAI API'
      : 'ローカル（PLaMo / Chrome Translator）'}
  </p>
  <button
    type="button"
    disabled={busy || settings.translationProvider === 'local'}
    onclick={() => onChange({ translationProvider: 'local' })}>ローカルに戻す</button
  >
  <details open={settings.translationProvider === 'openai'}>
    <summary>OpenAI API（自分のAPIキー）</summary>
    <p>
      有効化すると、翻訳対象の文章・周辺文脈・用語集をOpenAIへ送信します。自動翻訳を設定済みのサイトにも適用され、API利用料が発生します。ChatGPTの月額料金とは別です。機密情報を含むページでは使用しないでください。
    </p>
    <label
      >APIキー {present ? '（セッション内に保存済み）' : '（未設定）'}
      <input
        type="password"
        bind:value={key}
        autocomplete="off"
        spellcheck="false"
        placeholder={present ? '変更する場合のみ入力' : 'OpenAI API key'}
      />
    </label>
    <label>モデルID<input bind:value={model} autocomplete="off" spellcheck="false" /></label>
    <p>
      キーはこのブラウザセッションのみ保存します。再起動・拡張機能の再読み込み後は再入力してください。端末間同期やページへのキー送信は行いません。
    </p>
    <button type="button" disabled={busy} onclick={enable}
      >送信・課金を理解してOpenAIを有効化</button
    >
    <button type="button" disabled={busy || !present} onclick={clear}>キーを削除</button>
  </details>
  {#if message}<p role="status">{message}</p>{/if}
</fieldset>

<style>
  fieldset {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px;
  }
  legend,
  summary {
    font-weight: 600;
    font-size: 12px;
  }
  p {
    font-size: 11px;
    line-height: 1.6;
    margin: 8px 0;
  }
  label {
    display: grid;
    gap: 4px;
    font-size: 11px;
    margin: 8px 0;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 7px;
    color: var(--text);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  button {
    font-size: 11px;
    margin: 4px 0;
    padding: 6px;
  }
  details {
    margin-top: 8px;
  }
</style>
