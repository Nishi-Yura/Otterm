# 03. コア機能仕様（Core Features）

本書は「otterm 本体として必ず動くもの」と「同梱 mod として最初から入っているもの」を機能ごとに定義する。
同梱 mod は無効化できるが、本体機能は無効化できない。

| 区分 | 機能 |
| --- | --- |
| 本体 | セッション／PTY、VT 描画、タブ／ペイン、スクロールバック・検索、コピー／ペースト、リンク検出、シェル統合、ブロック、設定、コマンドパレット、mod ホスト、オンボーディング枠 |
| 同梱 mod | ファイルツリー、コマンド説明、危険ガード、エラー助言、履歴検索 UI、ワークフロー、組み込みテーマ、チュートリアル |

---

## 1. セッションと PTY

### 1.1 シェルの検出と起動

- 起動時に OS ごとの候補を列挙し、「プロファイル」として保存する

| OS | 自動検出するプロファイル |
| --- | --- |
| Windows | PowerShell 7 (`pwsh.exe`)、Windows PowerShell 5.1、cmd、Git Bash、WSL 各ディストリ（`wsl.exe -d <name>`）、MSYS2 |
| macOS | ログインシェル（`dscl` から取得）、zsh、bash、fish、nushell |
| Linux | `$SHELL`、`/etc/shells` 内の各シェル、nushell |

- プロファイルは `name / command / args / cwd / env / icon / color / shell_kind` を持つ
- 既定プロファイルは初回オンボーディングで選ぶ。初心者向けには OS ごとに推奨を 1 つ示す（Windows: PowerShell 7、macOS/Linux: ログインシェル）
- Windows のシェルごとの扱い（判断 J1、J5）
  - **cmd**: 起動はできるが「シェル統合なし」と表示する。オンボーディングの推奨には出さない。ブロック・説明・危険判定は入力推定（[02-architecture.md](02-architecture.md) §6 の方式 B）で動く範囲のみ
  - **Windows PowerShell 5.1**: 起動可。統合は PSReadLine 2.0 以上がある場合のみ有効。オンボーディングでは PowerShell 7 の導入を勧め、`winget install Microsoft.PowerShell` をワンクリックで入力欄に入れられる
  - **Git Bash / MSYS2**: 統合あり。パスは `/c/Users/...` と `C:\Users\...` を双方向に変換する（判断 J3。ファイルツリー、リンク検出、D&D で使用）

### 1.2 PTY

- Windows は ConPTY、Unix 系は `openpty`。`portable-pty` を使用
- 環境変数を追加注入: `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=otterm`, `TERM_PROGRAM_VERSION`, `OTTERM_SESSION_ID`
- リサイズはデバウンス 16 ms で `SIGWINCH` / `ResizePseudoConsole`
- 終了時の挙動は設定可: `close`（タブを閉じる）、`keep`（終了コードを表示して残す）、`restart`

### 1.3 セッション復元

- 終了時に `state/session.json` へ「タブ構成・ペイン分割・各ペインの CWD・プロファイル・タイトル・ウィンドウのサイズと位置」を保存
- 次回起動時に CWD へ移動した状態でシェルを再起動する（スクロールバックの復元は v1.x、ブロック単位で保存）
- ウィンドウのサイズと位置は記憶する（判断 I7）。保存したモニタが存在しなければ主モニタの中央に出す。既定サイズは 120 列 × 32 行相当

---

## 2. VT 描画

### 2.1 サポート範囲

- ECMA-48 / VT100 / VT220 の主要制御、xterm 拡張（256 色、TrueColor、マウス報告 1000/1002/1003/1006、ブラケットペースト、代替画面、タイトル設定、OSC 8 ハイパーリンク、OSC 52 クリップボード（設定で許可制））
- キーボードプロトコル（判断 I3）: 既定は xterm 互換。**アプリが要求したときだけ Kitty keyboard protocol を有効化**する（段階的対応）。`Ctrl+Shift+文字` など otterm が使わない組み合わせを TUI アプリへ正しく渡すために必要
- 代替画面でのマウスホイール（判断 I5）: アプリがマウス報告を要求していなければ、**ホイールを上下矢印キーに変換して送る**（`less`、`vim`、`man` でホイールが自然に効く）。マウス報告が有効なら生のマウスイベントを優先
- Sixel / iTerm2 画像 / Kitty graphics（Should）
- 準拠テストとして vttest の主要項目と、Alacritty / WezTerm のテストコーパスを参考にした自動テストを持つ

