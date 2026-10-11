---
title: キーバインド
description: 既定のキー、キーの書き方、when 条件、キーの変更の仕方。
sidebar:
  order: 4
---

キーは設定画面の「キーバインド」タブで変えられます。「キーを押して記録」で新しいキーを登録すると、競合は赤く表示されます。設定ファイルで書くこともできます。

## 書き方

- 単独のキー: `ctrl+shift+t`、`alt+arrowleft`、`f1`
- macOS の `Cmd`: `cmd+k`
- 2 段のキー（チョード）: 空白で区切ります。例: `ctrl+k ctrl+s`
- `mod` は Windows と Linux では `ctrl`、macOS では `cmd` になります。

## 既定のキー（Windows と Linux）

| アクション | キー |
| --- | --- |
| `tab.new` 新しいタブ | `ctrl+shift+t` |
| `tab.close` タブを閉じる | `ctrl+shift+w` |
| `tab.next` ／ `tab.prev` 次・前のタブ | `ctrl+tab` ／ `ctrl+shift+tab` |
| `pane.split.vertical` ／ `pane.split.horizontal` 分割 | `ctrl+shift+d` ／ `ctrl+shift+e` |
| `pane.focus.<dir>` ペイン移動 | `alt+arrow<dir>` |
| `pane.zoom` 最大化 | `ctrl+shift+z` |
| `search` 検索 | `ctrl+shift+f` |
| `palette` コマンドパレット | `ctrl+shift+p` |
| `history` 履歴 | `ctrl+r`（ガイドレベル 1 以上） |
| `completion.trigger` 補完 | `ctrl+space` |
| `ai.ask` コツメに聞く | `ctrl+shift+space`（AI 補助が有効なとき） |
| `block.prev` ／ `block.next` ブロック移動 | `ctrl+arrowup` ／ `ctrl+arrowdown` |
| `block.collapse` 出力の折りたたみ | `ctrl+shift+[` |
| `sidebar.left.toggle` 左パネル | `ctrl+shift+b` |
| `panel.bottom.toggle` 下パネル | `ctrl+shift+j` |
| `focus.next_region` 領域の移動 | `f6` |
| `settings` 設定 | `ctrl+,` |
| `guide.help_mode` ヘルプモード | `f1` |
| `clear` 画面のクリア | `ctrl+l` |

macOS の既定は、`ctrl+shift` が `cmd` に置き換わります。例えば新しいタブは `cmd+t`、分割は `cmd+d`、設定は `cmd+,` です。`Ctrl+C` は macOS でも常に中断です。

## 設定ファイルで変える

アクション ID に対して、キーを書きます。配列で複数割り当てられます。空配列にすると解除されます。

```toml
[keybindings.bindings]
"tab.new" = "ctrl+shift+t"
"pane.split.vertical" = ["ctrl+shift+d", "ctrl+alt+d"]
"guide.help_mode" = []
```

引数や条件を付けたいときは、`[[keybindings.custom]]` を使います。

```toml
[[keybindings.custom]]
key = "ctrl+enter"
command = "workflow.run"
args = { name = "deploy" }
when = "terminalFocus && !altScreen"
```

`command` には、アクション ID、`workflow.run`（`args.name` を指定）、Mod のコマンド、`otterm.*` のホストコマンドのどれかを指定できます。

## when 条件

| 条件 | 意味 |
| --- | --- |
| `terminalFocus` | ターミナル領域にフォーカスがある |
| `altScreen` | 代替画面（vim などの TUI）の中 |
| `inputEmpty` | 入力行が空 |
| `paletteOpen` ／ `panelFocus` ／ `fileTreeFocus` | 各 UI にフォーカスがある |
| `hasSelection` ／ `settingsOpen` | 選択範囲がある ／ 設定画面が開いている |
| `guideLevel >= 2` | ガイドレベルによる条件 |
| `platform == "windows"` | OS による条件 |

`!`、`&&`、`||`、括弧、比較（`==`、`!=`、`>=`、`<=`、`>`、`<`）が使えます。知らない名前は偽として扱われます。

## 競合の扱い

- vim などが使うキーは、代替画面の中では既定でシェルに渡されます。`Ctrl+Shift` と `Cmd` で始まる割り当てだけは、代替画面の中でも otterm が使います。
- `keybindings.alt_screen_passthrough = false` にすると、代替画面の中でも常に otterm が優先されます。
- Mod が提案するキーは、ユーザーの設定と競合すると無効になります。設定画面で解決を促されます。
