---
title: コツメ
description: otterm のマスコット、コツメ（Pebble）の役割と設定。
sidebar:
  order: 8
---

コツメ（海外名 Pebble）は、otterm に住むカワウソです。モチーフは、コツメカワウソ（Asian small-clawed otter）です。ラッコ（sea otter）とは別の動物です。

コツメは、ロゴというより画面の一部として振る舞います。

- **案内役**: 次に何をすればいいかを、短い言葉で伝えます。
- **番人**: 危険なコマンドの前で止めます。叱らず、代わりの手を示します。
- **相棒**: うまくいったときに喜び、長い処理のあいだも一緒に待ちます。

名前は、コツメカワウソから取り、「コツ（要領）を教えてくれる」という意味を掛けています。英語の表示では Pebble です。

## 表示の設定

```toml
[mascot]
visible = "auto"          # auto（ガイドレベルに従う）| always | never
position = "assist-bar"   # assist-bar | statusbar | float | hidden
speech = "auto"           # auto | always | alert-only | never
outfit = "default"
```

コツメを消しても、機能は何も失われません。台詞は、通常の画面の文言として表示されます。上級者は `mascot.visible = "never"` にしてください。

## 衣装

衣装は mod で追加できます。`outfit` の mod は、インストールすると自動で登録され、`outfit` の設定で選べるようになります。同梱の衣装には `default`、`developer`、`pixel` があります。

## 話しかけ方

コツメの台詞は、吹き出し 2 文までです。命令はしません。コマンドの実行は、ユーザーが Enter を押したときだけです。