### 2.2 文字幅

- Unicode 16 の East Asian Width と絵文字シーケンス（ZWJ、VS16、肌色修飾）に対応
- 曖昧幅（Ambiguous）は設定で全角／半角を選択可（日本語環境の既定は半角、CJK ロケールでは全角を提案）

### 2.3 描画

- グリフアトラス（フォントごと、サイズごとにキャッシュ、LRU）
- セルの幅と高さは整数ピクセルに丸めて滲みを防ぐ。フォントサイズは CSS ピクセル単位で、OS の表示スケールに追従する（判断 I9）
- 60 fps 上限で差分描画。出力スループットが高い場合はフレームをまとめる（出力をフレーム単位でコアレスし、描画回数を落とす）
- フォントフォールバック: 設定した順に試し、見つからなければ OS のフォールバック機構を使う
- 文字の整形（シェーピング）とグリフのラスタライズは **Rust 側**（`rustybuzz` + `swash`）で行い、WebView には「グリフ ID と位置」と「アトラステクスチャ」だけを渡す。3 OS で同じ見た目になり、将来のネイティブレンダラでも描画以外のコードをそのまま使える（判断 C3、C4）
- リガチャ: 上記のシェーピングで処理。オフにできる

### 2.4 IME（日本語入力）

- **インライン変換**（判断 I4）。未確定文字列（プリエディット）は PTY に送らず otterm がカーソル位置に下線付きで描く。確定時にまとめてシェルへ送る
- 候補ウィンドウの位置は OS の IME API（Windows: TSF、macOS: NSTextInputClient、Linux: IBus / Fcitx の Wayland text-input）にカーソルのスクリーン座標を渡して合わせる
- 変換中は入力支援（補完・説明）を更新しない。確定後に 1 回だけ更新する
- 日本語ユーザーが主要層なので M1 で優先的に実装し、Windows の Microsoft IME、Google 日本語入力、macOS 日本語入力、Fcitx5-mozc で動作確認する

---

## 3. タブ・ペイン・ウィンドウ

### 3.1 構造

```
Window
 +- Workspace（省略可）
     +- Tab
         +- Pane ツリー（Split{dir, ratio, children} | Leaf{session}）
```

### 3.2 操作

| 操作 | 既定キー（Windows/Linux） | 備考 |
| --- | --- | --- |
| 新しいタブ | `Ctrl+Shift+T` | 既定プロファイル。`Ctrl+Shift+N` でプロファイル選択 |
| タブを閉じる | `Ctrl+Shift+W` | 実行中プロセスがあれば確認 |
| タブ移動 | `Ctrl+Tab` / `Ctrl+Shift+Tab` / `Ctrl+1..9` | |
| 縦分割／横分割 | `Ctrl+Shift+D` / `Ctrl+Shift+E` | 新ペインは同じ CWD で開く |
| ペイン移動 | `Alt+矢印` | |
| ペインのリサイズ | `Alt+Shift+矢印` またはドラッグ | |
| ペインの最大化トグル | `Ctrl+Shift+Z` | |
| ペインを別タブに分離 | ドラッグ | |

- タブはドラッグで並べ替え、別ウィンドウへ移動可
- タブ名は自動と手動の両方。色・アイコンを付けられる
- 自動タイトルの既定書式（判断 I10）: **待機中は「フォルダ名」、実行中は「コマンド名 · フォルダ名」**。シェルが OSC 0 / 2 でタイトルを設定した場合はそれを優先する。書式は `{cwd_name}`、`{command}`、`{profile}`、`{title}` を使ったテンプレートで変更可
- 「ブロードキャスト入力」（複数ペインへ同時入力）はトグル式で、オン中はペイン枠が黄色になる

### 3.3 ワークスペース

- プロジェクトごとに「タブ構成 + 既定 CWD + 有効 mod + テーマ上書き」を保存する単位
- `otterm open <dir>` で、そのディレクトリに `.otterm/workspace.toml` があればそれを読む。チームで共有可
- **ワークスペースの信頼**（判断 K4）: 初めて開くワークスペースでは「このフォルダの設定を信頼しますか？」を聞く。信頼する前は `tabs[].command` を実行せず、ワークスペース内の mod も無効にし、テーマ上書きだけを適用する。clone 直後に見知らぬコマンドが走ることを防ぐ。信頼の記録はパス単位でローカルに保存し、設定画面から取り消せる。親フォルダを信頼すると配下も信頼される

---

## 4. スクロールバックと検索

