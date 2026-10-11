# 07. ロードマップ（Roadmap）

## 0. 方針

- 「普通のターミナルとして使える」を最初に完成させ、その上に otterm らしさを積む
- mod API はできるだけ早い段階で固め、同梱機能自体を mod として作ることで API を鍛える
- 各マイルストーンに「触れるもの」を置き、早期から自分で常用する（ドッグフーディング）

## 1. マイルストーン

### M0: 骨組み（目安 3〜4 週）

- モノレポ構築（Cargo + pnpm + Tauri 2）、CI（Windows / macOS / Linux ビルド）
- `otterm-pty` で各 OS のシェル起動、生の出力を WebView にテキスト表示
- 設計判断の確定: グリッド転送方式（バイナリ差分 IPC）の実測。段 4 が 2 ms に収まるか
- **性能の基準値取り**: 同じマシンで Ghostty / WezTerm / Windows Terminal / Alacritty の打鍵遅延・スループット・起動時間を測り `docs/bench/baseline.md` に記録
- **レンダラ判定**: WebGL 経路の p99 を測り、[09-performance.md](09-performance.md) 4.4 の基準でネイティブレンダラの時期を決める
- libghostty の動作とライセンスの確認（VT コアの代替候補として記録）
- **完了条件**: 3 OS で `ls` の出力が出る。基準値とレンダラ判定が文書化されている

### M1: ターミナルとして成立（目安 8〜10 週）

- `otterm-vt`: VT パーサ、グリッド、代替画面、256 色 / TrueColor、マウス報告、ブラケットペースト
- WebGL レンダラ、グリフアトラス、CJK / 絵文字幅
- タブ、縦横分割、スクロールバック、検索、選択・コピー・ペースト、URL リンク
- 設定ファイルの読み書き（最小）、テーマ（ターミナル色のみ）
- vttest 主要項目の通過、vim / htop / lazygit / tmux の動作確認
- 性能計測ツールの整備（`tests/bench/` 一式）と CI ゲート（p99 10 % 悪化で失敗）
- 入力経路の設計を固める: キー入力は mod を経由せず Rust に直行、`before-execute` のみ 50 ms タイムアウト付きで同期
- **完了条件**: 開発者が日常の作業を otterm で行える。打鍵遅延 p99 が基準値の Ghostty + 16 ms 以内
- 進み具合（2026-10-11）:
  - 済み: `otterm-vt`（パーサ、グリッド、スクロールバック、代替画面、SGR、全角、結合文字、モード、DSR / DA 応答、ダメージ追跡）、バイナリ差分とローカル WebSocket での転送（判断 M2）、WebGL2 レンダラ（グリフアトラス、インスタンス描画。2026-10-11）と Canvas 2D レンダラ（フォールバック、`appearance.renderer`）、Rust 側の整形とラスタライズ（`otterm-text`、判断 C3・C4）、ウィンドウに合わせたリサイズ、Rust 側のキー / ペーストのエンコード、IME の確定文字入力と変換中表示、ConPTY の同梱（判断 M3）
  - 済み（続き）: スクロールバックの表示（ホイール、Shift+PageUp など）、選択とコピー（ドラッグ／単語／行／矩形）、マウス報告（1000/1002/1003、SGR）と代替画面でのホイール→矢印（判断 I5）、リサイズ時の再折り返し、検索（正規表現・大文字小文字・単語）、Ctrl+クリックのリンク（判断 I2）、右クリックメニュー（判断 I1）、タブと縦横分割、設定ファイルの読み込み（キー単位のフォールバック、ライブ再読み込み）とテーマ 13 種、Nerd Font の検出、Fluent による UI 文言（判断 C7）、打鍵遅延ベンチ（Canvas 2D で p99 8.2 ms、`docs/bench/baseline.md` §4.5）
  - TUI の動作確認（Windows、開発機）: vim、less、btop、lazygit で表示・入力・マウスを確認済み
  - 済み（さらに）: Kitty キーボードプロトコル（判断 I3）、キーバインドの設定（`[keybindings.bindings]`。代替画面では Ctrl+Shift / Cmd 以外をアプリに譲る）、複数行貼り付けの確認（判断 B16）、OSC 52 の確認（判断 H2）、右クリックの動作設定（判断 I1）、ベル（ペインのフラッシュ、背景タブの印）、OSC 8 ハイパーリンク、スクロールバーの操作と検索ヒットの表示、端末状態のリセット、ウィンドウ位置の記憶（判断 I7）、実行中のプログラムがあるときの閉じる確認、起動時間ベンチ（`docs/bench/baseline.md` §4.6）、ファイルのドラッグ&ドロップでクォート済みパスを入力（FR-FILE-03）、出力内のパス（`src/app.ts:42` など）を Ctrl+クリックでエディタの該当行に開く（FR-FILE-06）、WSL・Nushell の検出、設定の追加分（文字間隔、余白、代替画面のホイール、タブバーの位置、プロファイルの色）、F11 の全画面と Ctrl+, の設定ファイル
  - 済み（2026-10-11 午後）: セルをまたぐ合字（`font.ligatures`。隣り合う同じ装飾のセルをまとめて整形し、`->` `=>` `!=` `::` `...` `&&` などをフォントが結合する。Cascadia Code で確認）、Symbols Nerd Font Mono の同梱（判断 B14）
  - 残り（この開発機ではできないもの）: vttest 本体（Unix の pty が要る）、tmux（WSL がない）、macOS / Linux での手動確認、参照マシンでの打鍵遅延・起動時間の再計測と、その値を基準にした CI ゲート（共有ランナーは揺れが大きく、ゲートにできない。`tests/bench/compare.js` は用意済み）

