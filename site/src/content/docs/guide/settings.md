---
title: 設定
description: config.toml の場所と書き方、CLI での設定操作、ワークスペース設定と信頼の仕組み。
sidebar:
  order: 3
---

設定は、設定画面（`Ctrl+,`）から変えられます。変えた内容は TOML ファイルに書き戻されます。TOML を直接編集しても、設定画面にすぐ反映されます。コメントと並び順は残ります。

## 設定ファイルの場所

| OS | ユーザー設定 | データ（Mod、状態、ログ） |
| --- | --- | --- |
| Windows | `%APPDATA%\otterm\config.toml` | `%LOCALAPPDATA%\otterm\` |
| macOS | `~/Library/Application Support/otterm/config.toml`（`~/.config/otterm/` があればそちらを優先） | 同じ |
| Linux | `$XDG_CONFIG_HOME/otterm/config.toml` | `$XDG_DATA_HOME/otterm/` |
| ポータブル版 | `<実行ファイル>/portable/config.toml` | `<実行ファイル>/portable/` |

ポータブル版は、実行ファイルの隣に `portable` フォルダがあるときに有効になります。環境変数 `OTTERM_CONFIG` と `OTTERM_DATA_DIR` は、それより優先されます。

## 設定ファイルの例

```toml
schema = 1

[general]
language = "ja"          # ja | en | auto
guide_level = 2          # 0 から 3

[appearance]
theme = "otterm Dark"
layout = "guided"        # minimal | classic | guided | ide

[font]
family = ["Cascadia Code", "Noto Sans Mono CJK JP"]
size = 14

[terminal]
scrollback = 10000
bell = "visual"          # none | visual | sound | both
```

値が壊れていると、その項目だけ既定値に戻り、起動時に通知されます。

## 優先順位

次の順に読み込まれ、後のものが前のものを上書きします。

1. 既定値
2. ユーザー設定（`config.toml`）
3. ワークスペース設定（`.otterm/workspace.toml`）
4. コマンドライン引数

## CLI で設定を扱う

```sh
otterm config get font.size        # 値を表示
otterm config set font.size 16     # 値を書き換える
otterm config path                 # 設定ファイルの場所を表示
otterm config reset                # 既定に戻す（元の設定は .bak-reset-<時刻> に残ります）
otterm config export               # 設定・テーマ・Mod 一覧を zip にまとめる
otterm config import <file>        # zip から読み込む（今の設定は .bak-import-<時刻> に残ります）
```

エクスポートの zip には、`config.toml`、テーマ、レイアウト、背景画像と、入っている Mod の一覧（`mods.toml`）が入ります。Mod 本体は入りません。

## ワークスペース設定

プロジェクトのフォルダに `.otterm/workspace.toml` を置くと、そのプロジェクト専用の設定として読み込まれます。チームでリポジトリに入れて共有できます。

```toml
[workspace]
name = "my-project"
tabs = [
  { name = "dev",  profile = "pwsh", command = "pnpm dev" },
  { name = "test", profile = "pwsh" },
]
```

### 信頼の確認

初めて開くワークスペースでは、「このフォルダの設定を信頼しますか？」と聞かれます。clone したばかりのリポジトリのコマンドが、勝手に走らないようにするためです。

- **信頼する前**: テーマの上書きだけが効きます。`tabs[].command` は実行されず、ワークスペースの Mod も有効になりません。
- **信頼した後**: タブ構成や設定を使えます。ただし、`shell`、`profiles`、`open`、`ai`、`mods`、`history`、`keybindings.custom` などは、ワークスペースから変えられません。これらは外部のプログラムの起動や送信につながるためです。無視されたキーは起動時の通知に出ます。
- 信頼の記録は `state/trusted-workspaces.json` に保存されます。設定画面から取り消せます。親フォルダを信頼すると、配下のフォルダも信頼されます。

`terminal.write` 権限を持つ Mod は、ワークスペース側では有効になりません。

## 設定の項目

主な項目は次のとおりです。すべての項目は設定画面で確認できます。

| 項目 | 内容 |
| --- | --- |
| `general.guide_level` | ガイドレベル（0 から 3）。[入力支援とガイドレベル](/guide/input-assist/) |
| `appearance.layout` | 画面の配置。`minimal`、`classic`、`guided`、`ide` |
| `appearance.renderer` | 描画方式。`auto`（既定）、`webgl`、`canvas` |
| `terminal.scrollback` | スクロールバックの行数。`0` で無制限（ディスクに退避） |
| `shell.default_profile` | 既定のプロファイル |
| `shell.integration` | シェル統合のオン／オフ。[シェル統合](/guide/shell-integration/) |
| `history.retention_days` | 実行記録を残す日数。`0` で無期限 |
| `ai.enabled` | AI 補助。既定はオフ。[AI 補助](/guide/ai-assist/) |

> otterm には利用状況を送信する設定はありません。otterm は利用状況を一切送信しません。

## 設定のリセットとバックアップ

項目ごと、カテゴリごと、または全体を「既定に戻す」ことができます。設定ファイルの形式が新しくなったときは、`config.toml.bak-<番号>` という名前でバックアップが残ります。
