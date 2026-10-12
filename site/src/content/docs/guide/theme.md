---
title: テーマと見た目
description: テーマの選び方、テーマファイルの書き方、フォント、画面レイアウト、CSS の上書き。
sidebar:
  order: 7
---

## テーマを選ぶ

同梱のテーマは、otterm Dark（既定）、otterm Light、High Contrast、Catppuccin、Dracula、Nord、Solarized、Gruvbox、Tokyo Night、One Dark などです。otterm Dark と otterm Light は WCAG AA に適合しています。

設定の `appearance.follow_system = true` にすると、OS のライト・ダークの切り替えに合わせて、`theme` と `theme_light` が使われます。

`otterm theme import <file>` で、iTerm2（`.itermcolors`）、Windows Terminal、VS Code、Alacritty、WezTerm の配色を変換して取り込めます。

## 画面の配置

| レイアウト | 内容 | 想定 |
| --- | --- | --- |
| `minimal` | ターミナルだけ。タブは複数あるときだけ表示 | 上級者 |
| `classic` | タブとステータスバー | 一般 |
| `guided`（既定） | classic に、左のファイルツリーと入力支援バーを加えたもの | 初心者から一般 |
| `ide` | guided に、右パネルと下パネルを加えたもの | 多機能派 |

配置は、設定画面でドラッグして変えられます。変えたものは「カスタム」として保存できます。

## テーマファイル

テーマは TOML で書きます。ターミナルの色と、UI の色を分けて書きます。

```toml
[theme]
name = "my-theme"
appearance = "dark"

[theme.terminal]
foreground = "#d4d4d4"
background = "#1e1e1e"
ansi = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5"]

[theme.ui]
bg = "#181818"
fg = "#e6e6e6"
accent = "#4f8cff"
radius = "8px"
```

UI のキーは `--ot-<キー>` という CSS 変数として公開されます。mod のパネルもこの変数を使うので、テーマを変えると mod の見た目も追従します。

## 透過と背景

ウィンドウの不透明度は、既定では 1.0（不透過）です。読みやすさと描画の速さを守るためです。透過や背景画像は、テーマ側で必要なときに指定します。

```toml
[theme.window]
opacity = 0.9
blur = false
background-image = "C:/Users/me/Pictures/bg.png"
```

## フォント

```toml
[font]
family = ["Cascadia Code", "Noto Sans Mono CJK JP", "Symbols Nerd Font"]
size = 14
ligatures = true
```

フォントは並べた順に探されます。日本語を含む表示には、日本語のモノスペースフォントを後ろに並べておくと安心です。曖昧幅の文字（例: `①`）は、`terminal.ambiguous_width` で半角か全角かを選べます。

## CSS で見た目を変える

テーマには CSS を付けられます。画面の部品には `data-ot` 属性が付いているので、クラス名ではなく `[data-ot="tab"]` のように指定します。

CSS が原因で画面が操作できなくなったときは、`otterm --safe-mode` で起動すると、テーマと mod が無効になります。詳しくは [トラブルシューティング](/guide/troubleshooting/) を読んでください。

## 画面の表示の調整

- `appearance.minimum_contrast`: 背景に近すぎる文字色を、読める色に寄せます（1 で無効、最大 21）
- `appearance.ui_scale`: 画面全体の大きさ（80 % から 200 %）