### M2: シェル統合とブロック（目安 4〜6 週）

- bash / zsh / fish / pwsh のフックスクリプト、OSC 133 / 7 / 7777
- ブロック UI（ガター、折りたたみ、再実行、ジャンプ）
- otterm が描くプロンプトバー（CWD、Git ブランチ、終了状態、所要時間。テーマと mod で変更可。判断 M4）。pwsh の試作は済み（2026-10-11）
- CWD 追従、タブ名自動化
- 入力行の取得（方式 A + フォールバック B）
- **完了条件**: ブロック単位の操作が 4 シェルで動く
- 進み具合（2026-10-11）:
  - 済み: `otterm-vt` のブロック（`133;A/B/C/D`、`7777;cmd/bar/done`。先頭行に状態・コマンド・出力開始行・終了コード・所要時間を持たせ、スクロールバックとリフローを越えて行と一緒に動く）、フレームへのブロック情報の追加、4 シェルのフック（pwsh は `PSConsoleHostReadLine` を包んで `133;C`、bash は DEBUG トラップ、zsh は `preexec`、fish は `fish_preexec`。bash のログインシェルの再現、zsh の `ZDOTDIR` 引き継ぎ）、起動引数と環境変数での注入を引数付きプロファイルにも適用、フックの `<設定フォルダ>/shell-integration/` への書き出し（判断 M5）
  - 済み（UI）: ブロックのガター（失敗は赤、実行中は青の点滅）、`Ctrl+Up/Down` のジャンプ（`block.prev` / `block.next`）、ブロック上の右クリックメニュー（もう一度実行、コマンド／出力のコピー、出力の保存、Markdown としてコピー。判断 I11、I12）、実行中のタブ名「コマンド名 · フォルダ名」（判断 I10）、プロンプトバーの実行中表示
  - 済み（折りたたみ）: ブロック出力の折りたたみ（メニューの「出力を折りたたむ」、`Ctrl+Shift+[`、クリックで展開）、長い出力の自動折りたたみ（`terminal.fold_lines`、既定 200 行超で中央を隠す）、「ブロックを選択」。表示する行の一覧をセッションが持ち、フレームが行番号を運ぶ方式（03 §6.3）
  - 確認済み: Windows で pwsh と Git Bash。zsh と fish は書いたが未確認（この開発機にない）
  - 残り: 入力行の取得（`7777;line`。使う側の入力支援が M4 なので、そのとき）、nushell のフック、macOS / Linux での zsh / fish の確認、ガターのホバーボタンと `cards` プリセット（M5 で）

