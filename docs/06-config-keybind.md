# 06. 設定・キーバインド仕様（Config & Keybindings）

## 1. 設定ファイルの場所

| OS | ユーザー設定 | データ（mod、状態、ログ） |
| --- | --- | --- |
| Windows | `%APPDATA%\otterm\config.toml` | `%LOCALAPPDATA%\otterm\` |
| macOS | `~/Library/Application Support/otterm/config.toml`（`~/.config/otterm/` があれば優先） | 同左 |
| Linux | `$XDG_CONFIG_HOME/otterm/config.toml` | `$XDG_DATA_HOME/otterm/` |
| ポータブル版 | `<実行ファイル>/portable/config.toml` | `<実行ファイル>/portable/` |

- ワークスペース設定: `<プロジェクト>/.otterm/workspace.toml`（ユーザー設定より優先。チームで共有可。`terminal.write` 権限の mod はワークスペース側では有効化できない）
- ワークスペースは初回に「信頼しますか」を聞く。信頼前は `tabs[].command` の実行とワークスペース mod の有効化を行わない（判断 K4、[03-core-features.md](03-core-features.md) §3.3）。信頼の記録は `state/trusted-workspaces.json`
- 読み込み優先度: 既定値 < ユーザー設定 < ワークスペース設定 < コマンドライン引数

## 2. `config.toml` 全体像

```toml
schema = 1                          # 設定スキーマのバージョン（マイグレーション用）

[general]
language = "ja"                     # ja | en | auto
guide_level = 2                     # 0-3
check_updates = true                # オンボーディングで確認。これ以外に otterm が自発的に外部へ接続することはない
restore_session = true
confirm_close_running = true
# telemetry 設定は存在しない。otterm は利用状況を一切送信しない（判断 H4）

[appearance]
theme = "otterm Dark"
theme_light = "otterm Light"        # OS 追従時のライト側
follow_system = true
minimum_contrast = 3.0              # 背景と近すぎる文字色を読める色に寄せる（1 = しない、最大 21）
renderer = "auto"                   # auto（WebGL2、使えなければ Canvas 2D）| webgl | canvas。次に開くペインから効く
layout = "guided"                   # minimal | classic | guided | ide | <custom name>
ui_scale = 1.0
tabbar.position = "top"             # top | bottom | left | hidden-when-single
sidebar.left.visible = true
sidebar.left.width = 260
sidebar.right.visible = false
panel.bottom.visible = false
statusbar.visible = true
window.opacity = 1.0                # 既定は不透過（判断 I6）
window.blur = false
window.padding = 12

[font]
family = ["Cascadia Code", "Noto Sans Mono CJK JP", "Symbols Nerd Font"]
size = 14
weight = 400
weight_bold = 700
line_height = 1.2
letter_spacing = 0
ligatures = true

[terminal]
scrollback = 10000                  # 0 で無制限（ディスクスピル）
scrollback_spill_limit_mb = 1024    # スピル先の合計上限。古いものから削除
cursor.style = "block"              # block | underline | bar
cursor.blink = true
bell = "visual"                     # none | visual | sound | both
copy_on_select = false
trim_trailing_whitespace = true
confirm_multiline_paste = true
word_separators = " \t\"'`()[]{}<>|&;"
ambiguous_width = "narrow"          # narrow | wide
osc52_clipboard = "ask"             # allow | deny | ask
images = true
close_behavior = "close"            # close | keep | restart
fold_lines = 200                    # これより長い出力は中央を折りたたむ（docs/03 §6.3）。0 で無効

[shell]
default_profile = "pwsh"
integration = true
integration_install = "args"        # args（起動引数で注入、既定。ユーザーのファイルを触らない）| rc（起動ファイルに 1 行追記、オプトイン）| manual
prompt = "otterm"                   # otterm（otterm がプロンプトバーを描き、シェルは ❯ だけ。判断 M4）| shell（シェルや Oh My Posh のプロンプトのまま）

[[profiles]]
id = "pwsh"
name = "PowerShell 7"
command = "pwsh.exe"
args = ["-NoLogo"]
icon = "powershell"
color = "#4f8cff"

[[profiles]]
id = "wsl-ubuntu"
name = "Ubuntu (WSL)"
command = "wsl.exe"
args = ["-d", "Ubuntu"]
cwd = "~"

[mascot]
visible = "auto"                    # auto（ガイドレベルに従う）| always | never
position = "assist-bar"             # assist-bar | statusbar | float | hidden
speech = "auto"                     # auto | always | alert-only | never
mood_changes = true
happy_threshold_ms = 10000          # これ以上かかった処理の成功時だけ喜ぶ
outfit = "default"

[assist]
explain = "auto"                    # off | danger-only | always | auto（ガイドレベルに従う）
completion = true
completion.key = "auto"             # auto（Lv0〜2 は ctrl+space、Lv3 は tab）| ctrl+space | tab
history_key = "auto"                # auto（Lv1 以上で ctrl+r を otterm が使う）| otterm | shell
danger_guard = true
error_hint = true

