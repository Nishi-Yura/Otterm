# リリース手順（Release）

M6（配布）の手順。v1.0 のチャネルは winget、Homebrew cask、AppImage（判断 A9）。

**お金のかかることはしない。** 有料のコード署名証明書、Apple Developer Program、有料のホスティングは使わない。この制約で何ができないかは §6 にまとめた。リポジトリは 2026-10-12 に public にした（GitHub Actions と GitHub Pages は public リポジトリなら無料。ただしワークフローは今も手動実行のみ）。

## 1. 前提

- バージョンは `Cargo.toml` の `[workspace.package] version` と `crates/otterm-app/tauri.conf.json` の `version` の 2 か所。同じ値にする（`scripts/release.mjs` が確かめる）
- 配布物は public リポジトリ（Nishi-Yura/Otterm）の GitHub Releases に置く。winget と Homebrew は誰でもダウンロードできる URL を求める
- 更新の署名鍵（§2）を作ってある

## 2. 更新の署名鍵（判断 C10）

Tauri updater は minisign の鍵で `latest.json` の配布物を検証する。鍵は無料で作れる。

```bash
pnpm tauri signer generate -w ~/.tauri/otterm-updater.key
```

- 公開鍵（`~/.tauri/otterm-updater.key.pub` の中身）を `packaging/updater.pub` に置いてコミットする。リリースビルドに `OTTERM_UPDATER_PUBKEY` として埋め込まれる（2026-10-12 に作成。鍵 ID `B20A5D7F29ECA66D`、パスワード付き）
- 秘密鍵とパスワードはリポジトリに入れない。C10 のとおり、リポジトリを public にしたら GitHub Actions のシークレット（`TAURI_SIGNING_PRIVATE_KEY`、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。無料）に入れ、メンテナの端末からは消す。それまではパスワード付きでオフラインの媒体に保管する
- ローテーション: 新しい鍵を作り、**古い鍵で署名した版** に新しい公開鍵を入れて出す。利用者がその版に更新したあと、新しい鍵での署名に切り替える。古い鍵を失ったときは自動更新が途切れるので、リリースノートと Web ページで手動の入れ直しを案内する
- 鍵がないビルドは動くが、自動更新はできない（「この版の otterm は自動更新できません」）

### 2.1 レジストリの署名鍵（判断 M23）

mod レジストリの `index.json` には、updater とは別の minisign 鍵で署名する。

```bash
pnpm tauri signer generate -w ~/.tauri/otterm-registry.key
```

- 公開鍵（`~/.tauri/otterm-registry.key.pub` の中身）を `registry/registry-key.pub` に置いてコミットする。ビルドに埋め込まれる（2026-10-12 に作成。鍵 ID `2736B83507A3D2B7`。パスワードなしで作ったので、付けたいときは作り直して公開鍵を差し替え、署名し直す）
- `index.json` を作り直したら `node registry/scripts/sign.mjs` で署名し、`index.json.sig` も一緒にコミットする。鍵の場所は `OTTERM_REGISTRY_KEY`、パスワードは `OTTERM_REGISTRY_KEY_PASSWORD` で変えられる
- `node registry/scripts/validate.mjs` は署名が `index.json` と合わないとエラーにする
- 秘密鍵はリポジトリに入れない

## 3. ビルド（OS ごと）

```bash
pnpm install --frozen-lockfile
node scripts/fetch-conpty.js          # Windows のみ（判断 M3）
node scripts/release.mjs --notes notes.md
```

`dist-release/<version>/` にできるもの:

| OS | 配布物 | 自動更新に使うもの |
| --- | --- | --- |
| Windows | `otterm_<version>_x64-setup.exe`（NSIS、ユーザー単位のインストール） | 同じ `.exe` と `.sig` |
| macOS | `otterm_<version>_<arch>.dmg` | `otterm.app.tar.gz` と `.sig` |
| Linux | `otterm_<version>_amd64.AppImage` | 同じ `.AppImage` と `.sig` |

