# 02. アーキテクチャ（Architecture）

## 1. 技術スタックの選定

### 1.1 候補比較

| 候補 | 長所 | 短所 | 判定 |
| --- | --- | --- | --- |
| **Tauri 2 + Rust（PTY・描画コア）+ Web フロント（UI・mod）** | 軽量（Electron 比で 1/5 以下のメモリ）、Rust で安全・高速な PTY／パーサ、UI と mod を Web 技術で自由に改造できる、Windows/macOS/Linux 全対応 | WebView のレンダリング差異（特に Linux の WebKitGTK）、GPU 描画は自前で WebGL/Canvas | **採用** |
| Electron + xterm.js | 実績豊富（VS Code, Hyper）、開発が速い | 重い、起動が遅い、Hyper と同じ轍を踏む | 不採用 |
| 純 Rust + wgpu（Alacritty / WezTerm 系） | 最速 | UI 改造・mod を Web 技術で書けない。独自 UI ツールキットの開発コストが大きすぎる | 不採用 |
| Flutter | 1 コードで全 OS | ターミナル描画ライブラリの成熟度が低い、mod を書く言語が Dart に縛られる | 不採用 |

### 1.2 採用スタック

| レイヤ | 技術 | 役割 |
| --- | --- | --- |
| アプリシェル | **Tauri 2** | ウィンドウ管理、OS 連携、自動更新、IPC |
| 画面データの転送 | **ローカル WebSocket**（127.0.0.1、起動ごとのトークンで認証） | グリッド差分と PTY 由来のデータ。コマンドと設定は Tauri IPC（判断 M2） |
| Windows の PTY ホスト | **`conpty.dll` + `OpenConsole.exe` を同梱**（Microsoft.Windows.Console.ConPTY） | OS 同梱の conhost より大量出力が約 3 倍速い（判断 M3） |
| コア | **Rust** | PTY 制御（`portable-pty`）、VT パーサ（`vte` クレートを土台に自前グリッド）、グリッド状態、スクロールバック、検索、シェル統合プロトコル、mod サンドボックスのホスト側 |
| 描画 | **WebGL2 / WebGPU（フォールバック Canvas2D）**。`Renderer` trait で差し替え可能にし、v1.x で **ネイティブ wgpu** バックエンドを追加 | グリッドをアトラス化したグリフで描画。グリッド状態は Rust 側からバイナリ差分で受け取る。詳細と判定基準は [09-performance.md](09-performance.md) |
| UI | **TypeScript + SolidJS**（軽量・リアクティブ）+ CSS 変数 | タブ、パネル、ダイアログ、設定画面、コマンドパレット |
| mod ランタイム | **QuickJS（WASM ビルド）を Web Worker 内で実行**、将来 **WASM Component** | mod を本体 UI スレッドから隔離し、権限付き API だけを公開 |
| 文字整形 | **rustybuzz（シェーピング）+ swash（ラスタライズ）**、Rust 側 | グリフ ID・位置・アトラスを Rust で確定し、WebView は描くだけ。ネイティブレンダラ移行時に流用（判断 C3、C4） |
| 設定 | **TOML** + Rust 構造体から `schemars` で生成する JSON Schema | 人が読める。コメント可。GUI と双方向。設定画面はスキーマから自動生成（判断 C6） |
| 翻訳 | **Fluent（`.ftl`）** | 複数形・変数を翻訳側で処理。mod も同形式（判断 C7） |
| パッケージ | **Cargo workspace（Rust）+ pnpm workspace + Turborepo（TS）**、クロス言語のタスクは `just` | モノレポ（判断 L4） |
| コード規約 | Rust: `rustfmt` + `clippy`（警告ゼロを CI で強制）。TS: **Biome**（lint と format を 1 ツールで）。コミットは Conventional Commits | 判断 L1 |
| テスト | **自動テストはリポジトリに入れない**。動作はアプリを動かして確かめる（vttest、主要 TUI アプリの手動確認）。CI は静的検査（fmt、clippy、Biome、型検査）と辞書・翻訳の検証のみ | 判断 L2 |
| CLI ↔ GUI 通信 | OS ネイティブ IPC（名前付きパイプ / Unix ソケット）+ 起動ごとのトークン | 判断 K6。[06-config-keybind.md](06-config-keybind.md) §4 |
| 公式 mod の配置 | 同梱 mod は本体モノレポ内 `mods/`。別配布の公式 mod（SSH、Docker 等）は別リポジトリ `otterm-mods` | 判断 L6 |

### 1.3 なぜコアを Rust、UI と mod を Web 技術に分けるのか

