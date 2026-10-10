# 05. mod システム仕様（Mod System）

## 1. 目的

- 「mod を 1 つ入れるだけで、otterm のどこかが便利になる／見た目が変わる」を実現する
- 作る側は TypeScript（または JavaScript）で、テンプレートから 30 分で動くものを作れる
- 入れる側は、何ができる mod なのか（権限）を見て安心して入れられる
- コアの同梱機能も同じ仕組みで作られているため、「公式にしかできないこと」がない

## 2. mod の種類（kind）

| kind | 内容 | コード必要？ |
| --- | --- | --- |
| `theme` | 配色・フォント・CSS 上書き | 不要（TOML / CSS のみ） |
| `layout` | Slot 配置・パネルの開閉状態のプリセット | 不要 |
| `dictionary` | コマンド説明・補完候補・危険ルール・エラー助言パターンの辞書 | 不要（JSON） |
| `workflows` | ワークフロー集 | 不要（TOML） |
| `outfit` | ラコの衣装・小物・色違い・台詞セット | 不要（TOML + 画像） |
| `extension` | 上記に加え、コードで UI・イベント・外部連携を実装する | 必要 |
| `pack` | 複数 mod + 推奨設定をまとめたもの | 不要 |

コード不要の mod が多数を占めるよう設計する。「テーマを作るのに JS を書く」ことがないようにする。

## 3. パッケージ構造

```
my-mod/
+- otmod.toml           # マニフェスト（必須）
+- README.md
+- icon.png             # 任意、128x128
+- dist/main.js         # extension のエントリ（ビルド済み、ESM 1 ファイル）
+- theme.toml           # theme のとき
+- layout.toml          # layout のとき
+- dictionary/          # dictionary のとき（複数 JSON 可）
+- workflows.toml       # workflows のとき
+- locales/ja.ftl       # 翻訳（任意、Fluent 形式。判断 C7）
+- assets/              # 画像等
```

### 3.1 マニフェスト `otmod.toml`

```toml
[mod]
id = "example.git-status-bar"     # <GitHub ユーザー名>.<名前>、小文字英数と - のみ。公開時に GitHub 認証で所有を確認（判断 D1）。otterm.* は公式のみ
name = "Git Status Bar"
version = "1.2.0"                  # semver
description = "ステータスバーに現在のブランチと変更数を表示します"
author = "example"
license = "MIT"
homepage = "https://github.com/example/otterm-git-status-bar"
kind = "extension"                 # theme | layout | dictionary | workflows | extension | pack
icon = "icon.png"

[compat]
otterm = ">=1.0.0 <2.0.0"          # 本体の互換範囲
api = "1"                          # API メジャーバージョン
platforms = ["windows", "macos", "linux"]

[entry]
main = "dist/main.js"              # extension のみ

# 何ができるようになるかの説明（ストアと権限画面に表示）
[[adds]]
slot = "statusbar.left"
label = "ブランチ名と変更数"

[[adds]]
command = "git-status-bar.refresh"
label = "ブランチ情報を更新"

# 権限（宣言していないものは一切呼べない）
[permissions]
process = ["git"]                  # 起動してよい実行ファイル名（ホワイトリスト）
fs.read = ["${cwd}/**"]            # 読み取り可能なパス（glob）
fs.write = []
network = []                       # 例: ["https://api.github.com/*"]
clipboard = false
ai = false                         # ユーザーが設定した AI プロバイダに問い合わせる（10-ai-assist.md）
terminal.read = true               # ブロックの出力・画面テキストを読む
terminal.write = false             # ターミナルに入力を書き込む（最重要の権限）
events = ["cwd-changed", "block-end"]

# mod が持つ設定（設定画面に自動でフォームが出る）
[settings.schema]
"show_dirty_count" = { type = "boolean", default = true, label = "変更数を表示する" }
"refresh_interval" = { type = "integer", default = 5, min = 1, max = 60, label = "更新間隔（秒）" }

[dependencies]
"otterm.dictionary-core" = ">=1.0.0"   # 他 mod への依存（任意）
```

## 4. ライフサイクル

```
discovered -> validated -> (permissions granted) -> loaded -> activated
                                                     ^           |
                                                     +-- deactivated <- disabled / uninstalled
```

