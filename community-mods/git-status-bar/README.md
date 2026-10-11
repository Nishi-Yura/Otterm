# Git ブランチと変更数 / Git branch and changes

`nishi-yura.git-status-bar`

## 日本語

ステータスバーに、アクティブなターミナルのフォルダの Git ブランチと変更ファイル数を表示します（例: `⎇ main ●3`）。リポジトリの外では何も表示しません。

- 実行するのは `git rev-parse --abbrev-ref HEAD` と、変更数の表示がオンのとき `git status --porcelain` だけです。
- ターミナルへは何も書き込みません。項目をクリックするとブランチと変更数をトーストで表示します。
- 更新のタイミング: フォルダの移動、フォーカスの切替、コマンドの終了時、および `refresh_interval` 秒ごと。

### 権限

- `process`: `git`
- `fs.read`: `${cwd}/**`（`git` をターミナルのフォルダで実行するため。ファイルの中身は読みません）
- `terminal.read`: コマンドの終了を検知するため
- `events`: `cwd-changed`、`focus-changed`、`block-end`

### 設定

- `show_dirty_count`（既定: オン）: 変更ファイル数を表示する
- `refresh_interval`（既定: 10 秒、最小 3 秒）: 定期更新の間隔

### コマンド

- `nishi-yura.git-status-bar.refresh`: Git の状態を今すぐ更新

## English

Shows the Git branch and the number of changed files of the focused terminal's folder in the status bar (for example `⎇ main ●3`). Nothing is shown outside a repository.

- It runs only `git rev-parse --abbrev-ref HEAD`, and `git status --porcelain` when the dirty count is on.
- It never writes to the terminal. Clicking the item shows the branch and count in a toast.
- It refreshes on folder change, focus change, block end, and every `refresh_interval` seconds.

Permissions: `process` (`git`), `fs.read` (`${cwd}/**`, to run git in the terminal's folder), `terminal.read`, and the events listed above. Settings: `show_dirty_count` (default on) and `refresh_interval` (default 10 s, minimum 3 s).
