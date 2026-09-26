/**
 * 「カットしただけ」の編集かを判定する（クライアント/サーバ共用）。
 *
 * テロップもエフェクトも無いなら、Remotion で 1 フレームずつ描き直す必要はなく、
 * ffmpeg で原本を切って繋ぐだけで済む（4K・9分の中間素材で 10 時間超 → 9 分の実測差）。
 * 何か 1 つでも載っていれば通常の書き出しへ戻す。
 *
 * サーバ側が最終判断を持ち、クライアントは同じ判定で「高速で書き出します」の案内を出す。
 */

/** レイアウトのうち「描き直しが要るか」を左右する部分だけ。 */
export interface MainLayoutLike {
  position?: { x: number; y: number };
  scale?: number;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
}

/**
 * メイン動画のレイアウトが「素のまま」か（PiP 風の移動・拡縮・回転・反転が無い）。
 * mainLayout は未指定でも既定値が入るため、有無ではなく中身で判定する。
 * 素のままなら背景色は画面に出ないので見ない。
 */
export function isIdentityLayout(layout: MainLayoutLike | undefined | null): boolean {
  if (layout === undefined || layout === null) return true;
  return (
    (layout.position?.x ?? 0) === 0 &&
    (layout.position?.y ?? 0) === 0 &&
    (layout.scale ?? 1) === 1 &&
    (layout.rotation ?? 0) === 0 &&
    (layout.flipH ?? false) === false &&
    (layout.flipV ?? false) === false
  );
}

/** 判定に必要な最小の形（EditState と EditorProject の共通部分）。 */
export interface CutsOnlyInput {
  telops: readonly unknown[];
  se: readonly unknown[];
  images: readonly unknown[];
  videoInserts?: readonly unknown[];
  bgm?: readonly unknown[];
  /**
   * native が ducking を処理できない状況か（true なら理由を立てる）。
   * M1c 以降: リクエストに ducking 設定が同梱されていれば native 側で処理できるため
   * 呼び出し側は false を渡す。未供給（旧クライアント等）のときだけ、bgmData.ts に
   * 焼き込まれた ducking の有無（parseBgmData は ducking を読み戻さないため、呼び出し側が
   * 生の bgmDataSource 文字列から検知）を渡す（従来ゲート）。必須化により
   * 「未供給で安全側に倒れない」事故を型で強制する。
   */
  bgmDucking: boolean;
  titles: readonly unknown[];
  shapes?: readonly unknown[];
  sceneTransitions?: readonly unknown[];
  mainSpeed: number;
  segmentSpeeds: Record<number, number>;
  mainLayout?: MainLayoutLike;
  segmentLayouts?: Record<number, unknown>;
  layoutKeyframes?: readonly unknown[];
  colorGrade?: ColorGradeLike;
}

/** カラー補正のうち「描き直しが要るか」を左右する部分だけ（core を import しない）。 */
export interface ColorGradeLike {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  wheels?: Partial<Record<'lift' | 'gamma' | 'gain', { x?: number; y?: number; level?: number }>>;
}

/**
 * カラー補正が無補正か。
 * core/colorGrade.ts の isIdentityColorGrade と同義（こちらはクライアント/サーバ共用の最小形）。
 */
export function isIdentityColorGrade(g: ColorGradeLike | undefined | null): boolean {
  if (g === undefined || g === null) return true;
  return (
    (g.brightness ?? 0) === 0 &&
    (g.contrast ?? 0) === 0 &&
    (g.saturation ?? 0) === 0 &&
    (g.temperature ?? 0) === 0 &&
    Object.values(g.wheels ?? {}).every(w =>
      (w.x ?? 0) === 0 && (w.y ?? 0) === 0 && (w.level ?? 0) === 0)
  );
}

/** nativeExport（ffmpeg 自前経路）がまだ扱えない要素。空配列なら nativeExport で書き出せる。 */
export type NativeUnsupportedReason =
  | 'ducking'
  | 'layoutKeyframes' | 'speed' | 'segmentSpeeds' | 'layout' | 'color';

/**
 * nativeExport が扱えない理由を列挙する（段階出荷の正本判定）。
 * 対応機能が増えるたびに、ここから該当理由を外していく。
 */
export function nativeUnsupportedReasons(p: CutsOnlyInput): NativeUnsupportedReason[] {
  const reasons: NativeUnsupportedReason[] = [];
  const has = (a: readonly unknown[] | undefined): boolean => (a ?? []).length > 0;
  // telops / images（挿入画像）は nativeExport 対応済み（M2c・撮影オーバーレイ）。理由を立てない。
  // native が ducking を処理できない状況（= リクエストに ducking 設定が来ておらず、かつ
  // bgmData.ts に焼き込み済み ducking がある）は Remotion 経路へ退避する。設定が来ていれば
  // native 側で処理できるので呼び出し側が bgmDucking=false を渡し、この理由は立たない。
  // bgmDucking は必須フィールド（型で強制）のため、未供給のまま安全側に倒れない事故は起きない。
  if ((p.bgm ?? []).length > 0 && p.bgmDucking === true) reasons.push('ducking');
  // titles（タイトル帯）は nativeExport 対応済み（M2c）。理由を立てない。
  // shapes（図形オーバーレイ）は nativeExport 対応済み（M1d）。理由を立てない。
  // videoInserts（サブ動画インサート）は nativeExport 対応済み（M4・T1〜T5 の実測で方式確定）。
  // 追加の動画入力を canon 写像（時刻 → 最近傍の実在フレーム・タイは後ろ）で CFR 化し、
  // contain/位置/拡大 → 出入りアニメの段分割 → overlay（サブ動画レイヤだけ format=rgb）で合成する。
  // 受入 A のコーパス（src/server/videoInsertCorpus.e2e.test.ts）が Remotion 基準線と突き合わせる。
  // 素材が無い・速度が不正・段数が上限超などは planFastCut 側で Remotion 経路へ退避する。
  // sceneTransitions（場面転換 6 種）は nativeExport 対応済み（M3・T1〜T5 の実測で方式確定）。
  // 重なり系は xfade 群 + concat、fade 系は色レイヤの geq alpha、音声は窓内で amix 合算。
  // 受入 A のコーパス（src/server/transitionCorpus.e2e.test.ts）が Remotion 基準線と突き合わせる。
  if (has(p.layoutKeyframes)) reasons.push('layoutKeyframes');
  if (p.mainSpeed !== 1) reasons.push('speed');
  if (Object.keys(p.segmentSpeeds).length > 0) reasons.push('segmentSpeeds');
  // メイン動画のレイアウト（PiP 風の位置・大きさ・回転）が付いていたら描画が要る。
  if (Object.keys(p.segmentLayouts ?? {}).length > 0 || !isIdentityLayout(p.mainLayout)) {
    reasons.push('layout');
  }
  // カラー補正（F-2）。高速経路はメイン動画を**再エンコードせず**原本を切って繋ぐので、
  // 色を掛ける場所が無い。ffmpeg の eq/colorbalance で近似すると
  // 「プレビュー（Chromium の feColorMatrix）と書き出し（ffmpeg）で別の絵」になるため、
  // 近似せず Remotion 経路へ退避する（＝プレビューと書き出しが構造的に一致する）。
  if (!isIdentityColorGrade(p.colorGrade)) reasons.push('color');
  return reasons;
}

/** カット以外の要素が一つも無ければ true（nativeUnsupportedReasons への委譲・挙動不変）。 */
export function isCutsOnly(p: CutsOnlyInput): boolean {
  return nativeUnsupportedReasons(p).length === 0;
}
