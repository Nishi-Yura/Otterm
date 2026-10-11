# 完了通知 / Done notify

時間のかかったコマンドが終わったときに、トーストで知らせます。

Shows a toast when a long-running command finishes.

## 動作 / Behavior

- 実行時間が `min_seconds`（既定 10 秒）以上のコマンドが終わると通知します。
- 成功: `✓ npm test (1m 12s)`
- 失敗（終了コードが 0 以外）: `✗ npm test exit 2 (12s)`（警告の色）
- コマンドは 60 文字までに切り詰めます。
- 出力（ターミナルに出た文字）は読みません。読むのはコマンドの行、実行時間、終了コードだけです。

- Notifies when a command that ran for `min_seconds` (default 10) or longer finishes.
- Success: `✓ npm test (1m 12s)`. Failure: `✗ npm test exit 2 (12s)` (warning kind).
- The command is cut to 60 characters. The output is never read: only the command line, duration and exit code.

## 設定 / Settings

| 設定 / Setting | 既定 / Default | 内容 / Meaning |
| --- | --- | --- |
| `min_seconds` | 10 | 通知する最短の実行時間（秒）/ Shortest run time to notify (seconds) |

## 権限 / Permissions

- `terminal.read`（コマンドの行と終了コードを得るため / to get the command line and exit code）
- イベント `block-end`（コマンドの終了を受け取るため / to receive command end）

ターミナルへの入力や、ネットワーク、ファイルへのアクセスはありません。

No terminal writes, network, or file access.

## ライセンス / License

MIT
