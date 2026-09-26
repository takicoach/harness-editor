# 同梱フォントのライセンスと生成条件

同梱する書体と、原本・版・ハッシュ・サブセット範囲は `public/fonts/fonts.manifest.json` が正本。
8 書体すべて SIL Open Font License 1.1（OFL）。

Noto Sans JP / Noto Serif JP は google/fonts 上では wght 可変フォント（100-900）。
`fonttools varLib.instancer` で weight 400 / 700 の静的インスタンスを作ってからサブセットした
（可変軸データを含まないぶん、旧ラウンドの全域可変フォントより 1 ファイルは小さい）。
Zen Kaku Gothic New / BIZ UDPGothic / M PLUS Rounded 1c は google/fonts に元々 400/700 の
静的 ttf が別ファイルであるため、そのままサブセットした。
Dela Gothic One / Mochiy Pop One / Yusei Magic は単一ウェイト（400 扱い、デザイン上は太め）
のため 1 本のみ。

全書体、リポジトリ内に OFL 全文（Copyright 行・Reserved Font Name 宣言を含む）を複製済み
（`public/fonts/licenses/<id>-OFL.txt`）。配布する woff2 自体の `name` テーブルにも
nameID 0（Copyright）/7（Trademark）/13（License Description）/14（License URL）を保持している
（サブセット時に `pyftsubset --name-IDs=0,1,2,3,4,6,7,13,14` を指定）。

| id | family | 取得元 | ライセンス全文（複製） | 400 | 700 |
|---|---|---|---|---|---|
| noto-sans-jp | Noto Sans JP | google/fonts `ofl/notosansjp/NotoSansJP[wght].ttf`（instancer で 400/700 静的化） | `licenses/noto-sans-jp-OFL.txt` | 2024 KB | 2069 KB |
| zen-kaku-gothic-new | Zen Kaku Gothic New | google/fonts `ofl/zenkakugothicnew/ZenKakuGothicNew-{Regular,Bold}.ttf` | `licenses/zen-kaku-gothic-new-OFL.txt` | 977 KB | 1007 KB |
| biz-udpgothic | BIZ UDPGothic | google/fonts `ofl/bizudpgothic/BIZUDPGothic-{Regular,Bold}.ttf` | `licenses/biz-udpgothic-OFL.txt` | 1546 KB | 1581 KB |
| m-plus-rounded-1c | M PLUS Rounded 1c | google/fonts `ofl/mplusrounded1c/MPLUSRounded1c-{Regular,Bold}.ttf` | `licenses/m-plus-rounded-1c-OFL.txt`（下記注） | 874 KB | 961 KB |
| noto-serif-jp | Noto Serif JP | google/fonts `ofl/notoserifjp/NotoSerifJP[wght].ttf`（instancer で 400/700 静的化） | `licenses/noto-serif-jp-OFL.txt` | 2717 KB | 2793 KB |
| dela-gothic-one | Dela Gothic One | google/fonts `ofl/delagothicone/DelaGothicOne-Regular.ttf` | `licenses/dela-gothic-one-OFL.txt` | 1081 KB | — |
| mochiy-pop-one | Mochiy Pop One | google/fonts `ofl/mochiypopone/MochiyPopOne-Regular.ttf` | `licenses/mochiy-pop-one-OFL.txt` | 1905 KB | — |
| yusei-magic | Yusei Magic | google/fonts `ofl/yuseimagic/YuseiMagic-Regular.ttf` | `licenses/yusei-magic-OFL.txt` | 898 KB | — |

同梱合計: 約 19.96 MB（13 ファイル・8 書体）。旧ラウンド（8 書体・8 ファイル・17.18 MB、
うち Noto 2 書体が全域可変フォント）と単純比較すると総量は増えているが、これはファイル本数が
増えた（Noto 2 書体が 1→2 ファイルに分割）ためで、Noto Sans JP 単体では 3851 KB（全域可変）
→ 2024+2069 KB（400/700 静的の合計だが、各ファイル単体は 2MB 前後に縮小）というように
1 ファイルあたりのサイズは狙いどおり小さくなっている。容量目標は事前に決めず、この実測値を採用する。

## 注: m-plus-rounded-1c のライセンスファイル
`ofl/mplusrounded1c/` には `OFL.txt` が存在しない（google/fonts リポジトリ側の欠落）。
`ofl/mplus1p/OFL.txt` は本文中に "Copyright 2016 The Rounded M+ Project Authors." の
著作権表記を含み、M+ 1p と M+ Rounded 1c 双方の著作権者を記載した共有ライセンスファイルに
なっている（diff で確認済み）。そのため licenseUrl はこのファイルを指す。

## name テーブルの実測（修正ラウンド2・Critical 対応）
`noto-sans-jp-400.woff2` を fontTools で開いて確認:
nameID 0 = `"(c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'."`、
13 = `"This Font Software is licensed under the SIL Open Font License, Version 1.1. ..."`、
14 = `"http://scripts.sil.org/OFL"`。いずれも保持されている。
`--update-name-table` を付けた instancer の実測（Regular/Bold に正しく解決）:
noto-sans-jp-400 は nameID1/2/4/6 = `Noto Sans JP`/`Regular`/`Noto Sans JP Regular`/`NotoSansJP-Regular`、
noto-sans-jp-700 は `Noto Sans JP`/`Bold`/`Noto Sans JP Bold`/`NotoSansJP-Bold`
（修正前は可変フォントの既定インスタンス名 `Thin` のまま残っていた）。
noto-serif-jp も同様に 400=Regular／700=Bold に解決済み。

## document.fonts の証拠
Playwright + プロジェクト固有 Chromium で `index.html` / `native-render.html` を起動し
`document.fonts.load()` → `document.fonts.check()` を実行。8 書体×400/700 すべて
`status: 'loaded'`、`/fonts/*.woff2` への失敗リクエストなし（両ページで同一結果、
修正ラウンド2でのビルド後に再検証済み）。

## Minor（記録のみ）
- 同梱 13 ファイル合計 約 20 MB はリポジトリサイズとして軽くない。将来的には配信時の
  動的サブセット化や CDN 分離も検討余地があるが、本タスク（T1）の範囲では静的同梱のまま
  据え置く。
- `FontDef`（`src/core/fonts.ts`）に weight の概念が無い。`file` は 400 ファイルのみを指し、
  700 は CSS 側の `@font-face` にのみ存在する。太字表示は既存の `TextAppearance` 側の
  bold フラグが `font-weight: 700` を指定し、ブラウザが同一 family 内で該当ウェイトの
  `@font-face` を自動選択する前提（`fontStack()` は family 名の組み立てのみ）。T16 で
  太字トグルと font-weight の対応を明示的に検証すること。
