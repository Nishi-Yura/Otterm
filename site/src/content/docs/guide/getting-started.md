---
title: はじめに／インストール
description: otterm のインストール方法と最初の一歩。
sidebar:
  order: 1
---

otterm は、ターミナルを初めて使う人にも、毎日使う開発者にも役立つように作られたターミナルエミュレータです。
普通のターミナルとして bash、zsh、PowerShell、cmd などをそのまま動かせます。

入れたばかりの otterm は、何も足していないターミナルです。コツメ、入力の手助け、ファイルツリー、履歴検索、プロンプトバーなどはすべて mod で、設定 › mod（ステータスバーの「mod」）から、ほしいものだけをオンにします。「おすすめをまとめてオンにする」で一度に入れることもできます。

> **注意**: v1.0 は Windows（x64）版です。macOS / Linux 版は実機で確かめてから 1.0.x で出します。それまでは [リポジトリ](https://github.com/Nishi-Yura/Otterm) をソースからビルドしてください。

## インストール

### Windows

[Releases](https://github.com/Nishi-Yura/Otterm/releases/latest) から `otterm_<version>_x64-setup.exe` をダウンロードして実行します（ユーザー単位のインストール、管理者権限は不要）。winget への登録が済めば、次でも入ります。

```powershell
winget install otterm
```

インストーラは `otterm.exe` と、コマンドラインから使うための `otterm.com` を同じフォルダに入れ、そのフォルダをユーザーの PATH に足します。
PowerShell や cmd で `otterm` と打つと `otterm.com` が動きます。

インストーラにはコード署名がないため、初回は SmartScreen の確認が出ることがあります（「詳細情報」→「実行」）。

### macOS（Homebrew）

```sh
brew install --cask nishi-yura/otterm/otterm
```

otterm の tap から入れます。アプリは Apple の公証を受けていないため、初回は Finder で otterm.app を右クリックして「開く」を選んでください。

### Linux（AppImage）

配布される AppImage ファイルをダウンロードし、実行権限を付けて起動します。

```sh
chmod +x otterm-*.AppImage
./otterm-*.AppImage
```

## 初回起動

初回起動では、次の順に設定を聞かれます。どれも後から変更できます。

1. 言語（日本語、English、自動）
2. ターミナルの慣れ具合に合わせたガイドレベル（[入力支援とガイドレベル](/guide/input-assist/) を参照）
3. 使うシェル。Windows では PowerShell 7 を勧めます
4. テーマ（ライト、ダーク、OS に合わせる）
5. 更新の確認を行うかどうか。確認を許可しない限り、otterm は外部へ接続しません（Mod のストアを初めて開くときは、別に確認されます）

オンボーディングをスキップすると、ガイドレベルは 1 になります。

## 最初にやること

1. `Ctrl+Shift+T`（macOS は `Cmd+T`）で新しいタブを開きます。
2. `ls`（PowerShell なら `Get-ChildItem`）を打って Enter を押します。
3. 出力の上にあるプロンプトバーに注目してください。コマンドの成功・失敗や所要時間が表示されます。
4. 困ったら `F1` を押すと、画面の部品に説明が出るヘルプモードになります。

次は [基本操作](/guide/basics/) を読んでください。
