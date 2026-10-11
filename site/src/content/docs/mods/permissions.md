---
title: 権限
description: Mod が使う権限の宣言方法、承認の仕組み、実行時の検査。
sidebar:
  order: 3
---

Mod は、マニフェストに宣言した権限しか使えません。宣言していない権限の API は、実行時に存在しないので呼べません。

## 宣言できる権限

```toml
[permissions]
process = ["git"]                    # 起動してよい実行ファイル（一覧）
fs.read = ["${cwd}/**"]              # 読めるパス（glob）
fs.write = []                        # 書けるパス（glob）
network = []                         # 接続先（例: "https://api.github.com/*"）
clipboard = false                    # クリップボード
ai = false                           # ユーザーが設定した AI プロバイダへの問い合わせ
terminal.read = true                 # ブロックの出力や画面の文字を読む
terminal.write = false               # ターミナルに入力を書き込む
events = ["cwd-changed", "block-end"]
```

| 権限 | 使える API |
| --- | --- |
| `process` | `ctx.process.run`（PTY ではなく、ユーザーには見えません） |
| `fs.read` / `fs.write` | `ctx.fs` の読み取りと書き込み |
| `network` | `ctx.http.fetch` |
| `clipboard` | `ctx.clipboard` |
| `ai` | `ctx.ai` |
| `terminal.read` | `ctx.terminal.onBlockEnd` などの読み取り |
| `terminal.write` | `ctx.terminal.write`（ユーザーの代わりに実行できる、最も強い権限です） |

`ctx.terminal.insert` は、入力欄に文字を入れるだけなので、権限は要りません。実行はユーザーが行います。Mod は、可能な限り `insert` を使ってください。

## 承認の仕組み

- インストールのときに、権限の一覧が表示されて承認されます。承認は Mod のバージョンに結び付きます。
- 権限が増える更新では、もう一度承認されます。
- `terminal.write` と `clipboard` の読み取りは、インストールのときの承認に加えて、最初に実際に使われたときにも確認されます。
- 承認は後から取り消せます。

## 実行時の検査

本体は、`fs.read` の glob、`process` の実行ファイル名、`network` のホストを、毎回検査します。宣言していない場所に対する呼び出しは失敗します。

## パス変数

権限のパスには、次の変数を使えます。

| 変数 | 意味 |
| --- | --- |
| `${cwd}` | 現在のセッションのカレントフォルダ |
| `${home}` | ホームフォルダ |
| `${workspace}` | 現在のワークスペース |
| `${mod}` | Mod 自身のフォルダ |
| `${data}` | Mod 専用の保存領域 |

## 書き込みの保護

`fs.write` に含まれていても、次の場所は常に書き込みが拒否されます。

- otterm の設定フォルダとデータフォルダ（ほかの Mod のデータを含む）
- ホームフォルダ直下のドットファイル（`~/.bashrc`、`~/.ssh/*`、`~/.gitconfig` など）
- OS のシステムフォルダ
- ほかの Mod の `${mod}` フォルダ

これらへの保存が必要な Mod は、`ctx.ui.pickPath` でユーザーに保存先を選んでもらってください。ユーザーが選んだパスは、glob に関係なく読めます。

## ワークスペースの Mod

ワークスペースの中に置かれた Mod（`.otterm/mods/`）は、自動では有効になりません。権限の一覧を見せて確認します。`terminal.write` を持つ Mod は、ワークスペースの側では有効にできません。