- 既定 10,000 行／セッション。設定で無制限（ディスクスピル）も可。スピル先はデータフォルダ内 `scrollback/`、合計上限は既定 1 GB で古いものから削除（判断 B12）。スピルは暗号化せず、**otterm 終了時に削除**する。セッション復元でスクロールバックを残す v1.x で暗号化を再検討（判断 K3）
- `Ctrl+Shift+F` で検索バー。プレーン／正規表現／大文字小文字／単語一致。ヒット位置をスクロールバーに表示
- 検索はブロック単位の絞り込み（「失敗したブロックのみ」「このコマンドの出力のみ」）が可能
- ブロックの折りたたみ状態は検索結果に影響しない（折りたたまれていても展開して表示）

---

## 5. 選択・コピー・ペースト・リンク

- クリック＋ドラッグ、ダブルクリック（単語）、トリプルクリック（行）、`Alt+ドラッグ`（矩形）
- 単語境界は設定可（既定では `/`, `:`, `=` などを境界にしない → パスや URL を一撃で選べる）
- コピー時は末尾空白を除去（設定可）
- コピー／ペーストのキー（判断 B4）
  - **Windows の既定**: `Ctrl+C` は「選択範囲があればコピー、なければ SIGINT」、`Ctrl+V` は貼り付け。Windows Terminal と同じ挙動で乗り換え時の混乱が少ない
  - **macOS / Linux の既定**: `Cmd+C` / `Cmd+V`（macOS）、`Ctrl+Shift+C` / `Ctrl+Shift+V`（Linux）。`Ctrl+C` は常に SIGINT
- 複数行貼り付けの確認: **改行を含む貼り付けのとき、ガイドレベル 1 以上で** 内容を表示して確認する。Lv0 はブラケットペーストに任せて確認しない（判断 B16）
- ブラケットペーストに対応したシェルには対応シーケンスを付けて送る
- 右クリック（判断 I1）: **既定はコンテキストメニュー**（コピー、貼り付け、ラコに聞く、パスやリンクを開く、ブロックの折りたたみ・再実行・保存）。初心者が機能を発見できる。Lv0 のみ Windows Terminal と同じ「右クリックで貼り付け」を既定にする。設定で変更可
- リンク検出
  - URL（`https?://`, `file://`）
  - ファイルパス（絶対・相対・`~`・Windows ドライブ）と `path:line[:col]` 形式。相対パスは CWD で解決し、存在確認して存在するものだけリンク化
  - `Ctrl+クリック`（macOS は `Cmd+クリック`）で既定アクション（URL はブラウザ、ファイルは「開く」設定に従う）。単クリックは選択操作と衝突するため使わない（判断 I2）。ホバーで下線とツールチップ「Ctrl+クリックで開く」を出し、Lv2 以上では初回にラコが案内する。右クリックでアクション選択
  - 検出ルールは mod で追加可能（例: Jira チケット番号、Git ハッシュ）

---

## 6. シェル統合とブロック

### 6.1 プロトコル

- 標準的な **OSC 133**（FinalTerm / iTerm2 / WezTerm 互換）を採用し、otterm 拡張を **OSC 7777** で追加
- 受信するシーケンス

| シーケンス | 意味 |
| --- | --- |
| `OSC 133;A` | プロンプト開始 |
| `OSC 133;B` | プロンプト終了（ユーザー入力開始） |
| `OSC 133;C` | コマンド実行開始（出力開始） |
| `OSC 133;D;<exit>` | コマンド終了。終了コード付き |
| `OSC 7;file://host/path` | CWD 通知 |
| `OSC 7777;cmd;<base64>` | 実行されるコマンド文字列（otterm 拡張） |
| `OSC 7777;line;<base64>` | 入力中の行（対応シェルのみ、otterm 拡張） |
| `OSC 7777;env;<base64 json>` | 任意のキー値（Git ブランチ等。mod 用） |

### 6.2 注入方法

- **既定は起動引数による注入**（判断 B6）。otterm が起動するシェルにだけフックを読み込ませ、ユーザーのファイルには触れない
  - bash: `--rcfile <otterm のラッパー>`（ラッパーの中でユーザーの `~/.bashrc` を source してからフックを読む）
  - zsh: `ZDOTDIR` を otterm の一時ディレクトリに向け、その `.zshrc` からユーザーの `$ZDOTDIR/.zshrc` を source してフックを読む
  - fish: `--init-command 'source <hook>'`
  - pwsh / Windows PowerShell: `-NoExit -Command <フック文字列>`。ファイル実行を避けることで実行ポリシーが Restricted でも動く
  - nushell: `--config` / `--env-config` の追加読み込み
  - cmd: 統合不可。通常のターミナルとして動く（ブロック機能なし）
