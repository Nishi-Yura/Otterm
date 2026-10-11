---
title: マニフェスト（otmod.toml）
description: Mod の情報、互換性、追加する項目、設定の定義を書く otmod.toml の書き方。
sidebar:
  order: 2
---

`otmod.toml` は、Mod の名前、バージョン、互換性、必要な権限を書くファイルです。otterm は、インストールの前にこのファイルを読んで、ユーザーに権限の一覧を見せます。

## 例

```toml
[mod]
id = "example.git-status-bar"
name = "Git Status Bar"
version = "1.2.0"
description = "ステータスバーに現在のブランチと変更数を表示します"
author = "example"
license = "MIT"
kind = "extension"

[compat]
otterm = ">=1.0.0 <2.0.0"
api = "1"
platforms = ["windows", "macos", "linux"]

[entry]
main = "dist/main.js"

[[adds]]
slot = "statusbar.left"
label = "ブランチ名と変更数"

[[adds]]
command = "git-status-bar.refresh"
label = "ブランチ情報を更新"

[permissions]
process = ["git"]
fs.read = ["${cwd}/**"]
terminal.read = true
events = ["cwd-changed", "block-end"]

[settings.schema]
show_dirty_count = { type = "boolean", default = true, label = "変更数を表示する" }
refresh_interval = { type = "integer", default = 5, min = 1, max = 60, label = "更新間隔（秒）" }
```

## `[mod]`

| キー | 内容 |
| --- | --- |
| `id` | Mod の ID。`<GitHub ユーザー名>.<名前>` の形で、小文字の英数字と `-` だけを使います。`otterm.*` は公式専用です。 |
| `name` | 表示名 |
| `version` | セマンティックバージョン |
| `description` | 一行の説明。ストアと権限画面に出ます。 |
| `kind` | `theme`、`layout`、`dictionary`、`workflows`、`extension`、`pack` のどれか |

ID の名前空間は、公開するときに GitHub アカウントで確認されます。自分の GitHub ユーザー名以外の名前空間は使えません。

## `[compat]`

- `otterm`: 本体のバージョンの範囲
- `api`: API のメジャーバージョン。現在は `"1"`
- `platforms`: 対応する OS

otterm は、直近 2 つのメジャーバージョンの API を同時にサポートします。非推奨の API は、1 メジャーのあいだ警告を出します。

## `[[adds]]`

Mod が何を追加するかを書きます。ストアと権限画面に表示されます。

- `slot = "..."`: 追加する場所（Slot）
- `command = "..."`: 追加するコマンド
- `label`: 表示名

## `[entry]`

`extension` の場合のみ、`main` にエントリのファイルを書きます。

## `[settings.schema]`

Mod の設定項目を、JSON Schema の一部の形で書きます。ここに書いた項目は、設定画面にフォームとして自動で出ます。Mod は `ctx.settings.get(key)` で値を読み、`ctx.settings.onChange` で変更を受け取ります。

対応する型は `boolean`、`integer`、`number`、`string`、`enum`、`path`、`color`、`keychord` です。`default` と `label` は必須です。数値には `min`、`max`、`step`、文字列には `pattern` を指定できます。`secret = true` の文字列は、画面で伏せて表示されます。

## `[dependencies]`

他の Mod に依存する場合に書きます。

```toml
[dependencies]
"otterm.dictionary-core" = ">=1.0.0"
```