| 段階 | 内容 |
| --- | --- |
| discovered | mod ディレクトリ（`~/.config/otterm/mods/<id>/`）とワークスペース内 `.otterm/mods/` を走査。**ワークスペース内の mod は自動では有効化せず、必ず権限一覧付きの確認を出す**。リポジトリを clone しただけで mod が動くことを防ぐ。`terminal.write` を持つものはワークスペース側では有効化できない（判断 D6） |
| validated | マニフェスト検証、互換性チェック、署名検証（レジストリ由来のみ必須） |
| permissions granted | 初回はユーザーに権限一覧を表示して承認。承認は `permissions.json` に保存。後から変更／取り消し可 |
| loaded | Worker を起動し、`main.js` を QuickJS 上で評価。`activate(ctx)` を呼ぶ |
| activated | イベント配信対象になる |
| deactivated | `deactivate()` を呼び、登録した UI・コマンドをすべて自動で撤去（mod 側の後片付け漏れを許容する） |

- 有効／無効の切替は再起動不要。Worker を破棄して作り直す
- クラッシュ（未処理例外、無応答 5 秒）した mod は自動で deactivated にし、ステータスバーに通知。3 回連続で落ちたら自動無効化

## 5. API（`@otterm/api`）

### 5.1 エントリ

```ts
import type { ModContext } from "@otterm/api";

export function activate(ctx: ModContext) {
  // 登録はすべて ctx を通して行う。戻り値の Disposable は ctx が追跡し、deactivate 時に自動解放
}

export function deactivate() {}
```

### 5.2 `ModContext` の主要メンバ

| 名前空間 | 主なメソッド | 権限 |
| --- | --- | --- |
| `ctx.ui.slot(slotName)` | `.add(component)`：Slot に UI を追加 | なし（宣言 `adds` が必要） |
| `ctx.ui.panel(...)` | サイドパネル／下パネルを登録（タイトル、アイコン、内容） | なし |
| `ctx.ui.toast(...)` / `ctx.ui.dialog(...)` | 通知・確認ダイアログ | なし |
| `ctx.ui.contextMenu(target)` | 右クリック項目を追加 | なし |
| `ctx.ui.pickPath(opts)` | OS のファイル／フォルダ選択ダイアログ。ユーザーが選んだパスは `fs.read` の glob に関わらず読める | なし |
| `ctx.assist.parse(line)` | 入力行をコマンド構造（名前・サブコマンド・オプション・引数）に分解 | なし |
| `ctx.events.emit / on` | mod 間メッセージ（`custom:<id>`） | なし |
| `ctx.workspace.current()` / `.onChanged(cb)` | 現在のワークスペース（名前、ルート、信頼済みか） | なし |
| `ctx.commands.register(id, handler, meta)` | コマンドパレット・キーバインド対象のコマンド | なし |
| `ctx.keybindings.suggest(...)` | 既定キーの提案（ユーザー設定が優先） | なし |
| `ctx.terminal.onInputChange(cb)` | 入力行の変化 | `terminal.read` |
| `ctx.terminal.onBeforeExecute(cb)` | 実行直前。`cancel()` / `replace(cmd)` / `confirm({...})` を返せる | `terminal.read` |
| `ctx.terminal.onBlockEnd(cb)` | ブロック確定（コマンド、出力、終了コード、CWD、所要時間） | `terminal.read` |
| `ctx.terminal.write(sessionId, text)` | ターミナルへ入力（**ユーザーに毎回トースト表示**） | `terminal.write` |
| `ctx.terminal.insert(text)` | 入力欄に挿入するだけ（実行しない） | なし |
| `ctx.terminal.screen(sessionId)` | 画面テキストの取得 | `terminal.read` |
| `ctx.session.current()` / `.onCwdChanged(cb)` / `.list()` | セッション情報 | なし |
| `ctx.assist.completions.provide(provider)` | 補完候補ソースを追加 | なし |
| `ctx.assist.explain.provide(provider)` | コマンド説明を追加 | なし |
| `ctx.assist.danger.addRules(rules)` | 危険ルールを追加 | なし |
| `ctx.assist.errorHints.provide(provider)` | エラー助言を追加 | なし |
| `ctx.links.addDetector(regex, handler)` | リンク検出ルール | なし |
| `ctx.fs.readText(path)` / `.readDir(path)` / `.writeText(...)` | ファイル操作 | `fs.read` / `fs.write` |
| `ctx.process.run(cmd, args, opts)` | 子プロセス実行（PTY ではない、ユーザーには見えない） | `process` |
| `ctx.http.fetch(url, init)` | HTTP | `network` |
| `ctx.clipboard.read()` / `.write()` | クリップボード | `clipboard` |
| `ctx.settings.get(key)` / `.onChange(cb)` | mod 自身の設定 | なし |
| `ctx.storage` | mod 専用の永続 KV（JSON、上限 10 MB） | なし |
| `ctx.theme.current()` / `.onChange(cb)` | 現在のテーマ・CSS 変数 | なし |
| `ctx.i18n.t(key)` | 翻訳 | なし |
| `ctx.log.*` | ログ（mod 開発者ツールに出る） | なし |
| `ctx.mascot.say(text, opts)` | ラコに吹き出しで話させる（mood・表示時間・ボタン付き） | なし |
| `ctx.mascot.setMood(mood)` / `.onMoodChanged(cb)` | 表情の一時変更／監視 | なし |
| `ctx.mascot.outfits.register(outfit)` | 衣装を登録（`outfit` kind の mod は自動登録） | なし |
| `ctx.mascot.reactions.add(rule)` | 「この条件のときラコがこう反応する」ルールを追加 | なし |

