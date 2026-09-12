# slides

発表スライド置き場。**HTML / CSS / JS の1ファイル完結**で、ビルドもフレームワークも使わない。
ブラウザで `slide.html` を開けばそのまま再生でき、印刷ダイアログから PDF にできる。

## 構成

```
.
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
丸ごと縮小される（倍率は JS が `--s` に入れる）。文字サイズは `min(N cqi, 最大px)` で
スライド幅 1280 に対する比率で決まるので、スマホで見ても PC と同じ見た目が縮小されるだけ。
ピクセル決め打ちで書き足しても壊れないが、スライドの外にはみ出す指定はしないこと。

配色を変えたいときは、先頭の `:root` にある `--accent` / `--accent-dark` / `--accent-soft`
の3つを差し替える。それ以外の CSS は触らなくてよい。

## キーボード操作

| キー | 動作 |
|---|---|
| `→` / `Space` / `PageDown` | 次のスライド |
| `←` / `PageUp` | 前のスライド |
| `F` | プレゼンモード（1枚ずつ全画面）の切り替え |
| `Esc` | プレゼンモードを抜ける |
| `Ctrl` / `Cmd` + `P` | PDF出力（印刷ダイアログ） |

画面下のツールバーからも同じ操作ができる。ツールバーは印刷時には出ない。

表示モードは2つある。

- **スクロールモード**（初期状態）: 全スライドが縦に並ぶ。推敲・見直し向け
- **プレゼンモード**（`F`）: 1枚ずつ全画面。本番向け。ブラウザ自体も全画面（`F11`）にして使う

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
