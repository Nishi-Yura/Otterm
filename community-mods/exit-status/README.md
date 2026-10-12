# 終了コードと実行時間 / Exit code and duration

`nishi-yura.exit-status`

## 日本語

ステータスバーの左側に、いま見ているターミナルで直前に実行したコマンドの結果を表示します。成功なら `✓ 1.2s`、失敗なら `✗ 127 · 0.3s` のように終了コードも出ます。タブを切り替えると、そのタブの結果に変わります。

読むのは終了コードと実行時間だけです。コマンドの文字列も出力も読みません（シェル統合が必要です）。

### 設定

- `show_success`（既定: オン）: オフにすると、失敗したときだけ表示します
- `show_duration`（既定: オン）: 実行時間を表示するかどうか

## English

Shows the result of the last command in the focused terminal at the left of the status bar: `✓ 1.2s` on success, `✗ 127 · 0.3s` with the exit code on failure. Switching tabs shows that tab's result.

It reads only the exit code and the duration; neither the command line nor the output is read (shell integration is required).

Settings: `show_success` (default on; when off, only failures are shown) and `show_duration` (default on).
