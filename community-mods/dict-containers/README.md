# コンテナ周りの辞書 / Container tools dictionary

`podman`、`docker-compose`（旧版 v1）、`minikube`、`kind` の主な使い方を、日本語と英語で説明します。`docker` 本体は組み込みの辞書にあるため、この mod には含みません。

`podman system prune -a` や `--volumes`、`podman volume prune`、`docker-compose down -v`、`minikube delete --all`、`kind delete clusters --all` は、データを消すおそれがあるため確認を求めます。

注意: `docker-compose` は旧版です。新しい環境では `docker compose`（スペース区切り、Docker に同梱される v2）を使ってください。

## インストール

otterm の mod として読み込みます。辞書データは `dictionary/` フォルダにあります。

## English

A Japanese and English dictionary for `podman`, `docker-compose` (legacy v1), `minikube` and `kind`. The `docker` command is already in the bundled dictionary, so it is not included here.

Commands that can delete data, such as `podman system prune -a`, `--volumes`, `podman volume prune`, `docker-compose down -v`, `minikube delete --all` and `kind delete clusters --all`, ask for confirmation.

Note: `docker-compose` is the legacy v1 tool. In new setups, use `docker compose` (with a space; v2, bundled with Docker).
