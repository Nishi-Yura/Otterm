# ネットワーク診断の辞書 / Network tools dictionary

`dig`、`nslookup`、`traceroute`（macOS / Linux）と `tracert`（Windows）、`netstat`、`ss`、`ip`（Linux）、`nc`、PowerShell の `Test-NetConnection` と `Resolve-DnsName` の主な使い方を、日本語と英語で説明します。「名前が引けない」「ポートが開いているか」「どこで止まっているか」を調べるときの道具です。`ping`、`curl`、`ssh`、`ipconfig` は組み込みの辞書にあるため、この mod には含みません。

`ip link set ... down` は通信を切るため、注意を表示します。

## インストール

otterm の mod として読み込みます。辞書データは `dictionary/` フォルダにあります。

## English

A Japanese and English dictionary for `dig`, `nslookup`, `traceroute` (macOS / Linux) and `tracert` (Windows), `netstat`, `ss`, `ip` (Linux), `nc`, and the PowerShell cmdlets `Test-NetConnection` and `Resolve-DnsName`: the tools for "does the name resolve", "is the port open" and "where does it stop". `ping`, `curl`, `ssh` and `ipconfig` are already in the bundled dictionary, so they are not included here.

`ip link set ... down` shows a warning because it disconnects the network.
