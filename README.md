# otterm

**誰でも使えて、使う人ごとに育てられるターミナル。**

otterm は「ターミナルは難しい」という前提を捨てて設計する、まったく新しいターミナルエミュレータです。
初めてターミナルに触れる人には "黒い画面" ではなく "親切なアプリ" として、
毎日ターミナルで開発している人には "軽くて速くて、好きなだけ改造できる道具" として動きます。

ゲームの mod のように、**mod を 1 つ入れるだけで機能や見た目が足される**仕組みを中心に据えています。

名前は otter（カワウソ）+ term。ラッコがお腹の上で石を使って貝（shell）を割るように、
otterm はシェルを解きほぐして、使う人のそばに寄り添います。
画面の中にはラッコのキャラクター **ラコ**（海外名 **Kelp**）が住んでいて、案内役を務めます（詳細は [docs/08-character.md](docs/08-character.md)）。

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| [docs/00-overview.md](docs/00-overview.md) | コンセプト・ターゲット・差別化・やらないこと |
| [docs/01-requirements.md](docs/01-requirements.md) | 機能要件 / 非機能要件 / ユーザーストーリー |
| [docs/02-architecture.md](docs/02-architecture.md) | 技術スタック・プロセス構成・レイヤ設計 |
| [docs/03-core-features.md](docs/03-core-features.md) | コア機能の詳細仕様（PTY、入力補助、ファイル操作、コマンドパレット 等） |
| [docs/04-ui-theme.md](docs/04-ui-theme.md) | UI 構成・テーマ・レイアウト改造の仕様 |
| [docs/05-mod-system.md](docs/05-mod-system.md) | mod システムの仕様（マニフェスト、API、権限、配布） |
| [docs/06-config-keybind.md](docs/06-config-keybind.md) | 設定ファイル・キーバインドの仕様 |
| [docs/07-roadmap.md](docs/07-roadmap.md) | マイルストーンと開発ロードマップ |
| [docs/08-character.md](docs/08-character.md) | キャラクター「ラコ」の仕様（デザイン、表情と状態、登場画面、着せ替え mod） |
| [docs/09-performance.md](docs/09-performance.md) | 性能戦略（遅延の予算、レンダラ差し替え、ベンチマークと CI ゲート） |
| [docs/10-ai-assist.md](docs/10-ai-assist.md) | AI 補助の仕様（3 層構造、機能、送信内容の扱い、ラコとの統合） |
| [docs/11-decisions.md](docs/11-decisions.md) | 判断一覧（未決事項の選択肢と推奨、決定の記録） |
| [drafts/](drafts/README.md) | 型・スキーマによる設計下書き（`@otterm/api` 型定義、辞書スキーマと見本、設定の Rust 構造体） |

## 状態

仕様策定フェーズ。実装はまだありません。

## ライセンスと開発方針

- 本体: Apache-2.0。mod SDK（`@otterm/api`）: MIT。ラコの画像: 独自のキャラクターガイドライン（[docs/08-character.md](docs/08-character.md)）
- リポジトリは最初から公開。コード、コメント、コミットメッセージ、Issue は英語。仕様書は日本語を正とし、公開時に README と概要の英語版、M3 までに残りの英語版を用意する。mod 作者ガイドは最初から英語で書く
- リリースは v1.0 まで月 1 のプレリリース、以降は 6 週間ごとのマイナーリリースと随時のパッチ。更新チャネルは stable と beta
- テレメトリは持たない。サーバーも持たない
