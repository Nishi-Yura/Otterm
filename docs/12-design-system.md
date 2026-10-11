# 12. デザイン基盤（Design System）

otterm の画面（タブ、パネル、ステータスバー、ダイアログ、設定画面、mod の宣言的 UI）が共通で使う決まりごと。テーマ作者・mod 作者・本体の開発者が同じ前提で見た目を作るためのもの。

- 正となるのはコード。値は [packages/ui/src/style.css](../packages/ui/src/style.css)（トークンの既定値）と [packages/ui/src/config.ts](../packages/ui/src/config.ts)（テーマからの導出）にある。食い違ったらコードを直すか、この文書を直す
- テーマの構造は [04-ui-theme.md](04-ui-theme.md) §2、mod の宣言的 UI は [05-mod-system.md](05-mod-system.md) §5.3

## 1. 方針

| 方針 | 内容 |
| --- | --- |
| ターミナルが主役 | 周りの UI は小さく、低い彩度で。目立たせるのは状態（失敗、実行中、危険）と、いま操作している場所だけ |
| 色は必ずトークンから | CSS に色の直書きをしない。`--ot-*` だけを使う。テーマを替えれば本体も mod も一緒に変わる |
| テーマはターミナル色だけでも成立する | `[theme.ui]` を書かないテーマでも、UI トークンはターミナル色から導出される（§2.2）。15 種の同梱テーマはこの仕組みで UI まで揃っている |
| 密度は高め、動きは控えめ | 開発ツールとして 1 画面の情報量を優先する。アニメーションは状態の変化を伝えるときだけ、120 ms 以下 |
| 色だけに頼らない | 危険・失敗・成功は色に加えて形かアイコンで区別する（判断 I15） |
| キーボードで完結する | すべての操作にキーかコマンドパレットの入口がある。フォーカスは常に見える |

## 2. 色トークン

### 2.1 UI トークン

`:root` に CSS 変数として置かれる。テーマの `[theme.ui]` のキーがそのまま `--ot-<key>` になる（04 §2.2）。

| トークン | 役割 | 導出（`[theme.ui]` にないとき） |
| --- | --- | --- |
| `--ot-bg` | 画面の地。ターミナルと同じ色 | `terminal.background` |
| `--ot-bg-elevated` | 浮いた面: タブバー、ステータスバー、パネル、メニュー、ダイアログ | 文字色を背景に 8 %（ライトは 5 %）混ぜる |
| `--ot-fg` | 本文 | `terminal.foreground` |
| `--ot-fg-muted` | 補足、ラベル、非選択のタブ | 文字色 60 % + 背景 40 % |
| `--ot-accent` | 選択中、フォーカスリング、主ボタン、リンク | ANSI 4（青） |
| `--ot-border` | 区切り線、入力欄の枠 | 文字色を背景に 14 % |
| `--ot-danger` | 危険、失敗 | ANSI 1（赤） |
| `--ot-success` | 成功 | ANSI 2（緑） |
| `--ot-warning` | 注意、承認待ち | ANSI 3（黄） |
| `--ot-radius` | 角丸 | `6px` |
| `--ot-shadow` | 浮いた面の影 | ダーク `0 4px 16px rgb(0 0 0 / 0.4)`、ライト `0 4px 16px rgb(0 0 0 / 0.15)` |
| `--ot-font-ui` | UI の文字 | `system-ui, "Segoe UI", "Noto Sans JP", sans-serif` |

### 2.2 文字に使う状態色

状態色（赤・緑・黄）はそのまま文字にすると、ライトテーマで読めなくなる（明るい緑の文字など）。**文字に使うときは `-text` の付いた方を使う**。状態色を本文の色へ寄せたもので、ダークでもライトでも本文との対比が保たれる。

| トークン | 定義 | 使う場所 |
| --- | --- | --- |
| `--ot-danger-text` | `color-mix(--ot-danger 72%, --ot-fg)` | 失敗の終了コード、危険の説明文 |
| `--ot-success-text` | `color-mix(--ot-success 75%, --ot-fg)` | 「動作中」「有効」 |
| `--ot-warning-text` | `color-mix(--ot-warning 75%, --ot-fg)` | 承認待ちの mod |

面や線（背景、左の縁、点）には `-text` のない方を使う。

### 2.3 ターミナル色

`--ot-term-bg`、`--ot-term-fg`、`--ot-term-cursor`、`--ot-term-selection`、`--ot-term-ansi-0`〜`7`、`--ot-term-bright-0`〜`7`。UI から ANSI 色を借りるとき（プロンプトバーの縁など）はこれを使う。