[open]
editor = "code"                     # プリセット名 or テンプレート
editor_template = "code -g {path}:{line}:{col}"
rules = { ".md" = "preview", ".png" = "preview", ".pdf" = "system" }

[history]                           # 実行記録（判断 K1）
enabled = true
retention_days = 90                 # 0 で無期限
redact_secrets = true

[keybindings]
alt_screen_passthrough = true       # 代替画面中は TUI アプリにキーを優先して渡す

[keybindings.bindings]              # アクション ID → キー。配列で複数、空配列で解除
"tab.new" = "ctrl+shift+t"
"pane.split.vertical" = ["ctrl+shift+d"]
"guide.help_mode" = []

[[keybindings.custom]]              # 引数と when 条件付きの割当
key = "ctrl+enter"
command = "workflow.run"
args = { name = "deploy" }
when = "terminalFocus && !altScreen"

[ai]                                # 公式 mod otterm.ai-assist の設定。既定オフ
enabled = false
provider = "local"                  # local | claude | openai | gemini | openai-compatible
endpoint = "http://localhost:11434" # local / openai-compatible のとき
model = ""
# API キーはこのファイルに書かず OS のキーチェーンに保存する
preview_first_n = 5
redact_secrets = true
log_retention_days = 30
question_prefix = false             # 入力行の ? プレフィックス（判断 F1、既定オフ）

[mods]
enabled = ["otterm.file-tree", "otterm.cmd-explain", "example.git-status-bar"]
disabled = []
auto_update = false

[mods.settings."example.git-status-bar"]
show_dirty_count = true
refresh_interval = 5

