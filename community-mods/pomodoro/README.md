# ポモドーロタイマー / Pomodoro timer

`nishi-yura.pomodoro`

## 日本語

ステータスバーにポモドーロタイマーを出します。作業時間が終わると休憩が自動で始まり、休憩が終わるとトーストで知らせて止まります。権限は使いません。

- ステータスバーの項目をクリックすると開始・一時停止を切り替えます。停止中は `一時停止中` と表示します。
- コマンド（パレットから実行）: `nishi-yura.pomodoro.start`、`nishi-yura.pomodoro.pause`、`nishi-yura.pomodoro.reset`

### 設定

- `work_minutes`（既定: 25 分、1〜180）: 作業時間
- `break_minutes`（既定: 5 分、1〜60）: 休憩時間

変更は次の区間から反映されます。

## English

A Pomodoro timer in the status bar. When a work period ends, a break starts on its own. When the break ends, a toast tells you and the timer stops. It uses no permissions.

- Clicking the status bar item starts or pauses the timer. While paused it shows "paused".
- Commands (in the palette): `nishi-yura.pomodoro.start`, `nishi-yura.pomodoro.pause`, `nishi-yura.pomodoro.reset`.
- Settings: `work_minutes` (default 25, range 1 to 180) and `break_minutes` (default 5, range 1 to 60). A change applies from the next period.