- 環境変数 `OTTERM_SHELL_INTEGRATION=1` を渡し、フック側は二重読み込みを防ぐ
- **rc ファイルへの 1 行追記はオプトイン**。「他のターミナルから起動したシェルでも otterm の統合を使いたい」人向けに設定画面から行う。追記内容を表示し、「元に戻す」ボタンを用意する
- フックスクリプトは `shell-integration/` に置き、署名付き。ユーザーが中身を読めるよう「スクリプトを表示」ボタンを用意

### 6.3 ブロック

- 1 ブロック = プロンプト + コマンド + 出力 + 終了コード + 経過時間 + CWD
- 表示スタイル（判断 B2）
  - **既定は従来どおりの連続表示**。テキストの流れは普通のターミナルと同じで、左端のガターだけで区切りを示す。tmux や TUI と見た目が衝突しない
  - Warp のようにブロックごとに余白と枠を付ける表示は、レイアウトプリセット `cards` として用意する（[04-ui-theme.md](04-ui-theme.md)）
- UI 表示
  - ブロック左端に細いガター。成功は無色、失敗は赤、実行中は青のアニメーション
  - ガターにホバーで「折りたたむ／コピー／再実行／出力を保存／共有（テキスト化）」
  - 共有の形式（判断 I11）: **既定は Markdown**（コマンドと出力をコードブロックに、終了コード・CWD・日時・所要時間をメタとして付ける）。プレーンテキストと HTML も選べる
  - 出力の保存先（判断 I12）: 既定は OS のダウンロードフォルダ、ファイル名は `otterm-<コマンド名>-<YYYYMMDD-HHmmss>.txt`。保存ダイアログで変更可
  - 長い出力（既定 200 行超）は自動で中央を省略表示。クリックで展開
- 操作
  - `Ctrl+Up/Down` でブロック間ジャンプ
  - ブロック内のみを選択する「ブロック選択」モード
- 統合が効いていないときはブロック機能は静かに無効になり、UI に「シェル統合が無効です（設定）」を小さく出す

---

## 7. コマンドパレット

- `Ctrl+Shift+P` で開く。あいまい検索。最近使った順に並ぶ
- 登録される項目
  - 本体操作（タブ、ペイン、設定、テーマ切替、mod 管理）
  - プロファイル起動
  - mod が登録したコマンド
  - ワークフロー
  - 設定項目（「フォントサイズ」と打てばその設定に飛べる）
- プレフィックス
  - `>`：コマンド（既定）
  - `:`：行番号ジャンプ
  - `?`：ヘルプ検索
  - `@`：ファイルを開く（CWD 以下）
  - `#`：ブロックを検索
  - `!`：シェルコマンドをそのまま実行

---

## 8. 入力支援（同梱 mod 群）

### 8.0 入力欄の方式（判断 B1）

- **シェル自身の行編集（readline / zle / fish / PSReadLine）をそのまま使う**。キー入力はシェルに直接届き、otterm は入力行のコピー（シェル統合の `OSC 7777;line` または推定）に対して支援 UI を重ねる
- 理由: 「普通のターミナルとして動く」を守れる。ユーザーが入れている zsh-autosuggestions や fzf、vi モードなどのシェル側の拡張が壊れない
- 例外: `Shift+Enter` で複数行エディタ（8.6）に入ったときだけ、otterm 独自の入力ボックスに切り替わり、確定時にまとめてシェルへ送る
- 支援 UI（補完ポップアップ、説明、危険バナー）は入力行の **下** に出し、シェルのプロンプト行を隠さない
- **パスワード入力の検出**（判断 K2）: PTY のエコーオフ（termios の `ECHO` フラグ、ConPTY では対応する入力モード）を検出したら、その間は入力支援を止め、入力内容を実行記録にも残さない。ラコは `calm` のまま何も言わない。`sudo`、`ssh`、`gh auth login` などのパスワード入力がこれに該当する

### 8.1 cmd-explain（コマンド説明）

- 入力行をパースし、「コマンド名」「サブコマンド」「オプション」「引数」に分解する
- 同梱の **コマンド辞書**（JSON、日本語・英語）を引き、1〜2 文で説明を出す
  - 例: `git push -f origin main` → 「ローカルの main ブランチを origin に送ります。`-f` は履歴の不一致を無視して上書きします（危険）」
