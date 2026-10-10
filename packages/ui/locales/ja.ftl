# otterm — コツメの台詞と UI 文言（日本語）
# 本体の UI 文言とコツメの台詞。コツメの分は M4.5 で mods/otterm.mascot/locales/ja.ftl に分ける
# 仕様: docs/08-character.md §5
#
# 規約
# - 2 文まで。1 文 40 文字以内。否定語で始めない。行動を促す文には必ずボタン（.action-*）を添える
# - .mood 属性で表情を指定する（calm | thinking | alert | happy）。省略時は calm
# - 変数は { $name }。複数形・件数は Fluent のセレクタで分ける

## 共通

mascot-name = コツメ
app-name = otterm

action-insert = 入力欄に入れる
action-run-anyway = そのまま実行
action-cancel = やめる
action-show-more = 詳しく見る
action-open-settings = 設定を開く
action-dont-show-again = 今後このコマンドは確認しない
action-trust = 信頼する
action-not-now = あとで
action-yes = はい
action-no = いいえ

## オンボーディング

onboarding-hello = はじめまして、{ mascot-name }です。まず、どのくらい手伝うか決めましょう。
    .mood = happy
onboarding-level-question = ターミナルを使ったことはありますか？
onboarding-level-first = はじめて
onboarding-level-first-desc = 操作を 1 つずつ説明します。危ない操作は止めます。
onboarding-level-sometimes = たまに使う
onboarding-level-sometimes-desc = コマンドの意味を横に出します。危ない操作は確認します。
onboarding-level-daily = 毎日使う
onboarding-level-daily-desc = 普通のターミナルとして動きます。危ない操作だけ止めます。
onboarding-shell-question = どのシェル（コマンドを受け取るプログラム）を使いますか？
onboarding-shell-recommended = おすすめ
onboarding-integration-title = シェル統合について
onboarding-integration-body = { app-name } は起動するシェルにだけ小さなフックを読み込ませます。あなたの設定ファイルは変更しません。
onboarding-integration-rc = 他のターミナルでも { app-name } の統合を使う（設定ファイルに 1 行追記）
onboarding-theme-question = 見た目を選びましょう。あとからいつでも変えられます。
onboarding-network-question = 起動時に更新を確認してもいいですか？
onboarding-network-body = これ以外に { app-name } が自分から外部へ接続することはありません。
onboarding-tutorial-offer = 「はじめてのターミナル」を一緒にやってみますか？ 10 分ほどです。
    .mood = happy
onboarding-ai-offer = { mascot-name }に AI の力を貸しますか？ あとから設定でも選べます。
onboarding-done = 準備ができました。何か打ってみましょう。
    .mood = happy

## 空のタブ（初回のみ）

empty-tab-first = ここに文字を打って Enter を押すと実行されます。試しに { $command } と打ってみましょう。
empty-tab-first-hint = 入力した文字の意味は、この下に表示されます。

## 入力支援バー

assist-estimated = （推定）
assist-unknown-command = 辞書にないコマンドです。一度実行すると説明を覚えます。
assist-integration-off = シェル統合が無効です
assist-explain-format = { $command }: { $summary }

## 危険ガード

danger-title-confirm = 確認してください
    .mood = alert
danger-title-block = このコマンドは実行できません
    .mood = alert
danger-rm-recursive = このフォルダの中身がすべて消えます。ゴミ箱には入りません。
    .mood = alert
danger-rm-recursive-alt = 代わりにゴミ箱へ送りますか？
danger-force-push = リモートの履歴を強制的に上書きします。他の人のコミットが消えることがあります。
    .mood = alert
danger-reset-hard = 未コミットの変更がすべて消えます。元に戻せません。
    .mood = alert
danger-pipe-to-shell = ダウンロードした内容をそのまま実行します。中身を確認してから実行する方が安全です。
    .mood = alert
danger-generic = { $message }
    .mood = alert
danger-alternative-label = 代わりに: { $command }
danger-blocked-body = { $message } 実行は止めました。

## エラー助言

error-hint-title = うまくいきませんでした
    .mood = alert
error-command-not-found = { $command } が見つかりません。インストールされていないか、名前が違うかもしれません。
    .mood = alert
error-command-not-found-install = インストールするには: { $install }
error-permission-denied = 権限がありません。自分のファイルでないか、管理者権限が必要です。
    .mood = alert
error-no-such-file = { $path } が見つかりません。スペルと今いるフォルダを確認してください。
    .mood = alert
error-not-git-repo = ここは Git リポジトリではありません。リポジトリのフォルダへ移動するか、{ $fix } で始められます。
error-port-in-use = ポート { $port } は使用中です。使っているプログラムを確認できます。
error-module-not-found = { $module } がインストールされていません。{ $fix } で入れられます。
error-ask-ai = { mascot-name }に聞く
error-interrupted = Ctrl+C で止めました。エラーではありません。
    .mood = calm

