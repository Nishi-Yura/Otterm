---
title: API の使い方
description: ModContext の主な機能、UI の作り方、イベント、コマンドの登録の例。
sidebar:
  order: 4
---

Mod の入口は、`activate(ctx)` と `deactivate()` です。ここで受け取る `ctx` を通して、すべての機能を使います。

```ts
import type { ModContext } from "@otterm/api";

export function activate(ctx: ModContext) {
  ctx.commands.register(
    "git-status-bar.refresh",
    async () => {
      ctx.log.info("ブランチ情報を更新しました");
    },
    { title: { ja: "ブランチ情報を更新", en: "Refresh branch info" } },
  );
}

export function deactivate() {}
```

## 原則

- **すべての API は非同期**です。ワーカー、UI、Rust 本体の 3 つを通るため、同期の API はありません。
- 登録したものは、すべて `Disposable` を返します。`deactivate` のときに、本体が自動で後片付けします。止め忘れたタイマーも、本体が止めます。
- 宣言していない権限の API は、`ctx` に存在しません。`ctx.fs?.` のように、任意のものとして扱ってください。
- Mod のサンドボックスには、`fetch` や DOM がありません。ES2022 の標準機能と、`setTimeout` などのタイマーだけがあります。

## 主な機能

| 名前空間 | 内容 |
| --- | --- |
| `ctx.ui` | Slot、パネル、トースト、ダイアログ、右クリックメニュー |
| `ctx.commands` | コマンドの登録（パレットとキーバインドから使えます） |
| `ctx.keybindings` | 既定のキーの提案（ユーザーの設定が優先されます） |
| `ctx.terminal` | 入力の変化、実行の直前、ブロックの終了、入力欄への挿入 |
| `ctx.session` | セッションの情報、カレントフォルダの変化 |
| `ctx.assist` | コマンドの説明、補完、危険ルール、エラー助言の追加 |
| `ctx.settings` / `ctx.storage` | Mod の設定と、Mod 専用の保存領域（10 MB まで） |
| `ctx.theme` / `ctx.i18n` | テーマの変数、翻訳 |
| `ctx.mascot` | コツメの吹き出し、表情、反応ルール |

詳しい型は、[API リファレンス](/api/) にあります。

## UI を作る

UI は 2 つの方法で作れます。

**宣言的 UI（推奨）** は、部品のツリーを返す方法です。テーマへの追従、アクセシビリティ、キーボード操作が自動で行われます。

```ts
ctx.ui.slot("statusbar.left").add({
  type: "text",
  icon: "git-branch",
  text: () => state.branch,
});
```

**サンドボックス iframe** は、`type: "custom"` で HTML と CSS を渡す方法です。iframe の中では JavaScript は動きません。ロジックは Worker 側に置き、`postMessage` でやり取りします。

## ターミナルとのやり取り

- `ctx.terminal.onBlockEnd` は、コマンドが終わったときに、コマンド、出力、終了コード、カレントフォルダ、所要時間を受け取ります。`terminal.read` が必要です。
- `ctx.terminal.insert(text)` は、入力欄に文字を入れるだけです。
- `ctx.terminal.write(sessionId, text)` は、ユーザーの代わりに入力を送ります。`terminal.write` が必要で、呼ばれるたびにユーザーに通知されます。できるだけ使わないでください。

## イベント

`session-created`、`cwd-changed`、`block-start`、`block-end`、`theme-changed`、`settings-changed` などがあります。`output` のように全出力を受け取るイベントは、マニフェストの `events` に明示的に書く必要があります。

Mod どうしの連絡には、`ctx.events.emit` と `ctx.events.on` を使います。イベント名は `custom:<id>` の形になります。
