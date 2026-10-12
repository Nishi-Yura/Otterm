# メディア変換ツールの辞書 / Media tools dictionary

`ffmpeg`、`ffprobe`、`magick`（ImageMagick 7。`convert` / `mogrify` も）、`7z`、`pandoc`、`yt-dlp` の主な使い方を、日本語と英語で説明します。動画を MP4 にする、音声だけ取り出す、画像を縮小する、書庫を作る・展開する、Markdown を Word や PDF にする、といった「ちょっと変換したい」ときのコマンドです。`tar`、`zip`、`unzip`、`gzip` は組み込みの辞書にあるため、この mod には含みません。

`magick mogrify` は入力画像そのものを書き換えるため確認を求め、`ffmpeg -y` と `7z -y` は確認なしの上書きになるため注意を表示します。

## インストール

otterm の mod として読み込みます。辞書データは `dictionary/` フォルダにあります。

## English

A Japanese and English dictionary for `ffmpeg`, `ffprobe`, `magick` (ImageMagick 7, also `convert` / `mogrify`), `7z`, `pandoc` and `yt-dlp`: the commands for "I just want to convert this": video to MP4, audio extraction, image resizing, archives, Markdown to Word or PDF. `tar`, `zip`, `unzip` and `gzip` are already in the bundled dictionary, so they are not included here.

`magick mogrify` asks for confirmation because it rewrites the input images, and `ffmpeg -y` and `7z -y` show a warning because they overwrite without asking.