ラコ関連 API の詳細は [08-character.md](08-character.md) を参照。全メソッドの正確なシグネチャは型定義の下書き [drafts/api/index.d.ts](../drafts/api/index.d.ts) にあり、食い違う場合は型定義を正とする。

- すべての API は非同期（Promise）。Worker ↔ UI ↔ Rust の 3 ホップがあるため、同期 API は提供しない
- `terminal.write` は唯一「ユーザーの代わりにコマンドを実行できる」権限であり、承認画面で赤く強調する。既定では insert（入力欄に入れるだけ）を使うように SDK のドキュメントで誘導する

### 5.3 UI の書き方

mod は 2 つの方法で UI を作れる。

**A. 宣言的 UI（推奨）**

JSON ツリーを返すと、本体がテーマに従って描画する。テーマ追従・アクセシビリティ・キーボード操作が自動で保証される。

```ts
ctx.ui.slot("statusbar.left").add({
  type: "text",
  icon: "git-branch",
  text: () => state.branch,          // 関数を渡すとリアクティブに更新
  tooltip: "現在のブランチ",
  onClick: () => ctx.commands.run("git-status-bar.refresh"),
});

ctx.ui.panel({
  id: "git-status-bar.panel",
  title: "Git",
  icon: "git",
  slot: "sidebar.right",
  content: () => ({
    type: "stack",
    children: [
      { type: "heading", text: "変更ファイル" },
      { type: "list", items: state.files.map(f => ({ text: f.path, badge: f.status, onClick: () => open(f) })) },
      { type: "button", text: "すべてステージ", variant: "primary", onClick: stageAll },
    ],
  }),
});
```

対応コンポーネント（v1）: `text / heading / stack / row / list / tree / table / button / input / select / toggle / badge / progress / code / markdown / divider / spacer / sparkline / custom`

**B. サンドボックス iframe（自由描画）**

`type: "custom"` で HTML を渡す。`srcdoc` の iframe に描画され、`postMessage` で mod と通信する。テーマ変数は iframe 内にも注入される。ゲーム的な派手な UI や独自描画はこちら。

iframe の制限（判断 D7）:

- CSP: `default-src 'none'; style-src 'unsafe-inline' otmod:; img-src data: otmod:; font-src otmod:; media-src otmod:`
- `otmod:` スキームは **mod 自身のディレクトリ内のアセット**（画像、フォント、CSS、音声）だけを返す。外部 URL は読めない
- **iframe 内で JavaScript は実行できない**（`script-src` なし）。見た目は HTML / CSS で、ロジックは Worker 側に置き、`postMessage` でやり取りする。これにより iframe からの情報漏えい経路をなくす
- `allow-same-origin` を付けない。クリップボード・位置情報などの Permissions Policy はすべて拒否

### 5.4 イベント一覧