## 待機と完了

waiting-long = 実行中です。終わったら知らせます。
    .mood = thinking
done-long = 終わりました。{ $seconds ->
        [one] 1 秒
       *[other] { $seconds } 秒
    }かかりました。
    .mood = happy
done-long-failed = 終わりましたが、エラーで止まりました（終了コード { $code }）。
    .mood = alert
notify-done-title = { $command } が終わりました
notify-done-body = { $seconds } 秒。終了コード { $code }

## ブロック

block-collapse = 折りたたむ
block-expand = 展開する
block-copy = コピー
block-rerun = もう一度実行
block-save-output = 出力を保存
block-share = 共有用にコピー
block-truncated = { $hidden } 行を省略しています。クリックで表示。
block-exit-code = 終了コード { $code }

## ファイルツリーの学習ヒント

learn-cd = { $command } でフォルダを移動しました。
learn-mkdir = フォルダを作りました。コマンドなら { $command } です。
learn-touch = ファイルを作りました。コマンドなら { $command } です。
learn-mv = 名前を変えました。コマンドなら { $command } です。
learn-trash = ゴミ箱に送りました。{ $rm } は元に戻せないので、{ app-name } はゴミ箱を使います。
learn-run-inserted = 実行コマンドを入力欄に入れました。Enter で実行します。

## リンクとクリック

link-hint-first = リンクやファイル名は Ctrl を押しながらクリックすると開けます。
link-open-file = { $path } を開く
link-open-url = ブラウザで開く
link-copy-path = パスをコピー

## 貼り付け

paste-multiline-title = 複数行を貼り付けようとしています
    .mood = alert
paste-multiline-body = { $lines } 行が順番に実行される可能性があります。内容を確認してください。
paste-confirm = 貼り付ける
paste-as-single-line = 1 行にまとめて貼り付ける

## ワークスペースの信頼

trust-title = このフォルダの設定を信頼しますか？
    .mood = alert
trust-body = { $path } には { app-name } の設定ファイルがあります。信頼すると、タブの自動コマンドと mod が有効になります。
trust-commands-label = 実行されるコマンド
trust-mods-label = 有効になる mod
trust-later = 信頼せずに開く

## mod

mod-installed = { $name } を入れました。{ $adds }
    .mood = happy
mod-installed-generic = { $name } を入れました。
    .mood = happy
mod-permissions-title = { $name } は次のことを行います
mod-permission-fs-read = { $scope } のファイルを読む
mod-permission-fs-write = { $scope } にファイルを書く
mod-permission-process = { $commands } を実行する
mod-permission-network = { $hosts } に接続する
mod-permission-clipboard = クリップボードを読み書きする
mod-permission-terminal-read = ターミナルの出力を読む
mod-permission-terminal-write = ターミナルに入力を書き込む（コマンドを実行できます）
mod-permission-ai = 設定した AI に問い合わせる
mod-permission-none-write = この mod はターミナルに入力を書き込みません。
mod-permission-none-network = この mod はネットワークに接続しません。
mod-allow-enable = 許可して有効化
mod-crashed = { $name } が停止しました。他の機能には影響ありません。
    .mood = alert
mod-crashed-disabled = { $name } が続けて停止したため、無効にしました。
    .mood = alert
mod-wrote-terminal = { $name } がターミナルに入力しました: { $text }
mod-slow = { $name } が入力を { $ms } ms 遅くしています。

## 設定画面

settings-mascot-intro = ここで私の表示を変えられます。消すこともできます。
settings-mascot-visible = { mascot-name }を表示する
settings-mascot-speech = 吹き出しを出す
settings-mascot-mood = 表情を変える
settings-mascot-position = 表示する場所
settings-mascot-outfit = 衣装
settings-mascot-reset-hints = 初回の案内をもう一度見る
settings-guide-level = ガイドレベル

## セーフモード

safe-mode-started = テーマと mod を止めて起動しました。設定から戻せます。
    .mood = calm

## チュートリアル

tutorial-title = はじめてのターミナル
tutorial-start = 一緒にやってみましょう。実際に打って進めます。
    .mood = happy
