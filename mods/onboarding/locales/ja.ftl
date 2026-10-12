# otterm.onboarding の文言。コードからは ctx.i18n.t("id") で参照する。
# 台詞は docs/08 §5.2 に従う（2 文まで、1 文 40 字以内、否定語で始めない、行動にはボタンを付ける）。
# 両ファイルは同じ id を持つこと。

## 共通のボタン

btn-skip = スキップ
btn-ok = OK
btn-later = あとで
btn-start = 始める
btn-yes = はい
btn-no = いいえ
btn-keep-default = おすすめのまま
btn-done = できた
btn-keep = 残す
btn-trash = フォルダを削除する

## 初回案内（docs/03 §11.1）

onboarding-greeting = はじめまして、コツメです。
onboarding-language-question = まず、使う言語を選んでください。
onboarding-lang-ja = 日本語
onboarding-lang-en = English
onboarding-level-question = ターミナルを使ったことはありますか？
onboarding-level-first = はじめて
onboarding-level-sometimes = たまに使う
onboarding-level-daily = 毎日使う
onboarding-level-first-desc = はじめて: 操作を 1 つずつ説明します。危ない操作は止めます。
onboarding-level-sometimes-desc = たまに使う: コマンドの意味を横に出します。危ない操作は確認します。
onboarding-level-daily-desc = 毎日使う: 普通のターミナルとして動きます。危ない操作だけ止めます。
onboarding-shell-question = どのシェル（コマンドを受け取るプログラム）を使いますか？
onboarding-shell-body = いまは { $shell } を使います。このままで始められます。
onboarding-shell-unknown = 最初のターミナルで、おすすめのシェルを使います。
onboarding-shell-cmd = cmd では「シェル統合なし」になります。PowerShell 7 がおすすめです。
shell-name-pwsh = PowerShell 7
shell-name-powershell = Windows PowerShell
shell-name-cmd = cmd
shell-name-bash = bash
shell-name-zsh = zsh
shell-name-fish = fish
shell-name-other = このシェル
onboarding-integration-title = シェル統合について
onboarding-integration-body = otterm は起動するシェルにだけ小さなフックを読み込ませます。あなたの設定ファイルは変更しません。
onboarding-integration-rc-note = 他のターミナルでも使いたいときは、設定から 1 行だけ追記できます。
onboarding-theme-question = 見た目を選びましょう。あとからいつでも変えられます。
onboarding-theme-light = ライト
onboarding-theme-dark = ダーク
onboarding-theme-system = OS に合わせる
onboarding-network-question = 起動時に更新を確認してもいいですか？
onboarding-network-body = これ以外に otterm が自分から外部へ接続することはありません。
onboarding-tutorial-offer = 「はじめてのターミナル」を一緒にやってみますか？ 10 分ほどです。
onboarding-ai-title = AI について
onboarding-ai-offer = AI に質問する機能を使いますか？ 使うときは、送る内容を毎回見せます。あとから設定でも変えられます。
onboarding-done = 準備ができました。何か打ってみましょう。

## チュートリアル（docs/03 §11.3）

tutorial-panel-title = チュートリアル
tutorial-title = はじめてのターミナル
tutorial-progress = { $n } / 6
tutorial-ch1-title = ここはどこ？
tutorial-ch1-intro = ターミナルは「どこかのフォルダ」にいます。今いる場所を `{ $command }` で確認しましょう。
tutorial-ch1-ls = 次は `{ $command }` で、このフォルダの中身を見てみましょう。
tutorial-ch2-title = 移動する
tutorial-ch2-intro = `{ $command }` で、中の inside フォルダに入ってみましょう。
tutorial-ch2-up = `{ $command }` で 1 つ上のフォルダに戻れます。
tutorial-ch3-title = ファイルを作る・見る
tutorial-ch3-create = `{ $command }` で hello.txt を作り、中に hello と書きます。
tutorial-ch3-read = 書けました。`{ $command }` で中身を見てみましょう。
tutorial-ch4-title = プログラムを動かす
tutorial-ch4-run = `{ $command }` で hello.py を実行します。
tutorial-alt-hint = 見つからないときは、代わりに次のどれかを試してください。
tutorial-ch5-title = 困ったとき
tutorial-ch5-interrupt = 止まらないときは Ctrl+C を押します。`{ $command }` を実行して、Ctrl+C で止めてみましょう。
tutorial-ch5-error = わざと間違えてみましょう。`{ $command }` を実行すると、エラーの読み方が分かります。
tutorial-ch5-card = 失敗すると赤いカードが出ます。赤いカードは次の一手の助言です。
tutorial-ch6-title = otterm の便利機能
tutorial-ch6-history = Ctrl+R で、前に打ったコマンドを探せます。
tutorial-ch6-tree = 左のファイルツリーから、ファイルを開けます。
tutorial-ch6-rerun = ブロックを右クリックして「もう一度実行」を選ぶと、同じコマンドをもう一度走らせられます。
tutorial-step-done = できました。
tutorial-step-retry = 惜しいです。もう一度試しましょう。期待しているのは `{ $expected }` です。
tutorial-complete = 全部できました。これで { $commands } は使えます。
tutorial-commands-posix = cd と ls
tutorial-commands-pwsh = Set-Location と Get-ChildItem
tutorial-cleanup = 練習用のフォルダ { $path } を削除しますか？
tutorial-cleaned = ゴミ箱に送りました。
tutorial-no-session = 先にターミナルを開いてから、もう一度試してください。
tutorial-reset-done = チュートリアルの進み具合をリセットしました。

## コマンドパレット

cmd-restart-title = 初回案内をもう一度見る
cmd-tutorial-start-title = チュートリアルを始める
cmd-tutorial-reset-title = チュートリアルの進み具合をリセット