| イベント | ペイロード |
| --- | --- |
| `session-created` / `session-closed` | sessionId, profile |
| `cwd-changed` | sessionId, cwd |
| `input-changed` | sessionId, line, cursor |
| `before-execute` | sessionId, command（キャンセル／置換可） |
| `block-start` / `block-end` | block（command, exitCode, output, cwd, durationMs） |
| `output` | sessionId, chunk。`terminal.read` に加えてマニフェストの `events` に明示列挙が必要。承認画面で「ターミナルの全出力をリアルタイムに読みます」と警告する。配信は 1 秒ごとにまとめる（レート制限）。ログ監視系 mod 向け（判断 D11） |
| `title-changed` | sessionId, title |
| `theme-changed` | theme |
| `settings-changed` | key, value |
| `focus-changed` | sessionId |
| `custom:<id>` | mod 間メッセージ（`ctx.events.emit / on`） |

## 6. 権限モデル

### 6.1 原則

- **宣言なければ不可**。マニフェストにない権限の API はそもそも Worker に注入されない（存在しないので呼べない）
- **ユーザーが承認**。インストール時に一覧表示して承認。承認は mod のバージョンに紐づき、権限が増えた更新では再承認。**`terminal.write` と `clipboard`（読み取り）だけは、最初に実際に使われた瞬間にも確認する**（最も悪用されやすいため。判断 D5）
- **実行時にも検査**。`fs.read` の glob、`process` の実行ファイル名、`network` のホストは Rust 側のブローカーが毎回検査する
- **可視化**。ステータスバーの mod アイコンから「この mod が最近行ったこと」（プロセス起動、ネットワーク、書き込み）を確認できる

### 6.2 権限の表示例（承認画面）

```
Git Status Bar v1.2.0 は次のことを行います：
  [i] 現在のフォルダ以下のファイルを読む
  [i] git コマンドを実行する
  [i] ターミナルの出力を読む
この mod は ターミナルに入力を書き込みません / ネットワークに接続しません。
                                  [ 許可して有効化 ]  [ キャンセル ]
```

### 6.3 パス変数

`${cwd}`（現在セッションの CWD）、`${home}`、`${workspace}`、`${mod}`（mod 自身のディレクトリ）、`${data}`（mod 専用データ領域）

### 6.4 書き込みの保護リスト

`fs.write` の glob に含まれていても、次の場所への書き込みは常に拒否する（判断 K8）。

- otterm の設定フォルダとデータフォルダ（他の mod のデータを含む）
- `${home}` 直下のドットファイル（`~/.bashrc`、`~/.ssh/*`、`~/.gitconfig` など）。シェル統合の rc 追記は otterm 本体だけが行う
- OS のシステムディレクトリ
- 他の mod の `${mod}` ディレクトリ

これらに書きたい mod は、ユーザーに `ctx.ui.dialog` で保存先を選ばせる（ファイル保存ダイアログ経由なら許可される）。

## 7. 配布とインストール

### 7.1 ソース

| 方法 | コマンド／操作 |
| --- | --- |
| 公式レジストリ | 設定画面 → mod → 検索 → インストール。`otterm mod install example.git-status-bar` |
| Git | `otterm mod install https://github.com/user/repo`（タグ指定可） |
| ローカル | `otterm mod install ./path`（開発中はシンボリックリンク `--link`） |
| zip | ドラッグ&ドロップ、または `otterm mod install file.otmod`（拡張子 `.otmod` = zip）。検査（判断 K7）: 圧縮サイズ 50 MB、展開後 200 MB を上限。`../` を含むパスとシンボリックリンクは拒否。マニフェストの `entry` 以外の実行可能ファイルは無視 |
| URL ワンクリック | `otterm://install?source=registry&id=...` スキーム |

### 7.2 レジストリ

- **GitHub リポジトリ上の静的 JSON インデックス** + 配布物（GitHub Releases）で始め、サーバーレスで運用。検索はクライアント側で行う。1,000 mod を超えたら再検討（判断 D3）
- 公開: `otterm mod publish`。作者は GitHub アカウントで認証し、mod ID の名前空間と一致していることを確認
- 署名: **sigstore（キーレス署名）**。GitHub Actions からの公開と相性がよく、作者が鍵を管理しなくてよい。オフライン検証用に信頼ルートのバンドルを本体に同梱する（判断 D2）
- ストア画面: カテゴリ（テーマ／見た目、入力支援、Git、Docker、言語別、ワークフロー、ラコの衣装、楽しい）、スクリーンショット、権限一覧、インストール数、互換バージョン
- 更新: 起動時に確認、ユーザーが「更新」を押す（自動更新はオプトイン）
- モデレーション（判断 D4）: **権限で切り替える**。`terminal.write` か `network` を持つ mod は公開前に人の審査、それ以外は公開後の報告ベース。報告が一定数に達した mod は自動で非表示にし、審査に回す
- 有料 mod（判断 D9）: **レジストリは無料の mod のみ**。決済機能は持たない。外部での販売は禁止しないが、レジストリには載せない