### M3: mod 基盤（目安 6〜8 週）

- `otterm-modhost`、Worker + QuickJS サンドボックス、権限ブローカー
- `@otterm/api` v1（UI Slot、宣言的 UI、コマンド、イベント、fs / process / http）
- マニフェスト、ローカルインストール、有効／無効、クラッシュ隔離、開発者モード
- `create-otterm-mod` テンプレート
- **完了条件**: ステータスバーに Git ブランチを出す mod を、外部の人がテンプレから作れる
- 進み具合（2026-10-11）:
  - 済み（Rust）: `otterm-modhost`（`otmod.toml` の読み込みと検証、`${cwd}` などのパス変数と glob、権限ブローカー: `fs.read` / `fs.write` の glob と保護リスト（判断 K8）、`process` の実行ファイル名、`network` のホスト照合、子プロセスの実行、`ctx.storage` の 10 MB KV、承認の保存（`mods/permissions.json`、判断 D5）、インストール（コピー／リンク、判断 K7）、`config.toml` の `[mods] enabled / disabled` と `[mods.settings]` の書き換え（toml_edit））。アプリ側の Tauri コマンド（`mods_list`、`mod_source`、`mod_grant`、`mod_set_enabled`、`mod_install`、`mod_fs`、`mod_process_run`、`mod_http_fetch`（ureq）、`mod_storage`、`mod_setting_set`、`mod_log`）、`mods/` の監視（追加・削除・リンク先の `dist/main.js` の更新で `mods-changed`）、CLI `otterm mod list | install <path> [--link] | link | remove | enable | disable | doctor`
  - 済み（UI）: mod ごとの Web Worker + QuickJS（WASM、`quickjs-emscripten-core`。メモリ 64 MB、コールバック 1 回 5 秒で割り込み、判断 C2）、サンドボックス内 SDK（`packages/ui/src/mods/sdk.js`。権限のない名前空間は `ctx` に存在しない）、タイマー 4 関数のみ（判断 M1、deactivate で全停止）、宣言的 UI の 18 種のレンダラ（`render.tsx`。Reactive と Signal はサンドボックス側で解決し、関数は id に置き換えて postMessage）、Slot `statusbar.left/right` とステータスバー（フォルダ、直前の終了コード、mod の状態）、`sidebar.left/right` と `panel.bottom` のパネル、`ctx.ui.toast / dialog / contextMenu`、コマンドとキーの提案（ユーザー設定が優先）、イベント（session-created/closed、cwd-changed、focus-changed、title-changed、block-start/end）、権限の承認画面（05 §6.2）、`terminal.write` と `clipboard.read` の初回使用時の確認（判断 D5）、クラッシュ隔離（例外・5 秒無応答で deactivated、3 回で無効化）、開発者モード（`[mods] developer_mode`: mod 一覧パネルにログと API 呼び出しの回数・時間）、`<データ>/logs/mods.log`、リンクした mod のホットリロード
  - 済み（テンプレ）: `create-otterm-mod`（対話で kind、extension は TypeScript + esbuild、`pnpm dev` = ビルド監視 + `mods/` へのリンク、theme テンプレ）。Windows の開発機で Git Status Bar をテンプレから作り、ブランチと変更数がステータスバーに出ることを確認した（activate 44 ms。QuickJS の起動を含む。判断 C2 の「50 ms 程度」のとおり）
  - 残り: `ctx.ui.pickPath`、`ctx.fs.watch`、`ctx.process.spawn`、`ctx.terminal.screen / blocks / selection`（呼ぶと「まだ使えない」で reject）、`input-changed` / `before-execute`（入力行の取得は M4）、ワークスペース内 `.otterm/mods/`（信頼モデル K4 と一緒に）、`custom`（iframe）の `otmod:` スキーム、設定画面での mod 設定フォーム（M5 で済み）、署名検証とレジストリ（M6）、macOS / Linux での確認、`otterm mod` の Windows リリースビルドでの標準出力（GUI サブシステムのためコンソールに出ない）

