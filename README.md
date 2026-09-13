# slides

発表スライド置き場。**HTML / CSS / JS の1ファイル完結**で、ビルドもフレームワークも使わない。
ブラウザで `slide.html` を開けばそのまま再生でき、印刷ダイアログから PDF にできる。

## 構成

```
.
├── index.html                    # 各スライドへのリンク一覧（入口）
├── stage.html                    # 複数のデッキを 1 画面で切り替えて投影する
├── template/                     # 雛形。ここを複製して新しいスライドを作る
│   ├── slide.html
│   └── images/placeholder.svg
├── decks/                        # 発表ごとのスライド
│   ├── 2026-06-bluesky-meetup/   # 1発表なら直下に slide.html
│   │   ├── slide.html
│   │   └── images/
│   └── 2026-09-bluesky-meetup/   # 1イベントで複数登壇するときは役割ごとに分ける
│       ├── mc/                   # 司会進行
│       │   ├── slide.html
│       │   └── images/
│       └── lt/
│           ├── slide.html
│           └── images/
└── README.md
```

## 新しいスライドを作る

`decks/<日付>-<イベント名>/` に `template/` をコピーする。日付は `YYYY-MM`（同月に複数あるなら `YYYY-MM-DD`）。

```sh
cp -r template decks/2026-10-example-conf
```

同じイベントで複数のスライドを持つとき（司会と LT を兼ねる、など）は、イベントの
ディレクトリを切ってその下に役割ごとのディレクトリを置く。`images/` は `slide.html`
からの相対参照なので、一段深くなっても参照は壊れない。

```sh
mkdir decks/2026-10-example-conf
cp -r template decks/2026-10-example-conf/mc
cp -r template decks/2026-10-example-conf/lt
```

作ったら **`index.html` に 1 項目足す**。`<!-- ▼スライドを足したら -->` のコメントの下に
`<li>` を 1 つコピーして、リンク先・役割・名前・枚数・説明を書き換えるだけ。

あとは `decks/2026-10-example-conf/slide.html` を編集するだけ。編集ポイントには
`<!-- ▼差し替え -->` のコメントが付いているので、そこを順に埋めていく。
使わない種別のスライドは `<section class="slide">...</section>` ごと消してよい。

確認するときはローカルにサーバを立てる（`file://` でも開けるが、画像の扱いを揃えるため推奨）。

```sh
python3 -m http.server 8000 --bind 127.0.0.1
# → http://127.0.0.1:8000/decks/2026-10-example-conf/slide.html
```

## ページの追加

`<div class="deck">` の中に `<section>` を1枚足すだけ。**枚数は JS が DOM から数えるので、
カウンタを直す必要はない。** `data-slide` は人間用の目印なので、順番を入れ替えたら振り直せばよい。

```html
<section class="slide" data-slide="13">
  <h2 class="section-title">見出し</h2>
  ...
</section>
```

`template/slide.html` に入っているスライド種別（`class` と中身の組み合わせ）:

| 種別 | 書き方 | 用途 |
|---|---|---|
| 表紙 | `.slide.cover` | タイトル + サブタイトル。背景写真も敷ける |
| 目次 | `ol.agenda` | 自動で連番（01, 02, …）が振られる |
| セクション扉 | `.slide.statement` | 場面転換・問いかけ |
| 本文 + 画像 | `.two-col` + `.col-text` | 左に文章、右に画像の2カラム |
| 箇条書き + 画像 | `.two-col` + `ul.bullets` | 同上の箇条書き版 |
| カード3枚 | `.cards-3` | 並列する3つのポイント |
| 比較 | `.cards-2` + `.card.bordered-top` | Before / After |
| コード | `.code-block` + `pre > code` | ソースの引用 |
| 引用 | `.slide.quote-slide` | 言葉を大きく見せる |
| 額縁メッセージ | `.frame-card` | 1枚で言い切る |
| 大きな一言 | `.split-hero` | 左に短い語、右に補足 |
| 締め | `.slide.final` | 謝辞・連絡先 |

スライドは常に **1280×720 でレイアウト**され、画面が狭いときは `transform: scale()` で
丸ごと縮小される（JS が各スライドを `.frame` で包み、その実測幅から倍率 `--s` を決める）。文字サイズは `min(N cqi, 最大px)` で
スライド幅 1280 に対する比率で決まるので、スマホで見ても PC と同じ見た目が縮小されるだけ。
ピクセル決め打ちで書き足しても壊れないが、スライドの外にはみ出す指定はしないこと。

