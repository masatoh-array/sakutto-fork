# BYOK の秘密情報保護

## 保存方針

API キーは `window.localStorage` / `sessionStorage`、IndexedDB、`chrome.storage.local` / `sync` に保存しない。Chrome の拡張機能専用 `storage.session` に、`TRUSTED_CONTEXTS` を明示した上で保持する。これは Web の `sessionStorage` とは別の API で、通常の閲覧ページやコンテンツスクリプトにキーを渡さない。読み出す前にもアクセス制限を設定し、設定に失敗したら読み出しを中止する。

Chrome は機密データについて session storage を推奨している。ブラウザ再起動・拡張機能の再読み込み等で消えるため、再入力は安全性との意図的なトレードオフ。OS の資格情報金庫のような暗号化保管庫ではない。キーと復号鍵を同じ拡張機能に保存する「暗号化」は、この脅威に対する解決策として採用しない。

## 防ぐ対象と境界

| 脅威                                 | 対策                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 閲覧ページの JavaScript / ページ XSS | キーはページの Web Storage・DOM・メッセージに置かない。API 通信はバックグラウンド側                                                          |
| コンテンツスクリプトの侵害           | キーの保存領域を trusted contexts に限定。通常設定・翻訳プロトコルにキーを含めない                                                           |
| 同期・設定エクスポートへの混入       | キーは session 専用。設定オブジェクトやリポジトリには保存しない                                                                              |
| 任意宛先へのキー転送                 | OpenAI の URL を固定。HTTPS、redirect:error、credentials:omit、cache:no-store。ページ指定の URL を fetch しない                              |
| エラーやデバッグ出力による漏洩       | サービスの生レスポンス本文を表示しない。キーをエラー文へ埋め込まない。エンジンのキーは JavaScript の private field で列挙・JSON 化からも除外 |
| 無効な入力                           | キーの制御文字・内部空白・異常な長さを拒否。拒否時も値を表示しない                                                                           |
| 削除・設定変更後のリクエスト継続     | 既存の中断処理で停止。ただし送信済み本文や発生済み課金は取り消せない                                                                         |

拡張機能自体の悪意ある改変、依存関係の侵害、同じ拡張機能の特権ページでの任意コード実行、ブラウザ/OS の侵害、デバッガやメモリダンプ、キーロガーまで防げるとは主張しない。実行中は通信のためキーがメモリ上に必要であり、JavaScript の文字列を確実にゼロ消去する保証もない。端末を共有しないこと、疑わしい場合は提供元でキーを失効させることが必要。

ページの `localStorage` と拡張機能オリジンの `localStorage` は同じものではない。しかしコンテンツスクリプトから Web Storage を使うと閲覧ページ側のストレージになるため、この用途ではいずれも利用しない。

## 開発時の確認

- `tests/openai-credentials.test.ts`: trusted 設定失敗時の読み出し/保存禁止、local/sync 未使用、削除、不正入力。
- `tests/openai-engine.test.ts`: 固定送信先・リダイレクト禁止・エラー抑制などと、キーの非列挙性。
- `tests/engine-client.test.ts`: 設定変更・キー削除による中断など。
- これらはモックテスト。実ブラウザの隔離・API 実通信を実証したものではない。ブラウザ試験は環境の起動制約で未実施。
- 実キーや OAuth トークンはテスト fixture、スクリーンショット、ログ、コミットに入れない。

## 一次資料（2026-11-15 確認）

- [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage): session のメモリ保持、アクセス範囲、Web Storage との相違。
- [Chrome: Stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure): HTTPS、最小権限、バックグラウンドでの機密処理、コンテンツスクリプトを信頼しない設計。
- [Chrome: Storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies): コンテンツスクリプトの Web Storage はホストページ側。
