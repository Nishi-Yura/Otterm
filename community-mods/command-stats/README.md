# コマンド統計 / Command stats

`nishi-yura.command-stats`

## 日本語

右のサイドバーに「コマンド統計」パネルを追加します。今日の実行回数、最近 30 日の回数、よく使うコマンドの一覧（回数と棒）が見られます。パネルのバッジに今日の回数が出ます。

数えるのはコマンドの最初の単語（プログラム名）だけです。引数も出力も読みません。記録は mod のストレージ（この PC の中）に 1 日ごとに保存し、30 日より古い日は捨てます。「コマンド統計を消す」でいつでも全部消せます。

シェル統合（コマンドの区切りが分かる状態）が必要です。

### 設定

- `top_count`（既定: 10）: よく使うコマンドを何件まで出すか（3〜30）

## English

Adds a "Command stats" panel to the right sidebar: how many commands you ran today and over the last 30 days, and your most-used programs with counts and bars. The panel badge shows today's count.

Only the first word of each command (the program name) is counted; arguments and output are never read. Counts are saved per day in the mod's storage on this PC, days older than 30 are dropped, and "Clear command stats" deletes everything.

Shell integration is required. Setting: `top_count` (default 10; 3 to 30).
