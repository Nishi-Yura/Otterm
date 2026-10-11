# otterm mod レジストリ

otterm の公式 mod レジストリのテンプレートです。GitHub 上の静的 JSON インデックスと、GitHub Releases の配布物で構成します（サーバーなし）。検索はクライアント側で行います。

## 構成

- `mods/<id>.json` … mod ごとに 1 ファイル。`id` は `<github-user>.<name>` 形式
- `index.json` … `scripts/build-index.mjs` が `mods/` から生成。otterm クライアントはこれを読む
- `scripts/validate.mjs` … mod ファイルの形式と規則を検査（Node 22 以上、依存なし）
- `scripts/build-index.mjs` … 検査に通ったときだけ `index.json` を書く
- `examples/` … 形式の見本。`mods/` には入れない

## mod を登録する（作者向け）

1. mod のフォルダで `otterm mod publish` を実行する。`<id>-<version>.otmod` と `<id>.json` が生成される
2. `.otmod` を自分のリポジトリの GitHub Release にアップロードする。`versions[].url` がその URL と一致していることを確認する（このリポジトリのメンテナが作る mod は `community-mods/` に置き、配布物は `registry/packages/` から配る）
3. `<id>.json` を `mods/<id>.json` として置き、PR を開く。既存の mod に新しいバージョンを追加する場合は `versions` に追記する
4. PR の作者（GitHub ユーザー）は、mod ID の名前空間（`<github-user>.<name>` の `<github-user>`）と一致している必要がある
5. `otterm.*` は公式のみ使える

`reviewed` と `hidden` はメンテナーが設定します。作者は `false` のまま提出してください。

## 検証

```sh
node scripts/validate.mjs
```

検査内容: ID 形式、ファイル名と ID の一致、名前空間（D1）、semver（重複なし）、sha256（64 桁の hex）、https の URL、カテゴリと kind の値、サイズ上限。

## 審査方針

- **D4（権限で切り替え）**: `terminal.write` か `network:*` を持つ mod は、`reviewed: true` になるまで非表示（`hidden`）。それ以外は公開後、報告ベースで扱う
- **D9（無料のみ）**: このレジストリは無料の mod だけを載せる。有料の mod は掲載できない

## 報告

問題のある mod は GitHub Issues で報告してください。一定数の報告が集まった mod は自動で非表示になり、審査に回されます。

## メンテナー: index.json の生成

```sh
node scripts/validate.mjs
node scripts/build-index.mjs
```

生成された `index.json` をコミットします。`mods/` の JSON を変更したら、必ず再生成してください。

---

## English

otterm's public mod registry. It is a static JSON index on GitHub, with the packages on GitHub Releases. There is no server; search runs in the client.

- Authors: run `otterm mod publish`, upload the `.otmod` to your GitHub Release, then open a PR that adds `mods/<id>.json`. The PR author must be the GitHub user in the id's namespace.
- Maintainers: run `node scripts/validate.mjs`, then `node scripts/build-index.mjs`, and commit `index.json`.
- Mods with `terminal.write` or `network:*` stay hidden until reviewed (D4). The registry lists free mods only (D9).
- Report problems through GitHub Issues.
