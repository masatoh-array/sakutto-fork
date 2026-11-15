# BYOK 翻訳: 個人用 fork の開発メモ

## 目的と境界

GPU が弱い PC でも使えるよう、既存のローカル翻訳に OpenAI API キー方式を追加する。
既存の PLaMo と Chrome 内蔵 Translator API の経路は維持する。後者は Google Cloud
Translation API とは異なる。既定の動作はローカル方式のままとし、クラウドを明示選択した
場合だけ翻訳文を送信する。汎用プロバイダー基盤への作り直しは行わない。

作業ブランチは `dot/byok-translation`。既存ブランチへの commit/push やマージは行わない。
このファイルは中断後の再開用。実装・検証の完了状態は末尾に記録する。

## 設定と使い方

改造版をビルドし、`chrome://extensions` の「パッケージ化されていない拡張機能を読み込む」から
`.output/chrome-mv3` を読み込む。本家のストア版ではこの機能は使えない。
通常のビルドに必要な wllama の準備は [BUILDING.md](BUILDING.md) を参照する。

1. 拡張機能の設定画面で「翻訳エンジン / Translation provider」を開く。
2. 「OpenAI API（自分のAPIキー）」にキーとモデル ID を入力する。
   既定のモデル ID は `gpt-4.1-mini`。利用可能なモデルは API アカウントの権限に依存する。
3. 送信内容・課金の説明を読み、「送信・課金を理解してOpenAIを有効化」を押す。
   表示される OpenAI 接続の任意ホスト権限を許可する。
4. ページ・選択範囲・手入力の翻訳を行う。設定済みのサイト自動翻訳にも OpenAI が使われる。
5. ローカル方式を使うときは「ローカルに戻す」を押す。
   「キーを削除」はキーだけを削除し、ローカルへ自動切替はしない。

ブラウザ再起動・拡張機能再読み込み後はキーを再入力する。エラー時に勝手に別の方式へ切り替えず、
自動再試行もしない。1 セグメントにつき 1 API リクエストのため、長いページは呼び出し数が増える。
1 リクエストは 25 秒で打ち切る。まず短い選択範囲で動作と利用量を確認する。

## 認証方式の判断

### OpenAI API キー

最初の実装対象。OpenAI の公開 Responses API を使う。API キーは ChatGPT の契約とは別の
認証情報で、API の利用料金・上限も別に管理する。ChatGPT の月額契約だけで API 呼び出しが
無料になるという意味ではない。ユーザー自身が拡張機能の設定画面に入力する。

- API キーを通常の設定、同期ストレージ、ページ側スクリプトへ渡さない。
- API 呼び出しはバックグラウンド側に隔離する。
- セッション限定保存を使い、ブラウザ再起動後は再入力する設計とする。
- キー、認証ヘッダー、ページ本文を診断ログやリポジトリに記録しない。
- 実通信ではページ本文・選択テキスト・手入力などの翻訳対象、周辺文脈、該当する用語集が OpenAI に送られる。
  機密情報を含むページはローカル方式を選ぶ。
- 自動再試行をせず、ローカルの事前ウォームアップをクラウド呼び出しへ転用しない。
  ページ翻訳では既存の表示範囲周辺の先読みが働くため、選択範囲翻訳より呼び出しが増える。

