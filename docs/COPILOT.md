# Microsoft 365 Copilot 実験版（隔離画面）

## 実装した範囲と重要な制約

設定内の **Microsoft 365 Copilot（実験版・別画面）** から専用画面を開き、文章を手動で貼り付けて翻訳します。既存のPLaMo・Chrome Translator・OpenAIのページ翻訳ルートは変更していません。**Copilotはページ全体を置換する翻訳プロバイダーにはしていません。**

Copilot Chat APIは組織内検索によるgroundingを使います。Web検索はリクエストごとに無効化できますが、組織内検索を無効にする公開パラメーターは確認できませんでした。悪意あるWebページの文章が指示として解釈され、利用者がアクセスできる組織情報を含む回答が生成された場合、その回答を元のページDOMへ戻すとサイトのスクリプトから読まれる危険があります。翻訳プロンプトだけではこの境界を守れません。

そのため、入力は手動貼り付け、出力は拡張機能自身のtextareaに限定しています。コンテンツスクリプトへの結果メッセージ、ページへの挿入、自動翻訳、HTML/Markdown/リンクの描画は行いません。結果を他の場所にコピーする前に内容を確認してください。これは安全性のための機能制限であり、元ページ内翻訳の完成版ではありません。

## 最初の設定

1. Microsoft 365 Copilot **追加ライセンス** がある職場・学校アカウントを用意します。通常のMicrosoft 365契約だけ、または個人Microsoftアカウントは対象外です。
2. 組織の規則に従ってEntraのアプリ登録を行います。自分の組織のアプリケーション（クライアント）IDとディレクトリ（テナント）IDを使います。クライアントシークレットは不要で、作成・保存・入力しません。
3. 専用画面に表示される `https://<extension-id>.chromiumapp.org/` を、アプリ登録の **SPAリダイレクトURI** として完全一致で登録します。拡張機能IDが変われば再登録が必要です。SPAコード交換のOrigin/CORS動作は実ブラウザでの検証が必要です。
4. Microsoft Graphの以下の**委任**権限をすべて登録します。必要な管理者の同意を組織の管理者から得てください。
   - `Sites.Read.All`
   - `Mail.Read`
   - `People.Read.All`
   - `OnlineMeetingTranscript.Read.All`
   - `Chat.Read`
   - `ChannelMessage.Read.All`
   - `ExternalItem.Read.All`
5. 専用画面に2つのIDを入力し、送信・権限・組織内検索・プレビュー利用条件を確認したうえでチェックを付け、サインインを押します。接続権限の許可とMicrosoftの認証・同意操作は利用者自身が行います。開発中にこれらの権限を付与したり、実アカウントにサインインしたりはしていません。
6. 文章を貼り付け、翻訳先を選んで送信します。初回の翻訳でCopilot APIが利用できるか確認されます。サインイン成功だけでライセンス確認済みとは扱いません。

APIのプレビュー利用条件への同意も必要です。Microsoftの公式ページから現行条件を確認してください。

## 認証・保存・情報送信

- OAuth authorization code + PKCE S256。暗号学的なランダムstateを完全一致検証し、リダイレクト先・重複パラメーターも検証します。
- トークンは専用画面内のJavaScript privateフィールドのメモリだけ。localStorage、IndexedDB、拡張機能storage.local/sync/sessionには一切保存しません。再読み込み・閉じる・接続解除で破棄します。OS侵害や拡張機能自身のコード実行に対する秘密保護までは保証しません。
- refresh tokenや`offline_access`は要求しません。トークン期限切れは再サインインが必要です。
- 接続先はMicrosoft公式の固定ホストだけ。リダイレクト追従なし、cookie送信なし、キャッシュなし。サービスの生エラー本文・トークン・原文はログやエラーメッセージに出しません。
- 翻訳ごとに新しいCopilot会話を作り、過去の会話は再利用しません。会話の作成および入力文の送信はMicrosoft側の保存・保持ポリシーに従います。接続解除はMicrosoft上の同意や会話履歴を削除しません。
- `locationHint.timeZone`には固定値`Etc/UTC`を送り、端末位置や実タイムゾーンを取得しません。
- 1回10,000文字まで。自動再試行はしません。接続解除で進行中のfetchを中止し、遅れて返った結果を表示しません。既にMicrosoftへ届いた処理を取り消せる保証はありません。

## エラーの伝え方

- 401: トークン失効・期限切れとして再サインインを案内します。
- 403: ライセンス・必須権限・管理者同意・組織ポリシーを確認するよう案内します。**403だけでライセンス不足と断定しません。**
- 429: 待って手動再試行するよう案内します。
- 404: 対象クラウドでの提供状況やプレビューAPIの変更を確認するよう案内します。
- OAuth失敗: キャンセル・登録設定・同意などを案内し、機密情報を含み得る生の応答は出しません。

## 検証と後日再開

モック単体テストではPKCE・state・redirect検証、スコープ不足、期限切れ、接続解除競合、再試行なし、エラー秘匿、固定宛先、新規会話、Web検索無効化、ページルートからの分離を確認します。実ライセンス・実認証・Graph通信・ブラウザUIは未検証です。実アカウントで成功することはまだ保証しません。

再開時は `src/engine/copilot/client.ts` と `src/entrypoints/copilot/App.svelte` を先に読み、`tests/copilot-client.test.ts` を実行してください。次は利用者自身によるEntra登録と実ブラウザ検証です。初回権限未許可、拒否、認証キャンセル、再読み込み、期限切れ、権限/ライセンス不足、成功、接続解除中の応答を確認してください。Copilotを通常ページのengine routeへ接続しないでください。

## 公式資料（2026-11-15確認）

- [Copilot Chat API概要・ライセンス・grounding・利用条件](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/overview)
- [会話作成と必須権限](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/copilotroot-post-conversations)
- [chatリクエストとレスポンス](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/copilotconversation-chat)
- [Microsoft authorization code flow / PKCE / SPA設定](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Chrome identity / launchWebAuthFlow](https://developer.chrome.com/docs/extensions/reference/api/identity)