- 速さが必要なもの（PTY 読み取り、VT 解釈、グリッド更新、描画データ生成）は Rust で行い、GC 停止や JS のオーバーヘッドを排除する
- 自由に改造されるもの（見た目、パネル、ボタン、ワークフロー）は Web 技術にする。CSS とコンポーネントは「改造される前提」で作られた最も普及した技術
- mod 作者の母集団を最大化する（TypeScript を書ける人は多い）

## 2. プロセス構成

```
+----------------------------------------------------------------------+
| otterm プロセス（Tauri）                                               |
|                                                                      |
|  +------------------ Rust コア（ネイティブ側） ---------------------+  |
|  |  SessionManager -- Session xN -- Pty -- VtParser -- Grid        |  |
|  |  ShellIntegration（OSC 133/633/7 受信、ブロック境界生成）        |  |
|  |  SearchIndex / Scrollback（ディスクスピル可）                    |  |
|  |  ConfigStore（TOML 読み書き・監視）                              |  |
|  |  ModHost（権限チェック、Capability ブローカー）                  |  |
|  |  Updater / Crash reporter                                       |  |
|  +-----------------------------^-----------------------------------+  |
|                                | IPC（Tauri command / event）         |
|                                | + ローカル WebSocket（グリッド差分）  |
|  +-----------------------------v-----------------------------------+  |
|  | WebView（UI スレッド）                                           |  |
|  |  Renderer（WebGL）   Chrome（タブ / パネル / パレット）          |  |
|  |  ThemeEngine（CSS 変数注入）   InputAssist UI                    |  |
|  |  ModBridge（Worker との postMessage）                            |  |
|  +-----------------------------^-----------------------------------+  |
|                                | postMessage（構造化クローン）         |
|  +-----------------------------v-----------------------------------+  |
|  | Mod Workers（mod ごとに 1 Worker、QuickJS サンドボックス）        |  |
|  |   mod A | mod B | mod C ...                                     |  |
|  +-----------------------------------------------------------------+  |
+----------------------------------------------------------------------+
           | PTY
           v
   シェルプロセス（bash / pwsh / ...）  <- v1.x では分離デーモンで生かす
```

### 2.1 v1.x で予定するデーモン分離

v1.0 では Tauri プロセス内に PTY を持つ。v1.x で `ottermd`（Rust、ヘッドレス）を分離し、UI プロセスが落ちてもセッションが生き続ける構成に移行する。
tmux のサーバ／クライアント構成と同じ考え方で、API 境界は v1.0 の時点で `SessionManager` を trait 化して用意しておく。

## 3. レイヤ設計と依存方向

```
mods（ユーザー mod / 同梱 mod）
   | 使う
   v
otterm API（@otterm/api: 型定義 + Capability）
   | 実装される
   v
UI（SolidJS）
   | IPC
   v
Rust コア （UI はコアを呼ぶが、コアは UI を知らない。イベントのみ発行）
```

- 依存は常に上から下。コアは mod の存在を知らない。mod が触れるのは `@otterm/api` だけ
- 同梱 mod（ファイルツリー、ヒント、危険判定、テーマ等）も **同じ API** で実装し、ユーザー mod との差を作らない。差があるとしたら「既定で有効」「署名が公式」だけ

## 4. 主要コンポーネント

### 4.1 Rust コア

| モジュール | 責務 |
| --- | --- |
| `otterm-pty` | OS ごとの PTY 生成（ConPTY / openpty）、リサイズ、シグナル、環境変数注入（`TERM=xterm-256color`, `COLORTERM=truecolor`, `OTTERM=1`, `OTTERM_SESSION_ID`） |
| `otterm-text` | フォントの解決（fontdb、同梱の Symbols Nerd Font Mono を含む）、クラスタ単位の整形（rustybuzz）とラスタライズ（swash）。判断 C3、C4 |
| `otterm-vt` | VT パーサ、グリッド（セル = 文字 + 属性 + 幅）、代替画面、スクロール領域、OSC/DCS ハンドリング、画像プロトコル |
| `otterm-shell` | シェル統合: フックスクリプトの注入、OSC 133 / 633 / 7 / 1337 の解釈、ブロック生成（開始行・終了行・終了コード・CWD・コマンド文字列・経過時間） |
| `otterm-session` | Session / Tab / Pane ツリーの管理、永続化、復元 |
| `otterm-search` | スクロールバックの全文検索（行インデックス、正規表現） |
| `otterm-config` | TOML スキーマ、既定値、マイグレーション、ファイル監視 |
| `otterm-modhost` | mod マニフェスト解析、権限グラント保存、Capability ブローカー（ファイル・プロセス・ネットワーク要求を実際に実行する唯一の場所）、mod の読み込み・解除 |
| `otterm-registry` | mod レジストリ API クライアント、署名検証、インストール／更新 |

