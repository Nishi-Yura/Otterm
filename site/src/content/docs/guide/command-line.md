---
title: コマンドライン一覧
description: otterm のコマンドラインオプションとサブコマンドの一覧。
sidebar:
  order: 11
---

## 起動

```sh
otterm [path]                   # path を現在のフォルダにして起動します
otterm -e <command...>          # コマンドを実行するタブで起動します
otterm --profile <id>           # プロファイルを指定して起動します
otterm --safe-mode              # テーマと Mod を無効にして起動します
otterm --config <file>          # 設定ファイルを指定します
otterm --new-window             # 起動中でも別のウィンドウとして起動します
```

すでに otterm が起動していれば、そのウィンドウに新しいタブとして開きます。`--new-window` を付けると別のプロセスとして起動します。`--config` と `--safe-mode` も、別のプロセスとして起動する場合は引き継がれません。

## サブコマンド

| コマンド | 内容 |
| --- | --- |
| `otterm mod install <id \| path \| URL \| file>` | Mod を入れます |
| `otterm mod remove \| list \| enable \| disable \| update` | Mod を管理します |
| `otterm mod publish` | Mod を公開用に書き出します（[Mod の公開](/mods/publishing/) を参照） |
| `otterm mod doctor <id>` | マニフェストと権限を静的に検査します |
| `otterm mod link` | 開発中の Mod をシンボリックリンクで入れます |
| `otterm theme import <file>` | 他のターミナルの配色を取り込みます |
| `otterm config get \| set \| path \| reset \| export \| import` | 設定を扱います |
| `otterm workflow run <name>` | 起動中のウィンドウでワークフローを実行します |
| `otterm trash <path...>` | ファイルをゴミ箱に送ります |
| `otterm ask [question]` | コツメに聞きます（AI 補助が有効なとき）。引数がなければ対話の入力になります |

`otterm workflow run` と `otterm ask` は、otterm が起動していなかったり、4 秒以内に応答しなかったりすると、エラーで終わります。終了コードは 2 です。

## Windows でのコマンド

Windows のリリース版の `otterm.exe` は GUI プログラムなので、コンソールを持ちません。そのため、同じフォルダに小さなコンソールプログラム `otterm.com` が置かれます。PowerShell や cmd で `otterm` と打つと、`otterm.com` が動きます。`otterm.com` は `otterm.exe` の出力を画面に表示し、終了コードをそのまま返します。
