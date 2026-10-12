# Security policy

otterm runs shells, reads your files and loads third-party mods. Please tell us privately when you find a way around its protections.

## Reporting a vulnerability

- Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this repository. Do not open a public issue for a security problem.
- Include the otterm version (`otterm --version` or Settings › About), your OS, and the steps or the mod that reproduce the problem.
- You will get an answer within 7 days. Fixes ship as a normal release; the release notes credit you unless you ask otherwise.

## What counts

Anything that lets a mod or a piece of terminal output do what the user did not allow, for example:

- a mod reading or writing outside its declared `fs.read` / `fs.write` globs, running a program not in its `process` list, or reaching a host not in its `network` list
- a mod typing into the terminal without `terminal.write`, or executing a command without the user pressing Enter
- a `.otmod` package that escapes its folder when installed, or a registry index that is accepted with a bad signature or checksum
- terminal output (escape sequences, OSC) that changes files, settings or the clipboard without a prompt
- secrets reaching the AI provider in spite of the masking and the send preview
- an updater accepting an unsigned or tampered update

## Scope notes

- otterm has no server, telemetry or accounts, so there is no hosted service to test. Please do not test third-party services (the AI providers, GitHub) on our behalf.
- Mods in the registry are reviewed by their permissions ([registry/README.md](registry/README.md)). A malicious mod is reported through GitHub Issues; a hole in the sandbox that the mod exploits is reported here.
- There is no bug bounty. The project does not spend money ([docs/11-decisions.md](docs/11-decisions.md), M18).

## 日本語

脆弱性は、このリポジトリの **Security → Report a vulnerability**（非公開の報告）からお知らせください。公開の Issue には書かないでください。otterm のバージョン、OS、再現手順（または再現する mod）を添えてください。7 日以内に返事をします。修正は通常のリリースで配り、希望がなければリリースノートで報告者を紹介します。

対象: mod が宣言した権限の外に出られる、ユーザーが Enter を押していないのにコマンドが実行される、`.otmod` の展開がフォルダの外に出る、署名やチェックサムが合わないレジストリや更新が受け入れられる、エスケープシーケンスで確認なしにファイルや設定が変わる、AI プロバイダーに秘密情報が届く、など。報奨金はありません。