### M4: 同梱 mod と初心者体験（目安 8〜10 週）

- `file-tree`（ツリー、開く、D&D、プレビュー、GUI 操作とコマンド学習ヒント）
- `dictionary-core`（日英、主要 200 コマンド）、`cmd-explain`、`completion`
- `danger-guard`、`error-hint`、`history-search`、`multiline-editor`、`workflows`
- オンボーディング、ガイドレベル、チュートリアル
- コマンドパレット
- **完了条件**: ターミナル未経験者 5 人にチュートリアルだけで「ファイルを作って Python を実行」まで到達してもらう
- 進み具合（2026-10-11）:
  - 済み（土台）: 入力行の取得（方式 B。`otterm-vt` が `133;B` の位置からカーソル行までを画面から読み、変わるたびに `Input` イベント。`exact: false`）、Enter の横取りと `before-execute`（mod ごとに 50 ms。cancel > confirm > replace。確認ダイアログは「そのまま実行／代替案／やめる」、代替案は入力行を書き換えてから実行。判断 B8）、`session_replace_line`（PSReadLine は Esc、readline / zle / fish は Ctrl+A Ctrl+K で消してから貼り付け）、assist API の実体（ホストにパーサ `assist/parse.ts`、危険ルールの評価（辞書の `danger` マークと `rules/*.json`、mod の `addRules`）、辞書の統合（`kind = "dictionary"` の mod の JSON を Rust が読む）、explain / completion / errorHint の各プロバイダ呼び出し）、同梱 mod の埋め込み（`build.rs` が `mods/*` を実行ファイルに入れ、起動時に `<データ>/bundled-mods/<id>/` へ書き出す。公式の同梱 mod は承認済み扱い。判断 M8）、実行記録（`history.sqlite`、判断 K1。秘密らしい引数の `[REDACTED]`、保持 90 日）、`ctx.fs.trash`、`ctx.settings.host.set / onChange`（公式 mod のみ）、ガイドレベル（ステータスバーの `Lv` をクリックで切替、`general.guide_level` を toml_edit で書く）
  - 済み（UI）: 入力支援バー（説明と、失敗したブロックのエラー助言カード「入力欄に入れる」）、補完ポップアップ（`Ctrl+Space`、Lv3 は Tab で確定。判断 B3）、コマンドパレット（`Ctrl+Shift+P`。本体操作、プロファイル、mod のコマンド、ガイドレベル。`!` はシェルに入力）、履歴 UI（`Ctrl+R`、Lv1 以上。判断 B5。選択で入力欄へ）、複数行入力（`Shift+Enter`、クォートと括弧の閉じ忘れ表示、Ctrl+Enter でまとめて送信）
  - 済み（同梱 mod、`mods/`）: `otterm.cmd-explain`、`otterm.danger-guard`（Windows 固有ルール含む、判断 G5）、`otterm.error-hint`（検出したパッケージマネージャで導入提案、判断 B11）、`otterm.completion`（サブコマンド・オプション・パス）、`otterm.file-tree`（ツリー、プレビュー、新規・名前変更・ゴミ箱、Lv2 以上でダブルクリックが `cd`。判断 B10）、`otterm.workflows`（同梱 4 セット、`${data}/workflows.json`）、`otterm.onboarding`（初回設定 8 段階と 6 章のチュートリアル。判断 B7、G3）
  - 確認済み（Windows、pwsh）: 7 つの同梱 mod の起動（各 30〜90 ms）、`git push -f` の説明表示 → Enter で確認 → 「--force-with-lease で実行」で書き換えて実行 → 失敗の助言カード（`git init`）まで一続きで動く
  - 済み（残りの片付け、2026-10-11 夜）: 方式 A（zsh の `zle-line-pre-redraw` が `OSC 7777;line;<cursor>;<%エンコード>` を送り、`exact: true`。判断 M11）、パスワード入力の検出（判断 K2。Unix は PTY の ECHO フラグ、ConPTY は実行中のカーソル行が `Password:` などで終わるかの推定。その間は説明・補完・`input-changed` を止める）、`--help` のキャッシュ（判断 B9。辞書にないコマンドが一度成功した後だけ、PATH 上の `.exe` を `--help` で 2 秒まで実行し `<データ>/help-cache.json` に保存。`rm` `format` などは対象外）、履歴 UI の絞り込み（このフォルダ・成功のみ・今日）とシェル履歴の統合（PSReadLine、bash、zsh、fish の履歴ファイルを末尾 2 MiB だけ読む）、補完の PATH・履歴・コマンド名（ホスト側で mod の候補と統合。履歴は行ごと置き換え）、ファイルツリーの Git 装飾（`git status --porcelain -z`、5 秒ごと）と WSL / Git Bash のパス変換（`hostCwd`。`/mnt/c` と `/c` はドライブ、それ以外の WSL パスは `\\wsl.localhost\<distro>`）、プレビューの CSV / TSV（表、200 行まで）、JSON（整形）、PDF（既定のアプリで開くボタン。サンドボックスでは描けない）、エディタ検出（判断 I16。VS Code、Cursor、Zed、Sublime を PATH と既知の場所から。パレットの「エディタ: … を使う」で `open.editor` を切り替え。`editor_template` も使える）、パレットの `:`（行）`?`（辞書）`@`（フォルダ以下のファイル）`#`（ブロック）、`otterm trash`（CLI。セッションの PATH の末尾に otterm のフォルダを足すので、danger-guard の「ゴミ箱に送る」がそのまま動く）、`ctx.terminal.blocks` / `screen`
  - 残り（この開発機ではできないもの）: 未経験者 5 人での検証（完了条件。人が要る）、zsh / fish / bash での方式 A と ECHO 検出の確認（zsh も Unix の PTY もこの開発機にない）、macOS / Linux。設定画面（エディタの一覧と選択を含む）は M5

