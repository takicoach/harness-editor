// ==== ズーム/クロップ演出データ ====
// 区間クロップ（トーク場面の上半身寄り等）とズームイン演出（特定座標へ寄って戻る）を
// 同一の機構で表現する。人間・AI がこのファイルを直接書き起こす前提のためエディタ UI は無い。
//
// フレームは「原本（カット前）フレーム」。このテンプレートに CutPlayer（カット非破壊再生）は
// 無く MainVideo は常に原本動画をそのまま再生するため、原本フレーム＝再生フレームで 1:1。
// カット機能を持つ構成へ拡張する場合も、cutData.ts の CutSegment（originalStart/originalEnd）と
// 同じ命名規約に揃えてあるので anchor/project 変換を後付けしやすい。
//
// 制約・併用時の注意（レビュー 2026-08-04 反映）:
// - transitionInFrames + transitionOutFrames は区間長（originalEnd - originalStart）以下に
//   収めること。超えるとピークが scale に届かないまま折り返す（min() 封筒の仕様）。
// - 区間が重なった場合は配列で先に書いた方だけが有効（先勝ち）。
// - テロップ（TelopPlayer）とタイトル（TitleSequence）はフレーム固定 UI として ZoomFrame の
//   外に置いてあるためズーム対象外（挿入画像 ImageSequence は内側＝ズーム対象）。テロップ行を
//   アンカーに注入する installVideoInsert / installShape の要素も外側に入る。
// - シーン転換（installTransition の SceneOverlaySequence）は ZoomFrame の外側に挿入される
//   ため zoomData の対象外。転換の瞬間とズーム区間は重ねない。
// - MainLayout（キーフレームのパン/ズーム）と併用すると変形が乗算される（二重ズーム）。
//   同一区間での併用は避ける。
// - scale は 0.1〜8、origin.x/y は 0〜100 に ZoomFrame 側でクランプされる。origin ごと省略した
//   場合・数値以外を書いた場合は画面中央 { x: 50, y: 50 } にフォールバックする（落ちない）。
// - カット/速度/シーン転換を導入した後（エディタの各 CTA で MainVideo が
//   CutPlayer / CutPlayerWithTransitions / SpeedPlayer ベースへ置換された後）は、ZoomFrame が
//   useCurrentFrame() から受け取る値が「原本フレーム」ではなく「再生（playback）フレーム」
//   （速度導入時はさらに速度で伸縮した合成フレーム）になる。ZoomFrame に original→playback
//   変換は未実装なので、導入後は playback フレームで
//   直接書くか、cutData.ts の対応する CutSegment の playbackStart / originalStart の差分から
//   換算すること（変換の後付けは上の命名規約に沿って行う）。

/** ズームの注視点。画面座標の %（0-100、0=左/上・100=右/下・50,50=中央）。 */
export interface ZoomOrigin {
  x: number;
  y: number;
}

export interface ZoomSegment {
  id: number;
  /** 原本フレーム。区間開始（この値を含む）。 */
  originalStart: number;
  /** 原本フレーム。区間終了（この値を含まない＝半開区間）。 */
  originalEnd: number;
  /** ズーム倍率（1 = 等倍）。 */
  scale: number;
  /**
   * ズームの注視点。区間内は固定（画面上でこの点が動かないよう scale と連動して補正する）。
   * 省略時・数値以外は画面中央 `{ x: 50, y: 50 }` として扱う。
   */
  origin?: ZoomOrigin;
  /** 区間の入りにかけるフレーム数（省略時 0 ＝即時に scale へ達する）。 */
  transitionInFrames?: number;
  /** 区間の出にかけるフレーム数（省略時 0 ＝即時に等倍へ戻る）。 */
  transitionOutFrames?: number;
}

export const zoomData: ZoomSegment[] = [
  // 例(a) 区間クロップ: トーク場面で上半身寄り（固定ズーム・出入りは短いトランジション）
  // { id: 1, originalStart: 300, originalEnd: 600, scale: 1.4, origin: { x: 50, y: 35 }, transitionInFrames: 15, transitionOutFrames: 15 },
  // 例(b) ズームイン演出: 画面中央下部へ滑らかに寄って戻る
  // { id: 2, originalStart: 900, originalEnd: 960, scale: 1.6, origin: { x: 50, y: 70 }, transitionInFrames: 20, transitionOutFrames: 20 },
];