### 2.4 部品ごとのトークン（任意）

テーマが特定の部品だけ色を変えたいときのキー。書かなければ §2.1 のトークンが使われる。

| キー | 部品 |
| --- | --- |
| `prompt-bg` / `prompt-fg` / `prompt-edge` / `prompt-ok` / `prompt-failed` / `prompt-folder` / `prompt-branch` / `prompt-font` | otterm のプロンプトバー（判断 M4） |
| `gutter` | ブロックのガター（成功・普通のとき） |
| `statusbar-bg` / `statusbar-fg` | ステータスバー |
| `assist-bg` | 入力支援バー |

### 2.5 ウィンドウの変数（本体が設定する）

テーマや user.css が読むことはあっても、書くものではない。

| 変数 | 内容 |
| --- | --- |
| `--ot-window-alpha` | `appearance.window.opacity` |
| `--ot-bg-image` / `--ot-bg-size` / `--ot-bg-repeat` / `--ot-bg-veil` | 背景画像とそれを薄める幕（判断 M14） |
| `--ot-ui-scale` | `appearance.ui_scale`。タブ、パネル、ダイアログに `zoom` で掛かる |
| `--ot-sidebar-left-width` / `--ot-sidebar-right-width` / `--ot-panel-bottom-height` | `appearance.sidebar.*.width`、`appearance.panel.bottom.height` |

`html` の class: `translucent`（透過か背景画像のとき）、`reduce-motion`（動きを減らす）、`allow-motion`（OS が減らす設定でも動かす、と明示されたとき）。

## 3. 文字

UI の文字は `--ot-font-ui`。ターミナルの文字は `[font]` の設定で、Rust 側で描く（04 §3）。

| 用途 | 大きさ | 太さ |
| --- | --- | --- |
| メタ情報（ID、日時、パンくず、キーの表示） | 11px | 400 |
| ステータスバー、タブ、パネル、メニュー | 12px | 400（選択中のタブは文字色だけ変える） |
| 補完、パレットの候補 | 12.5〜13px | 400 |
| 設定画面の本文 | 13px | 400、見出し 600 |
| 設定画面のページ見出し | 20px | 600 |

- 本文の行の高さは既定（約 1.4）。ターミナルの行の高さは `font.line_height`
- 等幅で見せるもの（コマンド、キー、パス）は `ui-monospace, "Cascadia Mono", Consolas, monospace`（クラス `mono`）
- 文言は Fluent（判断 C7）。日本語は 1 文 40 文字以内を目安にし、ラベルは名詞で終える

## 4. 間隔と寸法

間隔は 2 の倍数を中心にした小さな段階で揃える: **2 / 4 / 6 / 8 / 12 / 16 / 24 px**。部品の中は 4〜8、部品同士は 8〜12、ページの区切りは 16〜24。

| 部品 | 寸法 |
| --- | --- |
| タブバー | 高さ 32px。左に置くときは幅 180px |
| ステータスバー | 高さ 24px、項目の間 12px |
| サイドパネル / 下パネル | 既定の幅 260px / 高さ 220px（`appearance.sidebar.*.width`、`panel.bottom.height`） |
| ボタン（標準 / 小） | 最小の高さ 24px / 20px、横の余白 10px / 6px |
| アイコンだけのボタン | 22〜26px の正方形 |
| 入力欄 | 高さ 24〜28px、余白 5px 8px |
| 浮いた面（メニュー、パレット、ダイアログ） | 角丸 `--ot-radius`、影 `--ot-shadow`、枠 1px `--ot-border` |

マウスで細かく狙わせない: クリックできるものは 22px 角以上。ドラッグでしかできない操作は作らない（パネルの移動・ステータスバーの並べ替えは、設定画面にも同じ操作がある）。

## 5. アイコン

- **本体のアイコン集** [packages/ui/src/icons.tsx](../packages/ui/src/icons.tsx) を使う。24px の格子、線幅 2、角と端は丸、塗りなし。Lucide と同じ名前と雰囲気で、絵は otterm が描いたもの
- mod は `icon: "folder"` のように名前で指定する。ない名前は小さな丸になる
- **絵文字をアイコンに使わない**。環境で形が変わり、色も揃わない（台詞の中の絵文字は別）
- 飾りのアイコンは `aria-hidden`。アイコンだけのボタンには必ず `aria-label` と `title`（宣言的 UI では `iconOnly: true` を付けると `text` がそれになる）
- 大きさは周りの文字に合わせる（`1em`）。色は `currentColor`

## 6. 状態の見せ方