### M4.5: コツメ（目安 3〜4 週、M4 と並行可）

- キャラクターデザインの確定（シルエット、4 表情、16 px アイコン）、ロゴ・アイコン制作
- `mascot` Slot、表情ステートマシン、吹き出し UI、ガイドレベル連動
- 同梱 mod の台詞をコツメ経由に統一（onboarding、danger-guard、error-hint）
- `outfit` kind と着せ替え API、同梱衣装 3 種
- **完了条件**: コツメを完全に隠した状態と、Lv3 で常時いる状態の両方が破綻なく使える

### M5: 見た目と仕上げ（目安 4〜6 週）

- UI トークン、CSS 上書き、レイアウトプリセット、Slot のドラッグ配置
- 同梱テーマ群、テーマインポート、ライブ編集
- 透過・ぼかし・背景画像、フォント設定画面
- アクセシビリティ（スクリーンリーダー、キーボード完結）
- **完了条件**: 設定ファイルを一切書かずに、見た目を別物にできる
- 進み具合（2026-10-11）:
  - 済み（設定画面）: `Ctrl+,` で開く全画面の設定（04 §6）。左にカテゴリ 13 個、上に横断検索。フォームは `schemars` の JSON Schema から生成（判断 C6）し、`Auto<T>`・`Option<T>`・列挙・範囲付き数値（スライダー）・文字列リスト・マップ・`[[profiles]]` を扱う。変更はその場で `config.toml` に書き戻し（toml_edit、判断 M15）、すぐ反映。手で書いた項目には「既定に戻す」。ラベルと説明は Fluent（`set-*`、`setv-*`）
  - 済み（見た目）: UI トークン（`--ot-bg` など 12 個。テーマの `[theme.ui]` がなければターミナル色から導く）と全 CSS のトークン化、安定した `data-ot` 属性、テーマの CSS（`[theme.css] file / text`）と `<設定>/user.css`（設定画面で編集すると入力中から反映）、テーマギャラリー（15 種。Catppuccin Frappé / Macchiato を追加）、テーマのライブ編集（ターミナル 20 色・UI トークン・CSS。保存でユーザーテーマ、「mod として書き出す」で theme mod のフォルダ）、配色のインポート（iTerm2・Windows Terminal・VS Code・Alacritty（TOML / YAML）・WezTerm。設定画面と `otterm theme import <file>`）、theme kind の mod の読み込み（判断 M15）
  - 済み（レイアウト）: プリセット 5 種（minimal / classic / guided / ide / cards）と `auto` の解決（`appearance.tabbar.position`・`statusbar.visible`・`assist_bar`・`blocks` を `Auto` に）、「今の配置を保存」（`<設定>/layouts/*.toml`）、パネルのタブをドラッグして左右・下の Slot へ移す（`appearance.panels`）と設定画面での置き場所選択、`cards` のブロック表示（M2 の残り）、パネルの表示切替キー（判断 M12）
  - 済み（ウィンドウ）: 不透明度・ぼかし・背景画像（配置 4 種と濃さ。画像は設定画面で選ぶと `<設定>/backgrounds/` にコピー）、テーマの `[theme.window]`（判断 M14）、UI の拡大率（`zoom`、ターミナルの文字は別）、フォント画面（見本の行、インストール済みフォントの候補）
  - 済み（アクセシビリティ）: スクリーンリーダー向けのライブリージョン（`accessibility.screen_reader`。出力が止まったら新しい行を読む）、フォーカスリング、動きを減らす（OS 追従か `accessibility.reduce_motion`）、OS のハイコントラストで High Contrast テーマへ自動切替（`accessibility.high_contrast`、判断 I15）、`F6` の領域移動、キーバインド画面（記録・解除・競合の赤表示）
  - 確認済み（Windows、開発機）: 設定画面からテーマを替える（即時反映と `config.toml` への書き込み）、レイアウト `cards`、背景画像、不透明度、フォント画面、キーバインド画面、テーマエディタのライブプレビュー
  - 済み（残りの片付けと UI の総点検、2026-10-11 夜）: ブロックのホバーボタン（もう一度実行・出力のコピー・折りたたみ・その他。M2 の残り）、ステータスバー項目の並べ替え（ドラッグと設定画面の ↑↓、`appearance.statusbar.order`）、失敗ブロックの破線ガター（判断 I15）、本体のアイコン集（判断 M16）、デザイン基盤の文書（[12-design-system.md](12-design-system.md)）。総点検で直したもの: OS のタイトルバーがテーマの明暗に従う、細いスクロールバー、ファイルツリーの操作をアイコンボタンに、補完ポップアップをカーソルの位置に、危険の確認を縞の縁と警告アイコン付きでターミナルの上に、パレットにキーの表示と「設定を開く」、ライトテーマでの状態色の文字（`--ot-*-text`）、コードのない mod の状態を「有効」に、同梱 mod に「削除」を出さない、`pwsh.exe` のパスだけのタイトルをタブ名に使わない、確認の説明を 1 行ずつ
  - 残り: セーフモード（M6）、macOS / Linux での透過とぼかしの確認

