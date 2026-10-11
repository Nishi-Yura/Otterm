# Linux（AppImage）

v1.0 の Linux 版は AppImage だけです（判断 A9。deb / rpm / Flatpak は v1.1）。

Linux マシン（Ubuntu 22.04 以降を推奨）で次を実行します。

```bash
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libdbus-1-dev
pnpm install --frozen-lockfile
node scripts/release.mjs
```

`dist-release/<version>/` に `otterm_<version>_amd64.AppImage` ができます。手順の全体は [docs/release.md](../../docs/release.md)。
