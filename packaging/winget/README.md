# winget manifests

Templates that `scripts/release.mjs` fills in (`{{version}}`, `{{installerUrl}}`, ...) and writes to
`dist-release/<version>/winget/<version>/`. Submit those files to
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) under
`manifests/o/Otterm/Otterm/<version>/` after `winget validate --manifest <folder>` passes
(docs/release.md §4).