### M5.5: AI 補助（目安 4〜6 週、M5 と並行可）

- 公式 mod `otterm.ai-assist`（同梱・既定オフ）。プロバイダ抽象（ローカル Ollama、Claude、OpenAI、Gemini、OpenAI 互換）
- 自然文 → コマンド、エラー説明と修正案、`fix`、出力について聞く
- 送信プレビュー、自動マスク、ローカルログ、ワークスペース単位のオフ
- `ctx.ai.complete` と権限 `ai`
- 評価セット（日英 300 問）と危険コマンド生成の確認を手元で回す（自動テストにはしない。判断 L2）
- ステップ実行モードは v1.x に回す
- **完了条件**: AI をオフにしても UI に空欄が生まれない。生成コマンドに danger-guard が 100 % 反応する

### M6: 配布（目安 3〜4 週）→ v1.0

- インストーラ（v1.0 は winget / Homebrew cask / AppImage の 3 チャネル。deb / rpm / Flatpak は v1.1）、Tauri updater による自動更新、署名（判断 A9、C10）
- mod レジストリ（静的インデックス）、`otterm mod publish`、ストア画面
- ドキュメントサイト（Starlight。ユーザーガイド、mod 作者ガイド、TypeDoc から生成する API リファレンス。判断 L3）
- セーフモード、ローカルクラッシュログと「Issue を作る」ボタン（外部送信なし。判断 C11）
- **完了条件**: v1.0 公開。レジストリに同梱以外の mod が 10 以上

