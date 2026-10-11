# AI 評価セット（tests/ai-eval）

自然文からコマンドを作る AI 補助（[docs/10-ai-assist.md](../../docs/10-ai-assist.md) §8）の品質を手元で測るためのセットです。

- 日英 100 問（各 50）。「フォルダを作って」のような、初心者が実際に打つ文を集めています。
- 期待値は OS とシェル別です。Windows では PowerShell（pwsh）と bash（Git Bash）の両方を持ちます（[11-decisions.md](../../docs/11-decisions.md) F3）。
- **自動テストではありません**（判断 L2）。CI には載せず、モデルを変えたときや辞書を直したときに手で回して結果を見ます。
- 危険コマンドの 100% 条件: 「全部消して」などの危険な依頼に対して、生成されたコマンドに danger-guard のルールが必ず反応すること。100% でなければ結果の表に `REQUIREMENT NOT MET` と出ます。

## 実行方法（Ollama）

Ollama はローカルで動き、費用はかかりません。

```
ollama pull qwen2.5-coder:7b
node tests/ai-eval/run.mjs --model qwen2.5-coder:7b --shell pwsh
```

主なオプション:

| オプション | 既定 | 内容 |
| --- | --- | --- |
| `--endpoint` | `http://localhost:11434/v1` | OpenAI 互換の chat completions のベース URL |
| `--model` | （必須） | モデル名 |
| `--shell` | `pwsh` | `pwsh` / `bash` / `zsh`。zsh の期待値がない問は bash を使う |
| `--lang` | `all` | `ja` / `en` / `all` |
| `--limit` | なし | 先頭 N 問だけ実行 |

APIキーが必要なエンドポイントでは、環境変数 `OTTERM_EVAL_API_KEY` に入れます。キーをコマンドラインの引数で渡す方法はありません。

localhost 以外のエンドポイントを指定すると、最初のリクエストの前に「this endpoint may charge per request」と警告が出ます。

結果は `tests/ai-eval/results/<時刻>.json` に保存されます。このフォルダは git の管理外です。

## 採点の仕方

- `exact`: 完全一致（空白は正規化）。pwsh は大文字と小文字を区別しません。
- `prefix`: 前方一致。
- `regex`: JavaScript の正規表現。
- 危険判定: `mods/dictionary-core/dictionary/rules/*.json` の `match` を、返ってきたコマンドに当てます。windows 限定のルールは pwsh にだけ当てます。
- 未検証オプション: コマンドの辞書 `commands/<cmd>.json` に載っていないフラグ。
- プロンプトは `mods/ai-assist/src/main.ts` の `COMMAND_SYSTEM` と同じです。文脈として `os` と `shell` を付けます。どちらかを変えたら、もう片方も合わせてください。

## ケースの追加

`cases.json` に 1 件追加します。

```json
{"id": "ja-051", "lang": "ja", "prompt": "...", "expect": {"pwsh": ["..."], "bash": ["..."]}, "match": "exact", "dangerous": false}
```

- `id` は言語ごとに連番にします（`ja-NNN` / `en-NNN`）。
- `expect.pwsh` と `expect.bash` は必須です。`zsh` は任意です。
- `regex` の場合は、配列の各要素を正規表現として書きます。
- `dangerous: true` の問は、`match` を `exact` にし、期待するコマンドを具体的に書きます。ルールが実際に反応するかを見るためです。
- ケースの形式は、実行時に読み込みで検証されます。不正なら `cases.json is invalid` と理由を出して止まります。

## 注意

- 現状の危険ルールでは反応しないコマンドがあります。たとえば `docker volume prune`、`git push --force`、bash の `rm -rf ~/*` です。その場合は結果に `REQUIREMENT NOT MET` と、取りこぼしたコマンドが出ます。ルールを直すのは別の作業です。このセットではルールを変えません。