- 辞書は mod で追加・上書き可能
- 辞書にないコマンドの扱い（判断 B9）: **入力中には `--help` を実行しない**。未知のコマンドを裏で起動するのは副作用の危険がある（`--help` を解釈せず動き出すツールがある）。そのコマンドをユーザーが一度実行した後に、`--help` と `man` の冒頭をバックグラウンドで取得してキャッシュし、次回以降の説明に使う。入力中は「辞書にないコマンドです」とだけ表示する
- 同梱辞書 `dictionary-core` の v1.0 収録範囲（判断 G1）。下書きとして **164 コマンド、サブコマンド 450、オプション 1,164、エラー助言 813、危険マーク 117** を [mods/dictionary-core/dictionary/commands/](../mods/dictionary-core/dictionary/commands/) に書き終えている

| 分類 | 件数 | 例 |
| --- | --- | --- |
| ファイル・テキスト・システム操作（coreutils 系） | 61 | ls, cd, pwd, cp, mv, rm, mkdir, cat, less, grep, find, sed, awk, tar, zip, chmod, ps, kill, ssh, scp, rsync, curl, wget, sudo |
| git | 1（サブコマンド 17） | status, add, commit, push, pull, fetch, branch, checkout, switch, merge, rebase, log, diff, stash, reset, clone, remote |
| パッケージ・ツールチェーン管理 | 36 | npm, pnpm, yarn, bun, npx, pip, uv, poetry, conda, cargo, rustup, brew, winget, scoop, choco, apt, dnf, pacman, nix, gem, composer, nvm, mise, mvn, gradle, dotnet, go |
| コンテナ・インフラ | 5 | docker（compose 含む）, kubectl, helm, terraform, ngrok |
| 言語ランタイム・開発ツール | 27 | python, node, deno, java, javac, ruby, perl, php, gcc, g++, make, cmake, tsc, rustc, swift, kotlinc, gh, code, vim, nano, jq, tmux, ssh-keygen, openssl |
| Windows / PowerShell 固有 | 34 | Get-ChildItem, Remove-Item, Get-Content, Set-Content, Copy-Item, Move-Item, New-Item, Select-String, Get-Process, Stop-Process, Invoke-WebRequest, Where-Object, ForEach-Object, Select-Object, Set-ExecutionPolicy, ipconfig, tasklist, taskkill |

- 辞書の品質基準: すべての文字列が日英、危険マークには必ずメッセージ、エラーパターンは正規表現としてコンパイル可能で、ヒント内の `{name}` はパターンの名前付きグループと一致すること。検証スクリプトを CI に載せる

- 辞書の形式は JSON。1 コマンド = 1 ファイルで、`name / aliases / summary / subcommands / options（型・説明・危険度・代替案）/ args / examples / errors（エラーパターンと助言）/ learn（GUI 操作の学習ヒント）/ install（未導入時の入れ方）` を持つ。1 ファイルで説明・補完・危険判定・エラー助言の 4 機能を賄う。スキーマは [packages/api/schemas/dictionary.schema.json](../packages/api/schemas/dictionary.schema.json)、辞書の本体は [mods/dictionary-core/dictionary/](../mods/dictionary-core/dictionary/) にある。検証は `just validate`（[tests/dictionary/validate-dictionary.js](../tests/dictionary/validate-dictionary.js)）
- 辞書内の文字列は `{ "ja": "...", "en": "..." }` の **インライン多言語** で書く。UI とラコの台詞は Fluent（判断 C7）だが、辞書はコミュニティが 1 ファイルずつ書くものなので、翻訳キーを別ファイルに分けると書きにくい
- コマンド横断の危険ルール（`curl | sh`、fork bomb、`sudo rm` など）は辞書とは別の `rules/*.json` に置く（[mods/dictionary-core/dictionary/rules/core.json](../mods/dictionary-core/dictionary/rules/core.json)）
- ガイドレベル 0 では非表示、1 では危険時のみ、2〜3 では常時表示

### 8.2 completion（補完ポップアップ）

- 入力中に候補を出す。候補ソース
  1. コマンド辞書（サブコマンド・オプション・説明付き）
  2. `PATH` 上の実行ファイル
  3. CWD 以下のファイル／ディレクトリ
  4. 履歴
  5. mod が提供する動的ソース（例: `git checkout <ブランチ名>`、`docker exec <コンテナ名>`）