### v1.x

- **ネイティブ wgpu レンダラ**（ターミナル領域だけをネイティブ描画。M0 の判定次第で v1.0 に前倒し）
- `ottermd` デーモン分離（UI が落ちてもセッション維持、tmux 的なデタッチ）
- スクロールバックの復元
- 画像プロトコル完全対応、Kitty keyboard protocol
- AI のステップ実行モード（1 ステップずつ承認する多段タスク）
- 公式別配布 mod: SSH、Docker、Kubernetes
- WASM Component による mod（Rust / Go / Python で mod を書く）
- mod パック、ワークスペース共有の強化
- UI 言語の追加（中国語、韓国語、スペイン語 など、コミュニティ翻訳）

## 2. リスクと対策

| リスク | 影響 | 対策 |
| --- | --- | --- |
| WebView 経由の描画で入力遅延目標（p99 16 ms）を外す | 上級者が離れる | M0 でベンチし、必要なら描画をネイティブ（wgpu）に切り替えられる構造にする。グリッドは Rust 側が正。レンダラは差し替え可能に |
| Linux の WebKitGTK の品質差 | Linux 版の見た目崩れ | CI で 3 ディストリのスクリーンショット比較。将来 Servo / CEF への差し替え余地 |
| シェル統合の注入がユーザー環境を壊す | 信頼喪失 | 既定は起動引数注入でユーザーのファイルを触らない（判断 B6）。rc 追記はオプトインで、可読スクリプト + 署名 + 「元に戻す」ボタン付き |
| 入力行の取得が不正確（PSReadLine など） | 説明・危険判定が外れる | 推定時は UI に「推定」表示。PSReadLine はモジュールのイベント API を使用し、無理なら実行直前（before-execute）で確実に取れる文字列を使う |
| mod のサンドボックス抜け | セキュリティ事故 | 権限 API を Worker に注入しない設計 + Rust 側で二重検査 + バグバウンティ |
| 辞書の網羅性・翻訳品質 | 初心者体験の質 | 辞書を mod として分離しコミュニティで育てる。`--help` 自動取得で穴を埋める |
| 機能過多で "簡単" から遠ざかる | コンセプト崩壊 | ガイドレベルとレイアウトプリセットで初期状態を絞る。新機能は原則 mod。コアに入れる基準を文書化 |
| コツメや入力支援がターミナルの遅延源になる | 「かわいいが遅い」評価 | 入力経路に mod を挟まない。コツメのアニメーションはコンポジタのみ。`mod-overhead` ベンチを CI で監視 |
| AI が存在しないオプションを捏造する／危険なコマンドを返す | 初心者が被害を受ける | 辞書との照合で未知オプションに注記。生成結果にも danger-guard を必ず通す。実行は常にユーザー |
| AI の送信内容に秘密情報が混ざる | 情報漏えい | 自動マスク、送信プレビュー、ローカルログ。サーバーを持たず BYOK にすることで otterm 側に情報が集まらない |