ブラウザ内の保存は秘密管理サーバーと同じ安全性を意味しない。個人利用を前提とし、
API 側の利用上限設定と、不要になったキーの失効も行う。
[OpenAI API キーの公式案内](https://developers.openai.com/api/docs/guides/api-keys)

### Sign in with ChatGPT: 未実装

2026-11-15 に確認した公式仕様では、オープンソースアプリが対応する ChatGPT Plus/Pro の
利用枠を OAuth で使う方式がある。「外部アプリでは絶対に利用できない」わけではない。
ただし、公開されたフローは HTTP loopback コールバック、動的クライアント登録、PKCE、
state/nonce 検証、トークン管理を必要とする。

拡張機能だけの `chrome.identity` コールバックに置き換えられるとは確認できていない。
**実装上の判断**として、公式フローに沿うには小さなローカル補助プロセスが必要になる
可能性が高い。個人用の最小変更という今回の目的から、まず API キー方式を実装する。
認証済みセッションの非公開トークンを流用する方法は採らない。

再開時は公式仕様を再確認する:
[Quickstart](https://developers.openai.com/siwc/quickstart) /
[登録とサインイン](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) /
[公式 Electron 実装例](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)

### Microsoft 365 Copilot: 未実装

Copilot Chat API はプレビューで提供されるが、通常の Microsoft 365 契約だけでは足りず、
Microsoft 365 Copilot の追加ライセンスが必要。個人 Microsoft アカウントではなく、
職場・学校アカウントの委任アクセスを使う。アプリ登録とテナント側の同意も確認が必要。

翻訳だけに対して広い Graph 権限を要求する点が導入判断になる。現行の chat エンドポイントは
`Sites.Read.All`、`Mail.Read`、`People.Read.All`、`OnlineMeetingTranscript.Read.All`、
`Chat.Read`、`ChannelMessage.Read.All`、`ExternalItem.Read.All` を要求している。
ライセンス・権限の確認なしに、サインインすれば使える選択肢として表示しない。

[概要とライセンス](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/overview) /
[chat エンドポイントと必要権限](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/copilotconversation-chat)

## 開発・検証・再開手順

1. `git status` と現在のブランチを確認する。既存の未コミット作業を保持する。
2. このメモと差分を読み、OpenAI 経路の設定、バックグラウンド処理、UI の状態を確認する。
3. `pnpm install` 後、`pnpm typecheck`、`pnpm lint`、`pnpm test` を実行する。
   OpenAI のテストはモックを使用し、実キーや実通信を前提にしない。
4. モデル取得なしの UI 検証と、実モデルを含む製品ビルドを区別する。
   通常の `pnpm build` は wllama 成果物の検証を要求する。必要な準備は
   [BUILDING.md](BUILDING.md) を参照する。テスト用の偽エンジンを実用成果物として渡さない。
5. 手動検証では、ローカル方式の継続利用、OpenAI の明示選択、キー未設定時の案内、
   キー削除、ブラウザ再起動、エラー表示、ページ・選択・手入力の各経路を確認する。
6. commit 前に差分と追加ファイルを確認する。キー・トークン・個人ページ本文・認証付き
   URL を含めない。実通信未検証なら、その事実を結果報告に残す。

## 作業状態

- 認証方式の調査: 完了。上記は公式文書の仕様と実装上の判断を区別して記載した。
- OpenAI API キー方式: 初期実装済み。バックグラウンドで Responses API を呼び、ローカルエンジン・翻訳キャッシュを迂回する。
- `pnpm typecheck`: エラー・警告なし。`pnpm lint`: 成功。
- `pnpm bench:build:mock`: 成功。ただし偽エンジンを含むテスト用ビルドであり、実用配布物ではない。
- 単体テスト: 全 629 件中 **627 件成功、2 件失敗**。ファイル単位では 77 件中 75 件成功。
  失敗は既存ベースラインでも再現する `release.test` / `bench-fixtures` の 2 件のみ。
  今回変更したプライバシー文書の見出し契約を含め、追加・関連テストは成功。
- `pnpm build`: ピン留めされた wllama 成果物・manifest がなく未完了。この環境には Docker もない。
- 実ブラウザ検証: 未完了。テスト用 Chromium のダウンロードに問題があり、システム Chromium も
  ローカルソケットの権限制約により起動できなかった。
- 秘密情報: 変更ファイルのパターン検査を実施。実キーは取得・使用していない。
- ChatGPT / Microsoft 365 サインイン: 未実装。
- 実 API キーを使った翻訳: 未検証。