| 状態 | 見せ方 |
| --- | --- |
| ホバー | 地に文字色を 6〜12 % 混ぜる |
| 選択中 | アクセント色を 18 % 混ぜた地。タブは地を `--ot-bg` にして本文色の文字 |
| キーボードのフォーカス | 2px の `--ot-accent` のリング、1px 離す（`:focus-visible`）。消さない |
| 無効 | 不透明度 0.4〜0.5、カーソルは通常 |
| 失敗したブロック | 赤の **破線** のガター、プロンプトバーに `✗ 終了コード` |
| 実行中のブロック | 青のガター（点滅。動きを減らす設定では止まる） |
| 危険な確認 | 赤い **斜線の縁** と警告アイコン。安全な選択肢にフォーカスと主ボタンの色。「そのまま実行」は赤い文字の枠だけ |
| エラー助言 | 左に 3px の赤い縁のカード |

色の意味は固定する: 赤 = 取り返しがつかない／失敗、黄 = 確認が要る、緑 = うまくいった、青（アクセント） = いま操作しているもの。

## 7. 動き

- トランジションは 120 ms 以下。開くより閉じる方を速く
- 位置や大きさを動かすアニメーションは使わない（`opacity` と `transform` だけ）
- OS の「視差効果を減らす」か `accessibility.reduce_motion` で、すべてのアニメーションとトランジションを止める（`html.reduce-motion`）
- ターミナルの描画とカーソルは別扱い（`terminal.cursor.smooth`）

## 8. 部品と `data-ot` 属性

テーマの CSS と user.css は、クラス名ではなく `data-ot` 属性で要素を選ぶ（04 §2.3）。クラス名は予告なく変わるが、この一覧の属性は互換を保つ。

| 場所 | `data-ot` |
| --- | --- |
| ウィンドウ | `safe-banner`（セーフモードの帯） |
| タブ | `tabbar`、`tab` |
| ペインとターミナル | `pane`、`terminal`、`prompt-header`（プロンプトバー）、`block-actions`（ブロックのボタン） |
| パネル | `sidebar.left` / `sidebar.right` / `panel.bottom`（パネル全体）、`panel-tab`、`panel-body`、`panel-close` |
| ステータスバー | `statusbar`、`statusbar-item`（`data-item` に項目 ID） |
| 入力支援 | `assist-bar`、`assist-explain`、`error-hint`、`completion`、`completion-item`、`multiline-editor` |
| 浮くもの | `palette`、`palette-input`、`palette-item`、`context-menu`、`menu-item`、`search`、`search-input`、`prompt`、`prompt-button`、`toast`、`mod-dialog`、`mod-permissions` |
| 設定画面 | `settings`、`settings-category`、`settings-row`、`theme-card`、`theme-editor`、`layout-card`、`font-preview`、`keybinding`、`mod-settings`、`mod-row` |

例:

```css
/* タブを丸く、選択中だけアクセントの下線 */
[data-ot="tab"] { border-radius: 10px 10px 0 0; }
[data-ot="tab"][aria-selected="true"] { box-shadow: inset 0 -2px 0 var(--ot-accent); }

/* ステータスバーを少し大きく */
[data-ot="statusbar"] { height: 28px; font-size: 13px; }
```

## 9. CSS の重なり順

後に書かれたものが勝つ。

1. 本体の CSS（トークンの既定値を含む）
2. テーマのトークン（`[theme.ui]` と導出値。`html` の style に入る）
3. テーマの CSS（`[theme.css]`）
4. user.css（`<設定>/user.css`、設定画面 › 詳細で編集）

## 10. mod の UI

- 宣言的 UI（05 §5.3）を使えば、トークン・フォーカス・キーボード操作・ダーク／ライトは本体が面倒を見る
- `style` で色を指定するときも `var(--ot-*)` を使う
- `custom`（iframe）の中にもトークンが注入される。直書きの色は避ける

## 11. 出す前の確認

- [ ] 色は `--ot-*` だけ。文字に状態色を使うときは `-text`
- [ ] otterm Dark と otterm Light の両方で読める（小さい文字は対比 4.5:1 以上）。High Contrast でも崩れない
- [ ] 状態が色だけで区別されていない（形かアイコンが付いている）
- [ ] アイコンは icons.tsx から。絵文字を使っていない。アイコンだけのボタンにラベルがある
- [ ] Tab で全部に届き、フォーカスリングが見える。Esc で閉じる
- [ ] 動きを減らす設定で止まる
- [ ] UI の拡大率 0.8 と 2.0 で崩れない
- [ ] 日本語と英語の両方で文言が切れない（英語の方が長くなりがち）