### 7.3 mod パック

```toml
[mod]
id = "example.beginner-pack-ja"
kind = "pack"
name = "はじめてのターミナル（日本語）"

[[pack.mods]]
id = "otterm.dictionary-ja"
version = ">=1.0"

[[pack.mods]]
id = "example.file-tree-plus"

[pack.settings]            # 推奨設定（適用するか確認される）
"guide.level" = 3
"layout.preset" = "guided"
```

## 8. 開発体験

### 8.1 テンプレート

```bash
npm create otterm-mod@latest my-mod
```

- 対話で kind を選ぶ。`extension` なら TypeScript + esbuild の最小構成、`theme` なら TOML と見本画像
- `pnpm dev` でビルド監視 + otterm に `--link` インストール + ホットリロード

### 8.2 開発者ツール

- 設定 → mod → 「開発者モード」で、各 mod のログ・イベント配信・API 呼び出し・処理時間（ms）を表示
- 入力遅延に影響している mod をハイライト（`onInputChange` の処理時間が 1 ms を超えたら黄色）
- `otterm mod doctor <id>` でマニフェストと権限の静的検査

### 8.3 API のバージョニング

- `@otterm/api` はメジャーバージョンで互換を切る。本体は直近 2 メジャーを同時サポート（ブリッジ層）
- 非推奨 API は 1 メジャーの猶予期間に警告ログ
- 型定義はすべて公開。API リファレンスは型定義から自動生成

## 9. 同梱 mod 一覧（v1.0）

| id | kind | 内容 | 既定 |
| --- | --- | --- | --- |
| `otterm.file-tree` | extension | ファイルツリー、プレビュー、開く | Lv2 以上で有効 |
| `otterm.cmd-explain` | extension | コマンド説明バー | Lv1 以上 |
| `otterm.completion` | extension | 補完ポップアップ | 有効 |
| `otterm.danger-guard` | extension | 危険ガード | 有効 |
| `otterm.error-hint` | extension | エラー助言 | 有効 |
| `otterm.history-search` | extension | 履歴 UI | 有効 |
| `otterm.multiline-editor` | extension | 複数行入力 | 有効 |
| `otterm.workflows` | extension | ワークフロー実行・ボタン化 | 有効 |
| `otterm.dictionary-core` | dictionary | 基本コマンド辞書（coreutils, git, npm, pip, docker, python, node, cargo 等）日英 | 有効 |
| `otterm.themes-builtin` | theme | 同梱テーマ群 | 有効 |
| `otterm.layouts-builtin` | layout | レイアウトプリセット | 有効 |
| `otterm.onboarding` | extension | 初回設定・チュートリアル | 有効 |
| `otterm.git-status` | extension | ブランチ表示、ファイルツリーの Git 装飾 | 有効（git 検出時） |
| `otterm.mascot` | extension | ラコ本体（表情、吹き出し、反応ルール、衣装の適用） | Lv1 以上で有効 |
| `otterm.outfits-builtin` | outfit | 同梱衣装 `default` / `developer` / `pixel` | 有効 |

公式・同梱・既定オフ: `otterm.ai-assist`（[10-ai-assist.md](10-ai-assist.md)）

公式だが別配布（v1.0 では同梱しない）: `otterm.ssh`、`otterm.docker`、`otterm.kubernetes`、`otterm.sync`

## 10. mod のアイデア集（ストアの初期ラインナップ候補）

- 見た目: 背景にライブ壁紙／パーティクル、レトロ CRT シェーダ、タブを縦置きにする、タイプ音
- 初心者: 日本語でコマンドを説明する辞書拡張、授業用の課題チェッカー、「今日学んだコマンド」日記
- 開発者: Git グラフパネル、npm scripts ボタン、Docker コンテナ一覧、ポート一覧と kill、環境変数ビューア、`.env` 切替、テスト結果の集計表示、ビルド完了通知
- 生活: ポモドーロタイマー、天気、音楽の再生中表示
- 遊び: 出力にネコが流れる、コマンド成功で経験値が貯まる RPG 風ステータス
