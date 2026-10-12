---
title: パッケージ（.otmod）
description: mod を配布用の .otmod ファイルにまとめる方法と、受け付けられる形式の制限。
sidebar:
  order: 6
---

`.otmod` は、mod を配布するための zip 形式のファイルです。拡張子を `.otmod` にした zip と考えてください。

## 中に入れるもの

- `otmod.toml`
- `dist/main.js`（extension の場合）。`dist` の中身は、ビルド後のファイルだけにしてください。
- `theme.toml`、`layout.toml`、`dictionary/`、`workflows.toml`（それぞれの種類の場合）
- `locales/`、`assets/`、`README.md`、`icon.png`

`src/` や `node_modules/` は入れる必要がありません。

## 作る

`otterm mod publish` を実行すると、`dist/` の内容を検査して、次の 2 つを作ります。

- `<id>-<version>.otmod`: 配布するファイルです。
- レジストリに登録するための JSON（エントリのファイル）

作られたエントリの JSON は、レジストリのリポジトリへ Pull Request として提出します。

## 受け付けられる形式の制限

otterm は、インストールされる `.otmod` を次の条件で検査します。

| 項目 | 制限 |
| --- | --- |
| 圧縮したサイズ | 50 MB まで |
| 展開したサイズ | 200 MB まで |
| パス | `../` を含むパスは拒否されます |
| シンボリックリンク | 拒否されます |
| 実行可能ファイル | マニフェストの `entry` 以外は無視されます |

## 配布のほかの方法

レジストリに載せなくても、次の方法で配れます。

- Git リポジトリの URL（タグ指定も可）: `otterm mod install https://github.com/<user>/<repo>`
- `.otmod` ファイル: `otterm mod install file.otmod`、またはドラッグ＆ドロップ
- 開発中のフォルダ: `otterm mod install ./path`（`--link` でシンボリックリンク）

外部で有料の mod を販売することは禁止されていません。ただし、公式レジストリに載るのは無料の mod だけです。
