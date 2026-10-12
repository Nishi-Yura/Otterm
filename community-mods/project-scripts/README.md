# プロジェクトのスクリプト / Project scripts

`nishi-yura.project-scripts`

## 日本語

左のサイドバーに「プロジェクトのスクリプト」パネルを追加します。いま見ているターミナルのフォルダにある、

- `package.json` の `scripts`（`pnpm-lock.yaml` があれば `pnpm run`、`yarn.lock` なら `yarn`、`bun.lock` なら `bun run`、それ以外は `npm run`）
- `justfile` のレシピ（`_` で始まるものと `[private]` は除く）
- `Makefile` のターゲット

を一覧します。項目をクリックすると、そのコマンドが入力欄に入ります。実行するのは Enter を押したあなたです。

読むのはターミナルのフォルダにある上記のファイルとロックファイルだけです（`fs.read = ["${cwd}/**"]`）。フォルダを移動したときとタブを切り替えたときに読み直します。ファイルを編集したあとは、コマンド「プロジェクトのスクリプトを読み直す」で読み直せます（ターミナルの出力を読む権限は求めません）。

## English

Adds a "Project scripts" panel to the left sidebar. It lists, for the focused terminal's folder, the `scripts` of `package.json` (run with `pnpm run`, `yarn`, `bun run` or `npm run` depending on the lock file), the recipes of a `justfile` (except `_` names and `[private]` ones) and the targets of a `Makefile`. Clicking an entry puts its command into the input line; nothing runs until you press Enter.

It reads only those files and the lock files in the terminal's folder (`fs.read = ["${cwd}/**"]`), and rereads them when the folder or the focused tab changes. After editing those files, run "Reload project scripts" (it does not ask to read terminal output).