配色を変えたいときは、先頭の `:root` にある `--accent` / `--accent-dark` / `--accent-soft`
の3つを差し替える。それ以外の CSS は触らなくてよい。

## キーボード操作

| キー | 動作 |
|---|---|
| `→` / `Space` / `PageDown` | 次のスライド |
| `←` / `PageUp` | 前のスライド |
| `F` | プレゼンモード（1枚ずつ表示）の切り替え |
| `Shift` + `F` | **全画面**（プレゼンモード + ブラウザの全画面） |
| `P` | **発表者ビュー**を別ウィンドウで開く |
| `Esc` | プレゼンモード / 全画面を抜ける |
| `Ctrl` / `Cmd` + `P` | PDF出力（印刷ダイアログ） |

画面下のツールバーからも同じ操作ができる（← → / プレゼン / 全画面 / 発表者 / PDF出力）。ツールバーは印刷時には出ない。

表示モードは3つある。

- **スクロールモード**（初期状態）: 全スライドが縦に並ぶ。推敲・見直し向け
- **プレゼンモード**（`F`）: 1枚ずつ表示。本番向け。「全画面」ボタンか `Shift+F` でブラウザごと全画面になる
- **発表者ビュー**（`P`）: 別ウィンドウに「いま」のスライドを大きく、「次」を小さく、時計と経過時間を出す。
  プロジェクターにはメインのウィンドウを全画面で出し、手元では発表者ビューを見る。
  どちらのウィンドウで `→` を押しても両方が進む

発表者ビューは同じ HTML を `#presenter` 付きで開いているだけなので、ファイルを直接開いた場合（`file://`）でも動く。
ポップアップをブロックされたら許可してから押し直す。

## 複数のデッキを切り替えながら投影する（stage.html）

司会をしながら自分の LT も出す、といった **同じ PC から複数のデッキを出す**ときは `stage.html` を使う。
デッキのパスを `?d=` にカンマ区切りで渡す。

```
stage.html?d=decks/2026-10-example-conf/mc/slide.html,decks/2026-10-example-conf/lt/slide.html
```

`index.html` の各イベント見出しに「まとめて投影」のリンクがある。

- 各デッキを iframe で持って表示を切り替えるだけなので、**全画面のまま**別のデッキに移れる
- <kbd>1</kbd>〜<kbd>9</kbd> でデッキ切り替え。それ以外のキー（`→` や `M` など）は表示中のデッキへそのまま届く
- 切り替えても各デッキの現在位置（登壇順の ● も）は保たれる
- <kbd>Shift</kbd>+<kbd>F</kbd> で全画面、<kbd>P</kbd> で発表者ビュー。発表者ビュー側でデッキを切り替えると投影側も切り替わる
- 左下の薄いバーにデッキ名のタブがある。触ると濃くなる

## PDF にする

`Ctrl` / `Cmd` + `P` → 送信先を「PDFに保存」。`@media print` で
**1スライド = 1ページ（1280×720 の横向き）**に固定してある。
ダイアログ側では用紙を「横向き」、余白を「なし」、「背景のグラフィック」を**オン**にする。

## 画像の置き方

スライドと同じディレクトリの `images/` に置き、`images/<ファイル名>` の**相対パス**で参照する。
相対パスなので、ディレクトリごと移動・コピーしても壊れない。

```html
<!-- 本文の横に置く画像 -->
<img class="slide-img" src="images/photo.jpg" alt="画像の説明">

<!-- 背景に敷く写真（section に has-bg-photo を付ける） -->
<section class="slide cover has-bg-photo" data-slide="1">
  <div class="bg-photo" style="background-image: url('images/photo.jpg');"></div>
  ...
</section>
```

- `.slide-img` は 3:2 で切り取られる（`object-fit: cover`）。縦横比の違う写真を混ぜても揃う
- 画像がまだ無い箇所は `<div class="img-placeholder">IMAGE</div>` で埋めておける
- 背景写真の上は白いベールと文字のハロで読めるようにしてある。
  濃さを変えたいときは `.bg-photo` の `opacity` と `.bg-photo::after` の `background` を調整する
- 元画像は 1〜2MB 程度まで。それ以上は投影でもPDFでも見た目が変わらないので縮めてから入れる
