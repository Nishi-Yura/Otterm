---
title: シェル統合
description: シェル統合の仕組み、対応シェルごとの扱い、ブロックが使えない場合の対処。
sidebar:
  order: 5
---

シェル統合は、otterm がシェルのプロンプトとコマンドの境界を知るための仕組みです。ブロック表示、プロンプトバー、履歴、コマンドの説明などは、この情報を使っています。

## 注入の方法

既定では、otterm が起動するシェルにだけ、起動引数で統合のスクリプトを読み込ませます。ユーザーのシェル設定ファイルは書き換えません。

| シェル | 方法 |
| --- | --- |
| bash | `--rcfile` で読み込みます。ログインシェルの読み込み順は再現されます。 |
| zsh | `ZDOTDIR` を otterm の統合フォルダに向けます。元の設定ファイルは、そのまま読み込まれます。 |
| fish | 設定ファイルの後に読み込みます。 |
| PowerShell 7、Windows PowerShell | 起動時にフックを渡します。PSReadLine が必要です（Windows PowerShell は 2.0 以上）。 |
| cmd | フックは置けません。プロンプトにフォルダとプロンプトの印を入れます（終了コードと実行時間は出ません）。下の「WSL と cmd」を参照。 |
| WSL | 自動では入りません。WSL 側の設定ファイルに 1 行足すと入ります。下の「WSL と cmd」を参照。 |
| nushell | まだありません。通常のターミナルとして動きます。 |

スクリプトは `<設定フォルダ>/shell-integration/` に書き出され、中身を読むこともできます。

`-c`、`-Command`、`-File` などでコマンドを直接実行するプロファイルには、統合は注入されません。

## シェル自身の設定ファイル

otterm はいつもの設定ファイルを読んでからシェルを始めます。PowerShell のプロファイル、`~/.bashrc`、`~/.zshrc`、`config.fish`、cmd の AutoRun はそのまま効き、エイリアスやプロンプトのテーマもほかのターミナルと同じです。otterm の連携はそのあとに読み込まれます。

シェルを **インストールしたままの状態** で始めたいときは `shell.user_startup_files = false` にします（新しいタブから反映）。PowerShell は `-NoProfile`、bash は `--norc`、fish は `--no-config` で起動し、otterm 自身の連携だけが入ります。1.1 まではこちらが既定でした。

## WSL と cmd

WSL のタブは `wsl.exe` が間にいるので、otterm のフックを自動では渡せません。代わりに `OTTERM`、`OTTERM_SESSION_ID`、`OTTERM_HOOKS`（フックのフォルダを Linux のパスにしたもの）などの変数を `WSLENV` で渡します。WSL 側のシェルの設定ファイルに次の 1 行を足すと、ブロックやフォルダの引き継ぎが効きます。

```bash
# ~/.bashrc
[ -n "$OTTERM_HOOKS" ] && OTTERM_USER_STARTUP=0 . "$OTTERM_HOOKS/otterm.bash"
```

```zsh
# ~/.zshrc
[ -n "$OTTERM_HOOKS" ] && source "$OTTERM_HOOKS/otterm.zsh"
```

```fish
# ~/.config/fish/config.fish
set -q OTTERM_HOOKS; and source $OTTERM_HOOKS/otterm.fish
```

cmd にはフックを置けませんが、otterm がプロンプトに「いまのフォルダ」と「プロンプトの始まり」の印を入れます。新しいタブと分割が同じフォルダで開き、Ctrl+Up / Ctrl+Down でプロンプトの間を移動できます。コマンドの終了コードと実行時間は出ません。`PROMPT` 環境変数で決めた見た目は、`$P$G`（フォルダと `>`）に置き換わります。

nushell にはまだ連携がありません。

## プロンプトの描き方

`shell.prompt` で選びます。

- `otterm`（既定）: プロンプトバーを otterm が描きます。シェル側のプロンプトは `❯` だけになります。
- `shell`: Oh My Posh などのシェルのプロンプトをそのまま使います。ブロックの機能は働きます。

## ブロックが使えないとき

統合が効いていないときは、ブロック機能は静かに無効になり、「シェル統合が無効です」と小さく表示されます。次を確認してください。

1. プロファイルが cmd（コマンドの区切りが取れません）や nushell ではないか。WSL なら、WSL 側の設定ファイルに上の 1 行を足したか
2. `shell.integration` が `true` になっているか
3. PowerShell の場合、PSReadLine が入っているか（`Get-Module PSReadLine -ListAvailable` で確認できます）
4. プロファイルに `-c` や `-File` などの引数がないか

## 技術的な仕組み

otterm は、標準の OSC 133（プロンプトの開始、入力の終わり、実行の開始、終了コードの通知）を使います。otterm 独自の情報は OSC 7777 で送られます。カレントフォルダは OSC 7 で通知されます。
