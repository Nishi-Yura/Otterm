---
title: 雛形を作る
description: create-otterm-mod で extension の雛形を作り、開発と動作確認をする手順。
sidebar:
  order: 5
---

`create-otterm-mod` は、Mod の雛形を作るツールです。TypeScript と esbuild の最小構成の `extension`、または TOML だけの `theme` を作れます。

```sh
npm create otterm-mod@latest my-mod
```

> `create-otterm-mod` は、v1.0 の公開前はリポジトリの `packages/create-mod` から実行できます。

対話で、種類（`extension` か `theme`）と Mod の ID を聞かれます。引数で指定することもできます。

```sh
create-otterm-mod my-mod --kind extension --id example.my-mod --yes
```

## 雛形の中身

```text
my-mod/
+- otmod.toml          マニフェスト
+- src/main.ts         エントリ（activate と deactivate）
+- locales/en.ftl      英語の文言
+- locales/ja.ftl      日本語の文言
+- scripts/build.mjs   src/main.ts を dist/main.js にまとめます
+- scripts/link.mjs    otterm の Mod フォルダにリンクします
+- tsconfig.json       型の検査だけに使います
```

## 開発の流れ

```sh
pnpm install
pnpm dev
```

`pnpm dev` は、変更のたびにビルドし、起動時に otterm へ一度だけリンクします。リンクされた Mod は、`dist/main.js` が変わると otterm が読み直します。

公式でない Mod は、インストール後も最初は無効です。次のどちらかで有効にします。

- `otterm mod enable <id>`（雛形の `otmod.toml` に書いた ID を指定します）
- ステータスバーの右側の歯車から Mod の一覧を開く

有効にすると、権限の一覧が一度だけ表示されます。承認すると Mod が起動します。

## テーマの雛形

`--kind theme` で作ると、`theme.toml` と見本の画像が入ります。コードは要りません。

## 動作の確認

- `otterm mod doctor my-mod` で、マニフェストと権限の検査をします。
- `OTTERM_DATA_DIR` に一時フォルダを指定すると、実際のインストールに影響を与えずにリンクを試せます。