tutorial-ch1-title = ここはどこ？
tutorial-ch1-intro = ターミナルはいつも「どこかのフォルダ」にいます。今いる場所を { $command } で確認してみましょう。
tutorial-ch1-ls = 次は { $command } で、このフォルダの中身を見てみましょう。
tutorial-ch2-title = 移動する
tutorial-ch2-intro = { $command } でフォルダに入ります。tutorial フォルダに入ってみましょう。
tutorial-ch2-up = { $command } で 1 つ上に戻れます。
tutorial-ch3-title = ファイルを作る・見る
tutorial-ch3-create = { $command } でファイルに文字を書き込めます。
tutorial-ch3-read = 書けました。{ $command } で中身を見てみましょう。
tutorial-ch4-title = プログラムを動かす
tutorial-ch4-run = { $command } で hello.py を実行します。
tutorial-ch5-title = 困ったとき
tutorial-ch5-interrupt = 止まらないときは Ctrl+C を押します。{ $command } を実行して、Ctrl+C で止めてみましょう。
tutorial-ch5-error = わざと間違えてみましょう。{ $command } を実行すると、エラーの読み方が分かります。
tutorial-ch6-title = { app-name } の便利機能
tutorial-ch6-history = Ctrl+R で前に打ったコマンドを探せます。
tutorial-ch6-tree = 左のファイルツリーからファイルを開けます。
tutorial-step-done = できました。
    .mood = happy
tutorial-step-retry = 惜しいです。もう一度やってみましょう。期待しているのは { $expected } です。
tutorial-complete = 全部できました。これで { $commands } は使えます。
    .mood = happy
tutorial-cleanup = 練習用のフォルダ { $path } を削除しますか？

## AI（otterm.ai-assist）

ai-ask-placeholder = やりたいことを書いてください
ai-thinking = 考えています…
    .mood = thinking
ai-result-explain = { $summary }
ai-result-danger = このコマンドは危険な操作を含みます。
    .mood = alert
ai-result-unknown-option = { $option } は辞書で確認できないオプションです。
ai-preview-title = 次の内容を { $provider } に送ります
ai-preview-redacted = 伏せた箇所: { $count ->
        [one] 1 件
       *[other] { $count } 件
    }
ai-preview-send = 送信
ai-preview-dont-show = 今後は確認しない（送信内容はいつでも見られます）
ai-connection-failed = つながりませんでした。設定を確認しますか？
    .mood = alert
ai-disabled-workspace = このワークスペースでは AI を使わない設定です。
ai-fix-title = 直し方
ai-fix-cause = 原因
ai-fix-command = 修正したコマンド
ai-summary-title = さっきまでの作業
ai-step-title = 計画
ai-step-run = このステップを実行
ai-step-stop = やめる
ai-step-failed = ステップ { $n } が失敗したので止めました。
    .mood = alert

## パスワード入力

echo-off-notice = パスワードの入力中です。入力は表示されず、記録もされません。
    .mood = calm

## メモリ・性能

memory-warning = メモリを { $gb } GB 使っています。大きなタブ: { $tab }
mod-overhead-warning = mod が入力を遅くしています。開発者モードで確認できます。

## ターミナル本体

terminal-label = ターミナル
terminal-input-label = ターミナルへの入力
process-exited = { $code ->
    [none] プロセスが終了しました
   *[other] プロセスが終了しました（終了コード { $code }）
}
start-failed = シェルを起動できませんでした: { $error }
config-ignored = config.toml の一部を無視しました: { $keys }
config-unreadable = 設定を読み込めませんでした: { $error }
launch-unknown = 起動時の引数を使えませんでした: { $args }
copy-failed = クリップボードにコピーできませんでした: { $error }

## 検索

search-label = ターミナル内を検索
search-placeholder = 検索
search-match-case = 大文字と小文字を区別
search-whole-word = 単語単位
search-regex = 正規表現
search-invalid = 式が正しくありません
search-older = 前へ（古い方、Enter）
search-newer = 次へ（新しい方、Shift+Enter）
search-close = 閉じる（Esc）

## 右クリックメニュー

menu-copy = コピー
menu-paste = 貼り付け
menu-select-all = すべて選択
menu-clear-scrollback = スクロールバックを消去
menu-reset-modes = 端末の状態をリセット
menu-open-config = 設定ファイルを開く
menu-search = 検索
menu-open-link = リンクを開く
menu-copy-link = リンクをコピー

## タブとペイン

tab-new = 新しいタブ
tab-new-profile = シェルを選んで新しいタブ
profile-pwsh = PowerShell 7
profile-powershell = Windows PowerShell
profile-cmd = コマンド プロンプト
profile-git-bash = Git Bash
tab-close = タブを閉じる
tab-untitled = ターミナル
close-running-title = 実行中のプログラムがあります
close-running-body = { $program } が実行中です。閉じると終了します。
close-running-confirm = 閉じる

## クリップボード（OSC 52）

osc52-ask = 実行中のプログラムがクリップボードに { $chars } 文字を書き込もうとしています。
osc52-allow = 許可する
osc52-allow-always = このタブでは常に許可
osc52-deny = 拒否する