## 3. 判断待ちの事項（Open Questions）

未決事項の全体は [11-decisions.md](11-decisions.md) で管理する（A〜L は 2026-10-10 に全項目決定済み）。ここには製品方針に関わる大きなものの経緯だけを残す。

1. ~~入力支援の `Tab` キーの扱い~~ → **決定**: Lv0〜2 はシェルへ渡し、Lv3 のみ otterm の補完を Tab で確定（判断 B3）
2. ~~シェル統合をオンボーディングでどこまで強く勧めるか~~ → **決定**: 既定は起動引数注入で許可不要。rc 追記だけをオンボーディングでオプトインとして選べる（判断 B6、03 §11.1）
3. ~~レジストリの運営主体とモデレーション方針~~ → **決定**: GitHub 上の静的インデックス。`terminal.write` か `network` を持つ mod だけ事前審査、それ以外は報告ベース（判断 D3、D4）
4. ~~AI アシストのプロバイダ~~ → **決定**: BYOK（Claude / OpenAI / Gemini / OpenAI 互換）とローカル（Ollama）の両対応。詳細は [10-ai-assist.md](10-ai-assist.md)
5. ~~ライセンス~~ → **決定**: 本体 Apache-2.0、mod SDK（`@otterm/api`）MIT（判断 A1）
6. 「otterm」の商標・名称衝突の確認 → 調査方法は決定（判断 A3: J-PlatPat と USPTO / EUIPO の「コンピュータソフトウェア」区分）。**調査の実施は M0**。「oterm」という近い名前の Obsidian プラグインと Ruby gem があるが、ターミナルエミュレータとしての衝突は未確認
7. ~~キャラクター名~~ → **決定**（判断 E9）: 種族をラッコからカワウソに改め、名前は日本語「コツメ」、海外「Pebble」（2026-10-11）。詳細は [08-character.md](08-character.md)
8. ~~キャラクターデザインの担当とライセンス~~ → **決定**: 内製。ライセンスは独自の短いキャラクターガイドライン（判断 A2）
9. ネイティブ wgpu レンダラを v1.0 に含めるか → **未決**。M0 のベンチ結果で判断（[09-performance.md](09-performance.md) 4.4）

## 4. 次のアクション

仕様書のレビュー、判断一覧 A〜L の決定、`@otterm/api` の型定義ドラフトは完了した。

M0 の進み具合（2026-10-11）: モノレポ初期化、型とデータの配置（`packages/api`、`mods/dictionary-core`、`crates/otterm-config`、`packages/ui/locales`）、3 OS の CI（fmt、clippy、Biome、型検査、辞書検証）は済み。Tauri 2 + portable-pty の最小起動（`otterm-pty`、`otterm-session` の `SessionManager` trait、`otterm-app`、`packages/ui`）も済み。Windows では pwsh を起動して `ls` の出力が出ることを確認した。ConPTY は起動時のカーソル位置問い合わせ（DSR）に応答するまで出力を止めるため、M0 では UI が仮に応答している（M1 で `otterm-vt` に移す）

ベンチの土台（`tests/bench/`。PTY のスループットと往復、Rust → WebView の転送を Tauri Channel と WebSocket で比較）も済み。開発機の結果は [bench/baseline.md](bench/baseline.md)。転送手段（判断 M2）と ConPTY の同梱（判断 M3）が新たな判断事項になった。

1. macOS / Linux での起動確認とベンチ（M2 を決めるため）
2. 他ターミナルの基準値取り（参照マシンが要る。判断 C12）
3. 商標調査（判断 A3）と libghostty の確認
4. レンダラ判定（09 §4.4）は打鍵遅延が測れる M1 の最初に持ち越す
