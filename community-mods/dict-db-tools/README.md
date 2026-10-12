# データベースクライアントの辞書 / Database clients dictionary

`psql`、`mysql`（`mariadb`）、`sqlite3`、`redis-cli`（`valkey-cli`）、`mongosh`、`pg_dump`、`mysqldump` の主な使い方を、日本語と英語で説明します。接続のしかた、1 文だけ実行する方法、バックアップの取り方と、よくあるエラー（認証失敗、接続拒否、データベースがない）の読み方が分かります。

`psql` / `mysql` / `sqlite3` 経由の `DROP` と `TRUNCATE`、`redis-cli` の `FLUSHALL` / `FLUSHDB`、`mongosh` の `dropDatabase()` / `drop()` は、データを消すため実行前に確認を求め、先にバックアップを取るコマンドを提案します。

## インストール

otterm の mod として読み込みます。辞書データは `dictionary/` フォルダにあります。

## English

A Japanese and English dictionary for `psql`, `mysql` (`mariadb`), `sqlite3`, `redis-cli` (`valkey-cli`), `mongosh`, `pg_dump` and `mysqldump`: how to connect, run a single statement, take a backup, and read the common errors (authentication failed, connection refused, unknown database).

`DROP` and `TRUNCATE` through `psql` / `mysql` / `sqlite3`, `FLUSHALL` / `FLUSHDB` in `redis-cli` and `dropDatabase()` / `drop()` in `mongosh` ask for confirmation before running and suggest a backup command.