- `Tab` キーの扱い（判断 B3）: **ガイドレベル 0〜2 では `Tab` をシェルの補完に渡す**。otterm の候補は `Ctrl+Space` または矢印キーで選び `Enter` で確定。**ガイドレベル 3 だけは `Tab` で otterm の候補を確定**する（Lv3 の人はシェル補完をまだ知らないため、1 つのキーで済ませる）。設定 `assist.completion.key` で個別に上書き可
- 候補に説明と「危険」「推奨」バッジ

### 8.3 danger-guard（危険ガード）

- ルールは `severity`（warn / confirm / block）と `pattern`（コマンド構造へのマッチ、正規表現も可）で定義
- 同梱ルール例

| コマンド | severity | メッセージ | 代替案 |
| --- | --- | --- | --- |
| `rm -rf` / `rm -r` / `Remove-Item -Recurse` | confirm | 中身がすべて消え、ゴミ箱に入りません | 「ゴミ箱に送る」ボタン。入力欄のコマンドを `otterm trash <同じ引数>` に **書き換えて見せてから** 実行する（判断 B8）。何が実行されたかが履歴に残り、学習にもなる。`otterm trash` は CLI のサブコマンドで単体でも使える |
| `git push --force` / `-f` | confirm | リモート履歴を上書きします | `--force-with-lease` に置換 |
| `git reset --hard` | confirm | 未コミットの変更が消えます | `git stash` を提案 |
| `chmod -R 777` | warn | すべてのユーザーに書き込み権限を与えます | |
| `sudo` + 上記 | confirm | | |
| `DROP TABLE` / `DROP DATABASE` | confirm | | |
| `:(){ :|:& };:` 等の fork bomb | block | | |
| `curl ... | sh` | confirm | ダウンロードした内容をそのまま実行します | 「先に中身を見る」 |
| `format` / `diskpart` / `mkfs` / `Format-Volume` / `Clear-Disk` | confirm | | |
| `Remove-Item` + `-Force` + `$env:USERPROFILE` や `C:\` 直下 | confirm | ユーザーフォルダ以上の範囲を消そうとしています | |
| `reg delete` / `Remove-ItemProperty -Path HKLM:` | confirm | レジストリを変更します。元に戻せない場合があります | 「先にエクスポートする」 |
| `Set-ExecutionPolicy Unrestricted` | warn | すべてのスクリプトが実行できるようになります | `RemoteSigned` を提案 |
| `Stop-Process -Name explorer` / `taskkill /f /im` | warn | | |
| `Invoke-Expression (Invoke-WebRequest ...)` / `iex (iwr ...)` | confirm | ダウンロードした内容をそのまま実行します | 「先に中身を見る」 |

- Windows / PowerShell 固有のルールを同梱に含める（判断 G5）。PowerShell ユーザーが初心者層の中心になるため
- 確認ダイアログは「実行」「代替案で実行」「やめる」。「今後このコマンドは確認しない」チェックあり（ルール単位）
- ガイドレベル 0 では block のみ、1 では confirm 以上、2〜3 では warn も表示

### 8.4 error-hint（エラー助言）

- ブロック終了時、終了コードが非 0 の場合に出力をパターン照合し、助言カードを出す
- 同梱パターン例
  - `command not found` / `is not recognized` → 「`xxx` が見つかりません。インストール方法: …」。パッケージマネージャは **`PATH` から検出したものを優先**し（winget / scoop / choco / brew / apt / dnf / pacman / nix）、複数あれば候補を並べる（判断 B11）
  - `Permission denied` → 権限説明と `sudo` の注意
  - `No such file or directory` → パスの確認、`ls` を提案、ファイルツリーをハイライト
  - `fatal: not a git repository` → `git init` か正しいフォルダへの移動を提案
  - `EADDRINUSE` → ポートを使っているプロセスの表示ボタン
  - `ModuleNotFoundError` → `pip install` 提案
- 助言カードには「コマンドを入力欄に入れる」ボタン。勝手には実行しない
- パターンは mod で追加可能

### 8.5 history-search（履歴）

- `Ctrl+R` で otterm 独自の履歴 UI（シェルの履歴と otterm の実行記録を統合）。**ガイドレベル 1 以上で `Ctrl+R` を奪い、Lv0 はシェルに渡す**（判断 B5）。fzf や atuin を使っている人は Lv0 か個別設定で戻せる
- 列: コマンド、CWD、終了コード、実行日時、所要時間
- フィルタ: CWD 一致、成功のみ、今日、このワークスペース
- 選択で入力欄へ挿入（即実行はしない）
- 実行記録の保存（判断 K1）
  - otterm 独自の実行記録（コマンド文字列、CWD、終了コード、開始時刻、所要時間、プロファイル、ワークスペース）を **SQLite** に保存する。保存先はデータフォルダ内 `history.sqlite`、暗号化なし
  - 保持期間は既定 90 日。設定で変更・無期限・オフにできる。オフにすると履歴 UI はシェルの履歴ファイルだけを使う
  - 保存前に AI マスク（[10-ai-assist.md](10-ai-assist.md) §4.2）と同じ正規表現でトークンやパスワード風の引数を `[REDACTED]` に置き換える
  - エコーオフ中の入力（K2）は保存しない
  - 出力本文は保存しない（スクロールバックとは別。出力の保持は v1.x のセッション復元で扱う）

### 8.6 multiline-editor（複数行入力）

- `Shift+Enter` で改行。入力欄が内蔵エディタに切り替わり、シェル構文のハイライトと簡易チェック（クォート閉じ忘れ等）
- 実行時は 1 行ずつではなく、まとめてシェルに渡す（ヒアドキュメント・継続行を保持）

---

## 9. ファイル操作（同梱 mod: file-tree）

### 9.1 ファイルツリーパネル

- 左右どちらかのサイドパネルに表示。CWD を自動追従（ピン留めで固定も可）
- 表示: アイコン（拡張子別）、サイズ、更新日時（列はトグル）、Git ステータス（git mod 導入時）
- 隠しファイル表示トグル、`.gitignore` 考慮トグル
- **WSL との統合**（判断 J2、v1.0 に含める）: WSL セッションの CWD（例 `/home/user/proj`）を Windows パス（`\\wsl$\Ubuntu\home\user\proj`）に変換してツリーに表示する。「開く」は Windows 側のエディタや既定アプリで開く。変換は `wslpath` 相当を otterm 側で実装し、ディストリ名はプロファイルから取る。逆方向（Windows パスを WSL パスに変換して挿入）は D&D 時に行う

### 9.2 操作とコマンド学習

| GUI 操作 | 実行内容 | 表示される学習ヒント |
| --- | --- | --- |
| フォルダをダブルクリック | **Lv2 以上**: シェルに `cd "path"` を送る（学習になる）。**Lv0〜1**: ツリーだけ移動し、シェルには送らない。ピン留めでどちらにも固定可（判断 B10） | 「`cd` でフォルダを移動しました」 |
| ファイルをダブルクリック | 「開く」設定（既定アプリ／エディタ／内蔵プレビュー） | |
| ファイルを右クリック → 「実行」 | 拡張子に応じたコマンドを入力欄に挿入（`.py` → `python`, `.js` → `node`, `.sh` → `bash`, `.ps1` → `pwsh -File`） | 挿入のみ。Enter はユーザー |
| 新規ファイル／フォルダ | otterm が直接作成 | 「`touch` / `mkdir` と同じことをしました」 |
| リネーム | 直接 | 「`mv` と同じ」 |
| 削除 | **ゴミ箱へ**。Shift で完全削除（確認） | 「`rm` は元に戻せません。otterm はゴミ箱に送りました」 |
| ドラッグ → ターミナル | クォート済みパスを挿入 | |
| 右クリック → 「パスをコピー」 | 絶対／相対を選択 | |

- 学習ヒントは「コマンドを表示」設定で、実際のコマンド文字列をステータスに流す。ガイドレベル 0 では出さない

### 9.3 プレビュー

- テキスト（構文ハイライト）、画像、Markdown、CSV（表）、JSON（折りたたみ）、PDF（1 ページ目）
- 上限（判断 G4）: テキスト 1 MB、画像 20 MB、PDF 20 MB。超えたら「エディタ／既定アプリで開く」を促す
- プレビューは読み取り専用。「エディタで開く」ボタンあり

### 9.4 「開く」設定

- 拡張子 → アクションのマップ。既定: テキスト系は設定したエディタ（VS Code を自動検出）、画像は内蔵プレビュー、それ以外は OS 既定
- エディタは `code -g {path}:{line}:{col}` のようなテンプレートで登録。VS Code / Cursor / Sublime / vim / nvim / Zed / JetBrains 系は同梱プリセット
- エディタの検出順（判断 I16）: `PATH` 上の `code` / `cursor` / `zed` / `subl` / `nvim` → 既知のインストール先（Windows: `%LOCALAPPDATA%\Programs\*`、`%ProgramFiles%\*`、macOS: `/Applications/*.app`、Linux: `/usr/bin`、`~/.local/bin`、Flatpak の `flatpak run`）→ 見つからなければ OS 既定。検出結果は設定画面で確認・変更できる

---

## 10. ワークフロー（同梱 mod: workflows）

- 「名前・説明・コマンドテンプレート・引数定義」からなる定型コマンド
- 例

```toml
[[workflow]]
name = "Git: 新しいブランチを作って切り替える"
command = "git checkout -b {{branch}}"
[workflow.args.branch]
label = "ブランチ名"
type = "string"
placeholder = "feature/xxx"
```

- 実行するとフォームが出て、埋めると入力欄にコマンドが入る（即実行は設定でオプトイン）
- サイドパネルに「ボタン化」でき、初心者は押すだけで使える
- ワークフロー集は mod として配布（例: 「Docker 入門セット」「Git 日常セット」）

---

## 11. オンボーディングとガイドレベル

### 11.1 初回起動フロー

1. 言語選択
2. 「ターミナルは初めて？」→ ガイドレベルの提案（判断 B7）。「はじめて」→ Lv3、「たまに使う」→ Lv2、「毎日使う」→ Lv1。**オンボーディングをスキップした場合は Lv1**（スキップするのは上級者が多いため）
3. シェルの選択（推奨を強調）
4. シェル統合の説明（既定の起動引数注入は許可不要。「他のターミナルでも使う」ための rc 追記だけがここで選べる）
5. テーマ選択（ライト／ダーク／OS 追従、プレビュー付き）
6. ネットワーク利用の確認（更新確認を行うか。既定はオン。mod レジストリへの接続はストアを開いたときに別途確認）
7. 「はじめてのターミナル」チュートリアルへの誘導（スキップ可）
8. 「ラコに AI の力を貸しますか？」（既定は「あとで」。[10-ai-assist.md](10-ai-assist.md)）

### 11.2 ガイドレベル定義

| レベル | 名称 | 挙動 |
| --- | --- | --- |
| 0 | オフ | 独自 UI なし。確認は block ルールのみ。パネルは閉じた状態 |
| 1 | ライト | 危険時のみ説明と確認。ファイルツリーは閉じた状態。エラー助言はあり |
| 2 | スタンダード（既定） | 入力中のコマンド説明を常時表示。ファイルツリーを開いた状態。複数行貼り付け確認 |
| 3 | フル | 2 に加え、各 UI に `?` 表示、GUI 操作時のコマンド学習ヒント常時、チュートリアル推奨 |

- レベルは設定画面とステータスバーからいつでも変更可。レベルは「ヒント量のプリセット」であり、個別設定で上書きできる

### 11.3 チュートリアル（同梱 mod: onboarding）

- 実際のシェルで打たせる対話式。各ステップで「期待するコマンド」をブロック結果で判定して進む
- 章立て（判断 G3 で 6 章に確定）と各章の期待コマンド・成功判定

| 章 | 期待するコマンド（bash 系 / PowerShell） | 成功判定 |
| --- | --- | --- |
| 1. ここはどこ？ | `pwd` / `Get-Location`、`ls` / `Get-ChildItem` | 終了コード 0、出力にチュートリアル用フォルダ名が含まれる |
| 2. 移動する | `cd tutorial`、`cd ..` | CWD 通知（OSC 7）がそのパスになる |
| 3. ファイルを作る・見る | `echo hello > hello.txt` / `"hello" > hello.txt`、`cat` / `Get-Content` | ファイルが存在し、出力に `hello` |
| 4. プログラムを動かす | `python hello.py`（python が無ければ `node` か `pwsh` の 1 行で代替） | 終了コード 0、出力に期待文字列 |
| 5. 困ったとき | `sleep 100` を `Ctrl+C` で止める、`cat nothing.txt` のエラーを読む | 終了コード 130、エラー助言カードが出る |
| 6. otterm の便利機能 | 履歴検索、ファイルツリーから開く、ブロックの再実行 | 各 UI 操作のイベント |

- 期待コマンドは正規表現で複数の書き方を許容する（`ls -la` も可）。判定はブロック結果（コマンド文字列、終了コード、出力パターン、CWD）で行う
- 進捗は保存され、途中再開可。チュートリアル用フォルダは `~/otterm-tutorial/` に作り、終了時に削除を提案する
