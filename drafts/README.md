# drafts/ — 型・スキーマによる設計下書き

文章の仕様書（`docs/`）を、型定義とスキーマで検証するための下書き。
まだビルドもテストもしない。M0 でリポジトリを初期化するときに、下の「配置先」へ移す。

| ファイル | 内容 | 配置先（M0 以降） | 対応する仕様 |
| --- | --- | --- | --- |
| [api/index.d.ts](api/index.d.ts) | `@otterm/api` の型定義。ModContext の全名前空間、宣言的 UI 18 種、イベント、マニフェスト | `packages/api/src/index.d.ts` | [docs/05-mod-system.md](../docs/05-mod-system.md)、[08](../docs/08-character.md)、[10](../docs/10-ai-assist.md) |
| [api/example-git-status-bar.ts](api/example-git-status-bar.ts) | 型定義を使った mod の見本（05 の例を完成させたもの） | `packages/create-mod/templates/extension/src/main.ts` | 05 §5 |
| [schemas/dictionary.schema.json](schemas/dictionary.schema.json) | コマンド辞書の JSON Schema | `packages/api/schemas/dictionary.schema.json` | [docs/03-core-features.md](../docs/03-core-features.md) §8.1 |
| [dictionary/commands/*.json](dictionary/commands/) | 164 コマンド（coreutils 系 61、パッケージ管理 36、Windows / PowerShell 34、ランタイム・開発ツール 27、git、docker、kubectl、helm、terraform、ngrok）。サブコマンド 450、エラー助言 813、危険マーク 117 | `mods/dictionary-core/dictionary/commands/` | 03 §8.1、§8.3、§8.4 |
| [scripts/validate-dictionary.js](scripts/validate-dictionary.js) | 辞書の検証スクリプト（スキーマ準拠、日英の両方があるか、危険マークにメッセージがあるか、正規表現がコンパイルできるか、`{name}` がグループと一致するか）。`node drafts/scripts/validate-dictionary.js .` | `tests/dictionary/` と CI | 03 §8.1 |
| [locales/ja.ftl](locales/ja.ftl) / [en.ftl](locales/en.ftl) | ラコの台詞と UI 文言（Fluent 形式、約 170 メッセージ） | `packages/ui/locales/`、`mods/otterm.mascot/locales/` | 08 §5 |
| [dictionary/rules/core.json](dictionary/rules/core.json) | コマンド横断の危険ルール（`curl | sh`、fork bomb など） | `mods/dictionary-core/dictionary/rules/` | 03 §8.3 |
| [config/schema.rs](config/schema.rs) | 設定の Rust 構造体。`serde` + `schemars` で JSON Schema を生成する前提 | `crates/otterm-config/src/schema.rs` | [docs/06-config-keybind.md](../docs/06-config-keybind.md) |

## 書き方の規約

- コードとコメントは英語（判断 A5）。この README と `docs/` は日本語
- 辞書データの文字列は `{ "ja": "...", "en": "..." }` の **インライン多言語**。UI とラコの台詞は Fluent（判断 C7）だが、辞書はコミュニティが 1 ファイルずつ書くものなので、翻訳キーを別ファイルに分けると書きにくい
- 型定義の中で仕様と食い違いを見つけたら、**型を正として docs を直す**。型の方が曖昧さがないため

## この下書きで検証したこと

1. 05 の API 表にあった全メソッドが、矛盾なく 1 つの `ModContext` に収まるか → 収まった。ただし `ctx.events` と `ctx.workspace` が表に漏れていたので追加した
2. 宣言的 UI の 18 種に、ファイルツリー・履歴 UI・設定画面を同梱 mod として作るのに足りるか → `tree` に遅延読み込みとドラッグ、`table` にソートと選択、`list` に仮想スクロールの指定が必要だったので props に足した
3. 辞書 1 つで cmd-explain（説明）、completion（補完）、danger-guard（危険判定）、error-hint（エラー助言）の 4 つが動くか → `options[].danger` と `errors[]` を持たせることで 1 ファイルで賄えた。コマンド横断の危険ルール（`curl | sh` など）だけは `rules/*.json` に分けた
4. 06 の `config.toml` が Rust の型にそのまま落ちるか → `completion.key = "auto"` のような「auto か具体値」の列挙が複数あり、共通の `Auto<T>` 型にした。`[workspace]` はユーザー設定とは別ファイルなので別構造体にした。`[keybindings]` は「アクション ID → キー（1 つか配列）」と `[[keybindings.custom]]` の 2 形式が混在していたので、構造体では `bindings` と `custom` に分けた（06 を修正する）

## docs への反映が必要になった点

- 05 §5.2 の表に `ctx.events`、`ctx.workspace`、`ctx.ui.pickPath`、`ctx.assist.parse` を追加する
- 06 §2 の `[keybindings]` を `bindings` / `custom` の 2 階層に書き直す
- 03 §8.1 に「辞書の文字列はインライン多言語、UI は Fluent」の使い分けを追記する