### 4.2 UI（TypeScript）

| モジュール | 責務 |
| --- | --- |
| `renderer` | WebGL グリッド描画、カーソル、選択範囲、リンク下線、ブロック境界装飾 |
| `chrome` | ウィンドウ枠、タブバー、ペイン分割、ステータスバー、サイドパネル枠 |
| `palette` | コマンドパレット（fuzzy 検索、コマンド登録 API） |
| `assist` | 入力支援 UI（補完ポップアップ、説明パネル、危険確認ダイアログ、エラー助言カード） |
| `theme` | テーマの読み込み・CSS 変数生成・ライブ編集 |
| `settings` | 設定画面（スキーマから自動生成 + カスタム画面） |
| `modbridge` | mod Worker の起動・API 呼び出しの中継・権限チェックの UI 側 |

### 4.3 mod ランタイム

- 1 mod = 1 Web Worker。Worker 内で QuickJS（WASM）を起動し、mod の JS をその中で実行する
- Worker 自体がブラウザのサンドボックスであり、さらに QuickJS で `fetch` や `importScripts` 等のグローバルを持たない状態から始める。公開するのは `otterm` グローバルと、標準のタイマー 4 関数（`setTimeout` / `clearTimeout` / `setInterval` / `clearInterval`）のみ（判断 M1）。ホストは mod の deactivate 時に残ったタイマーをすべて止める
- UI 描画が必要な mod（パネル等）は、**宣言的 UI（JSON ツリー）** または **サンドボックス iframe（srcdoc, CSP 制限）** のどちらかを選ぶ。詳細は [05-mod-system.md](05-mod-system.md)

## 5. データフロー例：コマンド実行 1 回

1. ユーザーが `git push -f` と打つ
2. UI の `assist` が入力バッファ（シェル統合で取得した現在行）を監視し、mod `cmd-explain` と `danger-guard` に `onInputChange` を配信
3. `danger-guard` が「危険」と判定 → UI が入力欄の下に赤いバナーを出す
4. Enter 押下 → `danger-guard` の `beforeExecute` フックが確認ダイアログを要求 → ユーザーが承認
5. Rust コアが PTY に `\r` を書き込む
6. シェル統合フックが `OSC 133;C`（コマンド開始）を送信 → コアがブロックを開始
7. 出力が流れ、`OSC 133;D;<exit code>` で終了 → ブロック確定、終了コード 1
8. `error-hint` mod が `onBlockEnd` を受け取り、出力を解析して助言カードを出す

## 6. 入力バッファの取得方法（重要な設計判断）

「入力中のコマンドを otterm が知る」には 2 つの方法がある。

| 方式 | 仕組み | 長所 | 短所 |
| --- | --- | --- | --- |
| A. シェル統合から取得 | シェルのラインエディタ（readline / zle / PSReadLine）のフックで現在行を OSC で送信 | シェル側の補完・エイリアスと完全に整合 | シェルごとに実装、PSReadLine など一部は制約が大きい |
| B. otterm 側で入力を鏡像化 | キー入力を otterm が記録し、プロンプト以降の画面テキストと照合して現在行を推定 | シェル非依存 | カーソル移動やヒストリ呼び出しで誤差が出る |

**v1 は A を主、B をフォールバックとする。** 統合済みシェルでは正確な行を使い、未統合シェルでは B で「たぶんこれ」を出し、UI に推定であることを示す。

## 7. リポジトリ構成（予定）

```
otterm/
+- crates/
|  +- otterm-pty/
|  +- otterm-vt/
|  +- otterm-shell/
|  +- otterm-session/
|  +- otterm-search/
|  +- otterm-config/
|  +- otterm-modhost/
|  +- otterm-registry/
|  +- otterm-app/            # Tauri バイナリ
+- packages/
|  +- api/                   # @otterm/api（mod 向け型定義・SDK）
|  +- ui/                    # SolidJS フロント
|  +- renderer/
|  +- cli/                   # otterm CLI（mod 開発・設定操作）
|  +- create-mod/            # mod テンプレート生成
+- mods/                     # 同梱 mod
|  +- dictionary-core/
|  +- file-tree/
|  +- cmd-explain/
|  +- danger-guard/
|  +- error-hint/
|  +- history-search/
|  +- themes-builtin/
|  +- onboarding/
+- shell-integration/        # bash/zsh/fish/pwsh/cmd 用フックスクリプト
+- docs/
+- tests/
|  +- dictionary/            # 辞書の検証（CI）
|  +- vt-conformance/
|  +- e2e/
+- Cargo.toml                # Cargo workspace
+- package.json              # pnpm workspace + Turborepo
+- justfile                  # クロス言語のタスク（just check = CI と同じ検査）
```
