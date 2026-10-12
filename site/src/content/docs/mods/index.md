---
title: mod 作者ガイド
description: otterm の mod の種類、構造、開発の流れ。
sidebar:
  order: 1
---

otterm 本体の同梱機能（補完、危険ガード、ファイルツリーなど）も、同じ仕組みの同梱 mod として作られています。公式にしかできないことは、原則として作らない方針です。同梱 mod も含め、すべての mod は最初はオフで、ユーザーが選んでオンにします。

> ここに書かれた API は、型定義（[API リファレンス](/api/)）を正とします。

## mod の種類

| kind | 内容 | コードが必要か |
| --- | --- | --- |
| `theme` | 配色、フォント、CSS の上書き | 不要（TOML と CSS） |
| `layout` | 画面の配置のプリセット | 不要 |
| `dictionary` | コマンドの説明、補完、危険ルール、エラー助言 | 不要（JSON） |
| `workflows` | 定型コマンドの集まり | 不要（TOML） |
| `outfit` | コツメの衣装 | 不要（TOML と画像） |
| `extension` | UI、イベント、外部との連携を実装する | 必要（TypeScript） |
| `pack` | 複数の mod と推奨設定をまとめたもの | 不要 |
| `feature` | otterm に組み込まれた機能（コツメ、履歴検索、プロンプトバー、複数行エディタ）のスイッチ。公式の同梱 mod だけ | 不要 |

コードを書かなくてよい種類が多くあります。テーマを作るのに JavaScript は要りません。

## 開発の流れ

1. `npm create otterm-mod@latest my-mod` で雛形を作ります。
2. `otmod.toml` で、mod の情報と必要な権限を宣言します。
3. `src/main.ts` で `activate(ctx)` を実装します。
4. `pnpm dev` で監視しながら開発します。otterm は、リンクされた mod の変更を読み直します。
5. `otterm mod doctor <id>` でマニフェストと権限を検査します。
6. `otterm mod publish` で配布用の `.otmod` を作り、レジストリに登録します。

## 構造

```text
my-mod/
+- otmod.toml        マニフェスト（必須）
+- README.md
+- icon.png          任意。128 x 128
+- dist/main.js      extension のエントリ（ビルド後の ESM 1 ファイル）
+- locales/          翻訳（任意、Fluent 形式）
+- assets/           画像などの素材
```

次は [マニフェスト](/mods/manifest/) と [権限](/mods/permissions/) を読んでください。
