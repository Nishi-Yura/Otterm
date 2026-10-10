# 性能の基準値（Baseline）

[09-performance.md](../09-performance.md) §4.2 の基準値と、otterm 自身の計測結果を記録する。計測の道具と結果の形式は [tests/bench/README.md](../../tests/bench/README.md)。

## 1. 計測のルール

- 他社の公称値は使わない。**同じマシン・同じフォント・同じシェル**で、同じ手順で測る
- 絶対値は参照マシンで測る（判断 C12）。CI ランナーの値は回帰の検出（相対比較）にだけ使う
- 結果は日付・コミット・マシン名つきの JSON で `docs/bench/` に置き、この文書の表に要約を書く

## 2. 参照マシン

**未確定**（判断 C12: ミドルレンジのノート PC 1 台 + GitHub Actions の標準ランナー）。決まったらここに型番、CPU、GPU、メモリ、OS、ディスプレイのリフレッシュレートを書く。

## 3. 他のターミナルの基準値（未計測）

M0 で測る対象: Ghostty、WezTerm、Windows Terminal、Alacritty（それぞれ対応 OS で）。

| 項目 | 測り方 | Ghostty | WezTerm | Windows Terminal | Alacritty |
| --- | --- | --- | --- | --- | --- |
| 打鍵遅延 p50 / p99 | [Typometer](https://github.com/pavelfatin/typometer) で 1,000 回。フォントサイズ 14、空のシェル、ウィンドウは同じ大きさ | – | – | – | – |
| スループット | 100 MiB のテキストを `cat`（Windows は `Get-Content -Raw` ではなく Git Bash の `cat`）して終わるまでの時間。5 回の中央値 | – | – | – | – |
| 起動時間 | プロセス開始からプロンプトが描かれるまで（画面録画 240 fps のフレーム数）。コールド / ウォーム | – | – | – | – |
| 常駐メモリ | 1 タブでプロンプト表示後 10 秒の Working Set / RSS | – | – | – | – |

共通条件: フォントは同梱予定のフォント（判断 B14）、シェルは Windows で pwsh 7、macOS で zsh、Linux で bash。シェルの設定は空にする（プロンプトのテーマが遅延を足すため）。

## 4. otterm の計測結果

### 4.1 M0（2026-10-11、開発機、Windows）

参照マシンではない。傾向を見るための値。

- マシン: AMD Ryzen 7 3700X（8 コア 16 スレッド）、メモリ 16 GiB、GeForce GTX 1660 SUPER、Windows 11 Pro、WebView2 154
- コミット: `4c7f6ed` + ベンチ一式（未コミット時点）
- 生データ: [2026-10-11-m0-dev-windows.json](2026-10-11-m0-dev-windows.json)

**PTY の経路**（VT 解析なし）

| 指標 | 値 |
| --- | --- |
| スループット（中央値） | 8.5 MiB/s |
| 1 行の往復 p50 / p99 | 0.13 ms / 0.39 ms |

**VT 解析**（`otterm-vt`、M1 着手時。`vt-throughput`、120×40、`ls --color` 風の行、プロセス内）

| 指標 | 値 |
| --- | --- |
| スループット（中央値） | 62 MiB/s（最初の実装は 42 MiB/s。セルを 20 バイトの `Copy` 型にし、行ごとに使用幅を持たせて改善） |

vte パーサ単体は約 1,800 MiB/s 出るので、残りは 1 文字約 10 ns の印字処理。PTY 側の上限（同梱 ConPTY 29 MiB/s、macOS / Linux 40〜60 MiB/s）は上回っているため、さらなる最適化は後回しにする。入力の形ごとの内訳は `cargo run --release -p otterm-vt --example profile`

**Rust → WebView の転送**（片道、p50 / p99、ms）

| 大きさ | Tauri 生ペイロード Channel | WebSocket（127.0.0.1） |
| --- | --- | --- |
| 64 B（1 セル） | 0.40 / 1.21 | 0.09 / 0.18 |
| 2 KiB（1 行） | 1.60 / 2.58 | 0.09 / 0.18 |
| 96 KiB（200×60 の全画面） | 2.57 / 4.89 | 0.17 / 0.34 |
| 1 MiB（大量出力の 1 フレーム） | 9.98 / 14.10 | 1.09 / 8.60 |

同じ日に 3 回測り、傾向は同じだった。Tauri Channel の 96 KiB の p99 は 4.2〜8.6 ms と回ごとの揺れも大きい。

### 4.2 所見

1. **段 4（転送）の予算 1〜2 ms を、Tauri の生ペイロード Channel は全画面の差分で超える**。p50 で 2.6 ms、p99 で 5〜9 ms。1 セルの差分なら p99 1.2 ms で収まる。WebSocket は全画面でも p99 0.34 ms で、10 倍以上速い → 判断 M2
2. **Windows の ConPTY が 8.5 MiB/s しか流さない**。パイプへ直接書くと 100 MiB が 0.05 秒で終わるので、律速は OS 同梱の conhost。Windows Terminal と WezTerm は新しい `OpenConsole.exe` と `conpty.dll` を同梱して回避している → 判断 M3。同梱版で測った結果は §4.3
3. ConPTY は行の本文をすぐ送るが、続く改行（カーソル移動）を約 1 フレーム遅れて送る。M1 の打鍵遅延で「描画された」をどちらで判定するかに効く
4. 打鍵遅延、起動時間、レンダラ判定（09 §4.4）は VT グリッドとレンダラ（M1）ができるまで測れない。M0 の完了条件のうち「レンダラ判定の文書化」は、M1 の最初のベンチに持ち越す

### 4.3 同梱版 ConPTY との比較（2026-10-11、開発機、Windows）

判断 M3 の検証。NuGet の Microsoft.Windows.Console.ConPTY 1.25.260930003（MIT、Microsoft の署名を確認）から x64 の `conpty.dll` と `OpenConsole.exe` を取り出し、`otterm-bench.exe` と同じフォルダに置いて測った。portable-pty はこの配置で同梱版を使う（実行中に `OpenConsole.exe` が子プロセスとして動くことを確認）。

| 指標 | OS 同梱（conhost） | 同梱版（OpenConsole） |
| --- | --- | --- |
| スループット（100 MiB × 3 回の中央値） | 9.0 MiB/s | 28.4〜29.2 MiB/s（200 MiB で 31.8） |
| 1 行の往復 p50 / p99 | 0.09 / 0.30 ms | 0.10 / 0.36〜0.45 ms |

スループットは約 3.2 倍。往復遅延は誤差の範囲で変わらない。

### 4.4 IPC 転送の 3 OS 比較（2026-10-11、GitHub Actions、コミット `aa04566`）

判断 M2 の材料。共有ランナーは GPU がなく揺れも大きいので、**同じ実行の中での Tauri と WebSocket の比較**にだけ使う。生データは Bench ワークフローの成果物（run 38079432192）。

macOS ランナー（仮想マシン）は JS と Rust の時計のずれがラウンドごとに 0.15〜1.5 ms の幅で変わり、補正しても片道の値が負になる。そのため比較には**往復**（Rust 送信 → JS 受信 → Rust に応答が届くまで）を使う。応答の経路は Tauri が `invoke`、WebSocket が同じソケットで、行きと帰りの両方の速さを含む。

往復 p50 / p99（ms）

| 大きさ | macos-latest（M2 Pro、仮想） | ubuntu-latest（EPYC、Xvfb） | windows-latest（EPYC） |
| --- | --- | --- | --- |
| 64 B | Tauri 0.39 / 0.60 ・ WS 0.30 / 0.50 | Tauri 0.77 / 2.39 ・ WS 0.26 / 0.33 | Tauri 1.56 / 4.71 ・ WS 0.16 / 0.22 |
| 2 KiB | Tauri 0.87 / 1.79 ・ WS 0.32 / 0.59 | Tauri 1.03 / 1.57 ・ WS 0.27 / 0.35 | Tauri 3.16 / 3.90 ・ WS 0.16 / 0.22 |
| 96 KiB | Tauri 0.96 / 2.57 ・ WS 0.38 / 4.04 | Tauri 1.98 / 3.38 ・ WS 0.64 / 0.86 | Tauri 4.25 / 6.01 ・ WS 0.26 / 1.46 |
| 1 MiB | Tauri 1.42 / 6.28 ・ WS 0.96 / 3.52 | Tauri 9.88 / 11.96 ・ WS 3.29 / 4.50 | Tauri 13.12 / 20.00 ・ WS 1.91 / 15.72 |

所見:

- p50 は 3 OS とも、すべての大きさで WebSocket が速い。差は Windows で最も大きく（96 KiB で 16 倍）、macOS で最も小さい（2.5 倍）
- Tauri Channel が 96 KiB で往復 2 ms を切るのは macOS だけ。Linux と Windows では段 4 の予算を超える
- p99 は共有ランナーの揺れが大きく（macOS の WS 96 KiB が 4 ms など）、ここからは結論を出さない。参照マシンで測り直す