あわせて `SHA256SUMS.txt`、`latest.json`（鍵があるとき）、`winget/<version>/*.yaml`、`otterm.rb`（macOS で作ったとき）ができる。OS ごとに実行すると `latest.json` と `SHA256SUMS.txt` に追記していく。

Windows のインストーラは `otterm.exe` の隣に `otterm.com`（docs/06 §4）を入れ、インストール先をユーザーの PATH に足す（`crates/otterm-app/windows/hooks.nsh`）。アンインストールで PATH から外す。

macOS と Linux はこの開発機ではビルドできない。Mac と Linux の手元の機械で同じスクリプトを実行する（Linux の準備は `packaging/linux/README.md`）。`.github/workflows/release.yml` は 3 OS をまとめてビルドする（手動実行のみ。public リポジトリなので実行は無料）。

## 4. 公開（手作業）

1. GitHub で `v<version>` のリリースを作り、`dist-release/<version>/` の配布物、`.sig`、`SHA256SUMS.txt`、`latest.json` を添付する。安定版は通常のリリース、ベータは prerelease にして、`latest.json` を `beta` タグのリリースにも置く（`general.update_channel = "beta"` の取得先）
2. winget: `dist-release/<version>/winget/<version>/` の 3 ファイルを microsoft/winget-pkgs の `manifests/o/Otterm/Otterm/<version>/` に置いて PR を出す（`winget validate` で確かめてから）
3. Homebrew: まず自前の tap（`homebrew-otterm` リポジトリの `Casks/otterm.rb`）に置く。`brew install --cask <user>/otterm/otterm`
4. ドキュメントサイト: `pnpm --filter @otterm/site build` の `site/dist/` を置く。置き場所（GitHub Pages は public リポジトリなら無料）は未定
5. mod レジストリ: このリポジトリの `registry/` がそのままレジストリになる。本体の既定の取得先は `https://raw.githubusercontent.com/Nishi-Yura/Otterm/main/registry/index.json`（`[mods] registry` で変えられる）。`community-mods/` の mod は `node scripts/publish-community-mods.mjs` で `registry/packages/` と `registry/mods/` に入り、push すると公開される。mod が増えてレビューの負担が大きくなったら、別リポジトリに分ける

## 5. リリース前の確認

- `just check` が通る
- Windows のインストーラで: インストール → 新しい PowerShell で `otterm config path` が出力される → `otterm` でウィンドウが開く → アンインストールで PATH から消える
- 自動更新: 1 つ前の版を入れ、パレットの「更新を確認」で新しい版が見つかり、更新して再起動できる
- クラッシュログ: 異常終了後の次回起動で「Issue を作る」が出る

## 6. お金をかけないことで、できないこと

| 項目 | 費用がかかる理由 | v1.0 での扱い |
| --- | --- | --- |
| Windows のコード署名（Authenticode） | 証明書が年額で有料 | 署名しない。初回は SmartScreen の警告が出る。winget は未署名のインストーラも受け付ける。OSS 向けの無料署名（SignPath Foundation など）は public リポジトリが条件で、申請はメンテナが行う |
| macOS の署名と公証 | Apple Developer Program が年額で有料 | 署名しない。初回は Gatekeeper に止められ、「右クリック → 開く」が要る。homebrew/cask 本体には載らないので自前の tap で配る |
| 3 OS の自動ビルド | public になったので無料 | `release.yml`（手動実行）か、各 OS の手元で `scripts/release.mjs` |
| ドキュメントサイトのホスティング | public になったので GitHub Pages は無料 | 置き場所は未定。今はローカルでビルドだけする |
| sigstore による mod の署名（判断 D2） | 署名は GitHub Actions（public なら無料）で行う設計 | 代わりにインデックスへメンテナの minisign 鍵で署名する（判断 M23、§2.1）。配布物はインデックスの SHA-256 で守られる |