[workspace]                         # workspace.toml 側で使う
name = "my-project"
cwd = "."
tabs = [
  { name = "dev",  profile = "pwsh", command = "pnpm dev" },
  { name = "test", profile = "pwsh" },
]
```

## 3. 設定の扱い

- **スキーマ駆動**: 全設定項目は **Rust の設定構造体から `schemars` で JSON Schema を生成**し（型・既定値・範囲・説明の翻訳キー・再起動要否を属性で付ける）、設定画面はそのスキーマから自動生成する。コードと設定画面と既定値が常に一致する。mod の設定は `otmod.toml` の `[settings.schema]`（JSON Schema のサブセット）で受け取り、同じ形に変換して同じ UI で表示する（判断 C6）
- **双方向**: GUI での変更は TOML に書き戻す。TOML を手で変えると GUI にも即反映（ファイル監視）。コメントと並び順は保持する（`toml_edit` 使用）
- **検証**: 壊れた値は既定値にフォールバックし、どのキーが無視されたかを起動時に通知
- **マイグレーション**: `schema` 番号で管理。更新時に自動変換し、バックアップ（`config.toml.bak-<version>`）を残す
- **エクスポート／インポート**: 設定 + テーマ + mod リスト + キーバインドを 1 つの zip に。dotfiles にも置けるよう TOML はそのまま
- **リセット**: 項目単位・カテゴリ単位・全体で「既定に戻す」

## 4. コマンドライン

```
otterm [path]                      # path を CWD にして起動（workspace.toml があれば読む）
otterm -e <command...>             # コマンドを実行するタブで起動
otterm --profile <id>
otterm --safe-mode                 # テーマ・mod を無効化
otterm --config <file>
otterm mod install|remove|list|enable|disable|update|publish|doctor|link
otterm theme import <file>         # iTerm2 / Windows Terminal / VS Code / Alacritty / WezTerm から変換
otterm config get|set|path|export|import
otterm workflow run <name>
otterm trash <path...>             # ゴミ箱へ送る。danger-guard の「ゴミ箱に送る」が rm をこれに書き換える。単体でも使える
otterm ask [question]              # コツメに聞く（AI mod が有効なとき）。引数なしで対話プロンプト
```

- 既に起動している場合はそのインスタンスに新タブとして開く（単一インスタンス、`--new-window` で別窓）
- CLI と GUI の通信（判断 K6）: OS ネイティブの IPC（Windows: 名前付きパイプ、macOS / Linux: Unix ドメインソケット）。GUI は起動ごとにランダムなトークンをデータフォルダに書き（所有者のみ読み取り可）、CLI はそれを添えて接続する。同一ユーザー以外は接続できない

## 5. キーバインド

### 5.1 表記

- `ctrl+shift+t`、`alt+arrowleft`、`cmd+k`（macOS）、チョード `ctrl+k ctrl+s`（空白区切り）
- `mod` は Windows/Linux で `ctrl`、macOS で `cmd` に展開される

### 5.2 既定キー（Windows / Linux。macOS は `ctrl+shift` → `cmd`）

| アクション ID | キー |
| --- | --- |
| `tab.new` | `ctrl+shift+t` |
| `tab.new.profile` | `ctrl+shift+n` |
| `tab.close` | `ctrl+shift+w` |
| `tab.next` / `tab.prev` | `ctrl+tab` / `ctrl+shift+tab` |
| `tab.goto.<1-9>` | `ctrl+1` 〜 `ctrl+9` |
| `pane.split.vertical` / `pane.split.horizontal` | `ctrl+shift+d` / `ctrl+shift+e` |
| `pane.focus.<dir>` | `alt+arrow<dir>` |
| `pane.resize.<dir>` | `alt+shift+arrow<dir>` |
| `pane.zoom` | `ctrl+shift+z` |
| `pane.close` | `ctrl+shift+q` |
| `copy` / `paste` | Windows: `ctrl+c`（選択範囲があるとき）/ `ctrl+v`。Linux: `ctrl+shift+c` / `ctrl+shift+v`。macOS: `cmd+c` / `cmd+v`（判断 B4） |
| `search` | `ctrl+shift+f` |
| `palette` | `ctrl+shift+p` |
| `history` | `ctrl+r`（Lv1 以上で otterm が使う。Lv0 はシェルへ。判断 B5） |
| `completion.trigger` | `ctrl+space`（Lv3 は `tab` も確定キーになる。判断 B3） |
| `ai.ask` | `ctrl+shift+space`（AI mod 有効時のみ。コツメのクリックでも開く。判断 F1） |
| `mascot.toggle` | `ctrl+shift+m` |
| `block.prev` / `block.next` | `ctrl+arrowup` / `ctrl+arrowdown` |
| `block.collapse` | `ctrl+shift+[` |
| `font.bigger` / `font.smaller` / `font.reset` | `ctrl+=` / `ctrl+-` / `ctrl+0` |
| `sidebar.left.toggle` / `sidebar.right.toggle` | `ctrl+shift+b` / `ctrl+alt+b`（`ctrl+b` はシェルが使うため。判断 M12） |
| `panel.bottom.toggle` | `ctrl+shift+j`（`ctrl+j` は改行のため。判断 M12） |
| `focus.next_region` / `focus.prev_region` | `f6` / `shift+f6`（ターミナル → 開いているパネル → ステータスバー） |
| `settings` | `ctrl+,` |
| `guide.help_mode` | `f1` |
| `window.fullscreen` | `f11` |
| `clear` | `ctrl+l`（シェルへパススルー + スクロールバックは保持） |

### 5.2.1 macOS の既定キー（判断 I14）

| アクション | キー | 備考 |
| --- | --- | --- |
| `tab.new` / `tab.close` / `tab.new.profile` | `cmd+t` / `cmd+w` / `cmd+n` | |
| `tab.goto.<1-9>` | `cmd+1` 〜 `cmd+9` | |
| `pane.split.vertical` / `pane.split.horizontal` | `cmd+d` / `cmd+shift+d` | |
| `pane.focus.<dir>` | `cmd+alt+arrow<dir>` | `alt+arrow` はシェルの単語移動のために奪わない |
| `pane.resize.<dir>` / `pane.zoom` / `pane.close` | `cmd+alt+shift+arrow<dir>` / `cmd+shift+enter` / `cmd+shift+w` | 2026-10-11 実装時に決めた既定（iTerm2 の最大化キーに合わせた） |
| `copy` / `paste` | `cmd+c` / `cmd+v` | `ctrl+c` は常に SIGINT |
| `search` / `palette` / `settings` | `cmd+f` / `cmd+shift+p` / `cmd+,` | |
| `history` / `completion.trigger` / `ai.ask` | `ctrl+r` / `ctrl+space` / `cmd+shift+space` | |
| `font.bigger` / `font.smaller` / `font.reset` | `cmd+=` / `cmd+-` / `cmd+0` | |
| `sidebar.left.toggle` / `panel.bottom.toggle` | `cmd+b` / `cmd+j` | |
| `window.fullscreen` | `ctrl+cmd+f` | macOS 標準 |

### 5.3 競合の扱い

- ターミナルアプリ（vim 等）が必要とするキーは、代替画面中は既定で **シェルに優先して渡す**（`ctrl+b`、`ctrl+j`、`ctrl+l` など）。otterm の割当は「通常画面かつ入力待ち」のときだけ効く。設定で `always` に変更可
  - M1 の実装（2026-10-11、issue #5）: 代替画面中も otterm が使うのは `Ctrl+Shift+…` と `Cmd+…` の割当だけで、`Alt+矢印`・`Ctrl+Tab`・`Ctrl+数字` はアプリに渡す（`keybindings.alt_screen_passthrough = false` で常に otterm）。移動先のペインがないときのペイン移動・リサイズのキーも、シェルに渡す
- 設定画面のキーバインドタブで競合を赤表示。「キーを押して記録」で設定
- mod が提案するキーはユーザー設定と競合すると無効になり、設定画面で解決を促す

### 5.4 キーバインドのスコープ

| when 条件 | 意味 |
| --- | --- |
| `terminalFocus` | ターミナル領域にフォーカス |
| `altScreen` | 代替画面（TUI）中 |
| `inputEmpty` | 入力行が空 |
| `paletteOpen` / `panelFocus` / `fileTreeFocus` | 各 UI にフォーカス |
| `guideLevel >= 2` | ガイドレベル条件 |

記法は 2 章の `[keybindings.bindings]`（アクション ID → キー）と `[[keybindings.custom]]`（引数・when 条件付き）の 2 形式。設定の Rust 構造体は [crates/otterm-config/src/schema.rs](../crates/otterm-config/src/schema.rs) を参照。
