import { sec } from './ffmpegTime';
import { sceneFadeLayer, sceneFadeWindow, type SceneFadeSpec } from './transitionFilter';

/**
 * PNG 1枚ぶんの図形オーバーレイ区間（inputIndexBase + 配列順が PNG 入力の並びと同順）。
 * durationFrames = endFrame - startFrame（呼び出し側が渡す。ここでは検算しない）。
 */
export interface ShapeOverlay {
  startFrame: number;
  endFrame: number;
  durationFrames: number;
}

/**
 * ShapeOverlay の不変条件を検算する（呼び出し側の算出ミスを黙って通さない）。
 * M-5: 現行唯一の呼び出し元（fastCutPlan.ts）は `durationFrames: shape.endFrame - shape.startFrame`
 * とその場で計算して渡すため、このガードは実運用では到達しない（常に不変条件を満たす）。
 * 将来 applyShapeOverlays を別の呼び出し元から呼ぶとき（durationFrames を別経路で算出する
 * 実装が増えたとき）に、そのミスを検出するための契約ガードとして残している。
 */
function assertShapeOverlayInvariant(o: ShapeOverlay): void {
  if (o.durationFrames !== o.endFrame - o.startFrame) {
    throw new Error(
      `applyShapeOverlays: durationFrames(${o.durationFrames}) が endFrame-startFrame(${o.endFrame - o.startFrame}) と一致しません`,
    );
  }
}

/**
 * フェードのフレーム数（正典 Remotion 実装 `InsertShape.tsx` の FADE_FRAMES と同値）。
 * fadeOpacity = clamp(min(frame/FADE_FRAMES, (D-frame)/FADE_FRAMES), 0, 1)
 */
const FADE_FRAMES = 8;

/** D>=2*FADE_FRAMES は overlap 域が無いので積=min（fade in/out を独立に掛けられる）。 */
function fadeExprFor(durationFrames: number): string {
  if (durationFrames >= 2 * FADE_FRAMES) {
    return `fade=t=in:s=0:n=${FADE_FRAMES}:alpha=1,fade=t=out:s=${durationFrames - FADE_FRAMES}:n=${FADE_FRAMES}:alpha=1`;
  }
  // D が短く fade-in/fade-out の区間が重なる場合、積 (fade=t=in) * (fade=t=out) は
  // 正典 min(N/8,(D-N)/8) と一致しない（重なり域で過剰減衰する）。geq で min を直接評価する。
  // r/g/b はそのまま通し、a のみ入力の alpha に時間ゲインを乗算する。N は入力フレーム番号（クリップ相対）。
  return (
    `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':` +
    `a='alpha(X,Y)*clip(min(N/${FADE_FRAMES},(${durationFrames}-N)/${FADE_FRAMES}),0,1)'`
  );
}

/**
 * enable の時刻式。フレーム k の t は k/fps。境界フレームが toFixed(6) の丸めで
 * 脱落しないよう、比較点をフレーム境界の半フレーム手前・手前にずらす
 * （±1e-6 ≪ 半フレーム=1/(2*fps) なので丸め誤差の影響を受けない）。
 * between は閉区間のため使わず、[start,end) 排他を gte/lt の組で表す。
 */
function enableExprFor(startFrame: number, endFrame: number, fps: number): string {
  return `gte(t,${sec(startFrame - 0.5, fps)})*lt(t,${sec(endFrame - 0.5, fps)})`;
}

/**
 * applyOverlays の layer 型（M2c 設計判断3・T4）。
 *
 * - `static`: 従来の図形（InsertShape）PNG型。fade（または D<16 の geq）でフェードを
 *   合成側が付ける。`durationFrames` は `endFrame-startFrame` と一致すること
 *   （applyShapeOverlays と同じ契約・assertShapeOverlayInvariant で検算）。
 * - `sequence`: captureSequenceInput.buildCaptureSequenceInput が作った密連番 image2 入力。
 *   フェードは撮影済み画素に焼き込まれている（撮影スパン限定・M2c 設計判断2）ため、
 *   ここでは fade/geq を適用しない。`setpts` によるスパン開始位置へのシフトと、
 *   `enableExprFor` によるスパン窓（[startFrame,endFrame)）だけを適用する。
 *   連番自体は 0 起点で作られている（captureSequenceInput の契約）ため、setpts の
 *   シフト量は `startFrame`（= スパンの絶対開始フレーム番号）そのものでよい
 *   （秒ではなくフレーム番号で与える理由は下の「PTS グリッドを揃える」節）。
 */
export interface StaticOverlayLayer {
  kind: 'static';
  startFrame: number;
  endFrame: number;
  durationFrames: number;
}

export interface SequenceOverlayLayer {
  kind: 'sequence';
  /** スパンの開始/終了フレーム（撮影スパン＝ enable 窓・setpts シフト量の元）。 */
  startFrame: number;
  endFrame: number;
  /**
   * 連番 PNG を合成前に拡縮する寸法（M2c T5・省略時は無変換＝従来出力と1文字も変わらない）。
   * テロップ/タイトルの px 指標は**合成解像度（原本解像度）基準**なので撮影は原寸で行い、
   * 出力が縮小される場合だけここで出力解像度へ合わせる（Remotion の「原寸で合成 → 縮小」と同順）。
   */
  scaleTo?: { width: number; height: number };
}

/**
 * サブ動画インサート（videoInserts）レイヤ（M4 T2）。
 *
 * 正典は T1 実測で確定した M4 の規則（一覧と式の固定は nativeExportVideo.test.ts）。
 * 追加の動画入力（`-i <sub>`）を1本消費し、入力 index は他種と同じ `inputIndexBase + 配列順`。
 */
export interface VideoOverlayLayer {
  kind: 'video';
  /** 窓（最終座標）。正典④ `[startFrame,endFrame)` 排他。 */
  startFrame: number;
  endFrame: number;
  /**
   * 正典①: ソース時刻の起点。単位は**合成フレーム**（サブ動画自身の fps ではない）。
   * `t = (sourceInFrame + playbackRate × k) / 合成fps`（k = 窓内の相対フレーム）。
   */
  sourceInFrame: number;
  /** 正典①: 再生速度（既定 1 は**呼び出し側**が解決して実値で渡す）。 */
  playbackRate: number;
  /** 正典⑤: contain → scale → translate を解いた実値（videoInsertPlacement で算出）。 */
  placement: VideoInsertPlacement;
  /**
   * 正典⑥ 出入りアニメ（M4 T4）。**アニメが恒等なら `undefined`**（＝従来の1レイヤ経路・
   * filter 文字列は 1 文字も変わらない＝受入 E）。
   *
   * 値があるときは `videoInsertAnim.videoInsertAnimSteps` が解いた「静的な配置＋定数 alpha が
   * 続く区間」の列で、窓内相対フレーム `[kStart,kEnd)` は昇順・重なりなし。合成は
   * canon 写像（正典①②③）の 1 本を `split` して区間ごとに別レイヤとして積む——
   * ffmpeg の時変式を使わないので、丸め・`crop`・overlay 座標はすべて T1〜T3 で
   * Remotion 基準線と突合済みの静的経路と同一のものが通る。
   *
   * `placement`（アニメ抜きの静的配置）はこのとき描画には使われない。**平坦部の step が
   * それと一致する**ことは `videoInsertAnimSteps` 側の性質で、ここでは検算しない。
   */
  animSteps?: readonly VideoInsertAnimStepLike[];
  /**
   * 素材ストリームの time_base の分母（`1/den`）。**plan 段で ffprobe して実値を渡す**（I-1）。
   *
   * canon 写像は「スロット中心」を **タイムベース単位**で書く（`round((slot+0.5)/fps/TB)`）ので、
   * 1 スロットあたりの単位数 `den/fps` が 2 を切ると中心と境界が同じ整数へ潰れ、
   * **frame 0 以外の全フレームが 1 スロット後ろへずれる**（実測: `1/30` の素材 × 合成 30fps で
   * 64 フレーム中 62 フレームが 1 つ後ろ）。`canonTimeBaseMultiplier` が足りない分だけ
   * **素材 time_base の整数倍**へ引き上げる（整数倍なので再スケールが厳密＝同値タイの規則を乱さない）。
   *
   * 省略時は引き上げをしない（＝従来の文字列。`den >= 8×fps` の素材では倍率 1 なので同じ）。
   */
  timeBaseDen?: number;
}

/**
 * canon 鎖の先頭で立てる time_base の**整数倍率**（I-1）。
 *
 * 1 スロットあたり最低 8 タイムベース単位（中心置きの許容 ±4 単位）を確保する最小の整数。
 * `den >= 8×fps` の素材では 1 ＝ `settb` を挟まない＝**filter 文字列は 1 文字も変わらない**（受入 E）。
 *
 * **1/90000 のような固定値にしない**のが肝: 固定値だと素材によって再スケールに丸めが入り、
 * ちょうど同値タイの位置を数マイクロ秒ずらして正典②のタイ規則（タイ→後ろ）を壊しうる。
 * 整数倍なら `pts_new = pts_old × M` が厳密で、時刻の大小関係もタイも 1 つも動かない。
 */
export function canonTimeBaseMultiplier(timeBaseDen: number, fps: number): number {
  if (!Number.isInteger(timeBaseDen) || timeBaseDen <= 0) {
    throw new Error(`canonTimeBaseMultiplier: time_base の分母が不正です（${String(timeBaseDen)}）`);
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`canonTimeBaseMultiplier: fps が不正です（${String(fps)}）`);
  }
  return Math.max(1, Math.ceil((8 * fps) / timeBaseDen));
}

/** canon 鎖が実際に使う time_base の分母（`timeBaseDen × 倍率`）。 */
export function canonTimeBaseDen(timeBaseDen: number, fps: number): number {
  return timeBaseDen * canonTimeBaseMultiplier(timeBaseDen, fps);
}

/**
 * `videoInsertAnim.VideoInsertAnimStep` の構造だけを見る型（実体の import は循環になるため
 * ここでは形で受ける。`videoInsertAnim.ts` が幾何を解く側・こちらが文字列にする側）。
 */
export interface VideoInsertAnimStepLike {
  kStart: number;
  kEnd: number;
  opacity: number;
  placement: VideoInsertPlacement;
}

export type OverlayLayer = StaticOverlayLayer | SequenceOverlayLayer | VideoOverlayLayer;

/** サブ動画の配置（合成解像度の絶対画素）。x/y は負にもなる（画面外へはみ出す配置）。 */
export interface VideoInsertPlacement {
  width: number;
  height: number;
  x: number;
  y: number;
  /**
   * 可視領域の切り出し（I-1・**幾何は1画素も変えない純粋な省コスト**）。
   *
   * 配置矩形（`width`×`height` @ `x,y`）のうち合成の中に入る部分だけを `crop` で残す。
   * `scale > 1` の配置は合成解像度を超える中間フレームを作る（4K × scale=5 なら
   * 19200×10800 の RGBA）が、overlay ははみ出した分を捨てるだけなので**捨てる画素を
   * 作らない**方が速い。描画位置は `(x + crop.x, y + crop.y)`。
   *
   * **厳密に小さくできるときだけ**持つ: 全面可視なら `undefined`（従来の filter 文字列と
   * 1 文字も変わらない）、完全に画面外なら空矩形になるのでこれも `undefined`。
   */
  crop?: { x: number; y: number; width: number; height: number };
}

/**
 * 配置矩形のうち合成（`size`）の中に入る部分（I-1）。
 *
 * 返すのは**レイヤ矩形ローカルの座標**。厳密な縮小にならない（全面可視）場合と、
 * 交差が空（完全に画面外）の場合は `undefined`。
 */
function visibleCropOf(
  rect: { width: number; height: number; x: number; y: number },
  size: { width: number; height: number },
): VideoInsertPlacement['crop'] {
  const cropX = Math.max(0, -rect.x);
  const cropY = Math.max(0, -rect.y);
  const cropW = Math.min(rect.width, size.width - rect.x) - cropX;
  const cropH = Math.min(rect.height, size.height - rect.y) - cropY;
  if (cropW <= 0 || cropH <= 0) return undefined; // 完全に画面外（crop で degenerate を作らない）
  if (cropX === 0 && cropY === 0 && cropW === rect.width && cropH === rect.height) return undefined;
  return { x: cropX, y: cropY, width: cropW, height: cropH };
}

/**
 * 正典⑤ の幾何を解く（T1(c) 実測・Remotion 基準線と画素差ゼロだった予測式）。
 *
 * 正典（`InsertVideo.tsx`）は 内側 `objectFit: contain`（全画面枠に内接）→ 外側 AbsoluteFill に
 * `translate(pos.x×50%, pos.y×50%) scale(scale)`・`transformOrigin: 50% 50%`。
 * **CSS の transform は右から適用されるので scale が先・translate が後**。translate の % は
 * 要素自身（＝全画面）の寸法比なので、画素量は `pos.x × 幅/2` / `pos.y × 高さ/2`。
 *
 * ここが返すのは「全画面枠を scale して中心基準で置いた矩形」で、その中への contain は
 * ffmpeg 側（`scale=…:force_original_aspect_ratio=decrease` + 透明 `pad`）が行う——
 * 素材の実寸を知らなくても幾何が決まるので、plan 段で probe を増やさずに済む。
 */
export function videoInsertPlacement(
  size: { width: number; height: number },
  position: { x: number; y: number } | undefined,
  scale: number | undefined,
): VideoInsertPlacement {
  return videoInsertPlacementAt(size, position, scale, IDENTITY_ANIM_SAMPLE);
}

/**
 * 出入りアニメ（正典⑥）の1フレームぶんの見た目（`videoInsertAnimSampleAt` が返す実値）。
 * `transform` の文字列ではなく数値で持つ（native は式ではなく座標へ落とすため）。
 */
export interface VideoInsertAnimSample {
  /** 不透明度 0..1（正典の `opacity`）。 */
  opacity: number;
  /** 外側ラッパーの `scale(...)`（アニメ無し＝1）。 */
  scale: number;
  /** 外側ラッパーの `translate(x%, …)`（**要素＝全画面**の幅比・アニメ無し＝0）。 */
  translateXPercent: number;
  translateYPercent: number;
}

export const IDENTITY_ANIM_SAMPLE: VideoInsertAnimSample = {
  opacity: 1,
  scale: 1,
  translateXPercent: 0,
  translateYPercent: 0,
};

/**
 * 正典⑤＋⑥ の幾何を解く（M4 T4）。
 *
 * 正典（`InsertVideo.tsx`）は**入れ子の2枚**で、外側がアニメ・内側が position/scale:
 * ```
 * 外側 AbsoluteFill: opacity=A, transform=anim（scale(s_a) か translate(tx%,ty%)）, origin 50% 50%
 *   内側 AbsoluteFill: transform=translate(pos×50%) scale(scale), origin 50% 50%
 *     video: objectFit contain
 * ```
 * 全画面枠の点 p は 内側で `c + scale×(p−c) + t_pos`、外側で `c + s_a×(p'−c) + t_anim` へ写る
 * （c = 画面中心）。合成すると
 * ```
 * p'' = c + (s_a × scale)×(p − c) + s_a×t_pos + t_anim
 * ```
 * ——**2枚の変換は1つの矩形へ畳める**（アニメの scale は position の画素量も一緒に拡大し、
 * アニメの translate は拡大されない）。`s_a=1, t_anim=0` を入れると従来の静的式に一致するので、
 * アニメ無しの経路は 1 画素も 1 文字も変わらない。
 *
 * **時変にはしない**（設計判断・M4 T4）: 1 フレームごとに静的な矩形を解き、レイヤを
 * フレーム単位へ分割する（`videoInsertAnim.videoInsertAnimSteps`）。ffmpeg の時変式
 * （`scale=eval=frame` / `zoompan` / `sendcmd`）を使わないので、**丸めも crop も
 * 実測済みの静的経路とまったく同じ**——pop の 1.12 倍オーバーシュートも、そのフレームの
 * 矩形から `crop` が解かれるため「静的な配置の crop で動的にはみ出した分を切る」事故が
 * 構造的に起きない。
 */
export function videoInsertPlacementAt(
  size: { width: number; height: number },
  position: { x: number; y: number } | undefined,
  scale: number | undefined,
  anim: VideoInsertAnimSample,
): VideoInsertPlacement {
  const s = scale ?? 1;
  if (!Number.isFinite(s) || s <= 0) {
    throw new Error(`videoInsertPlacement: scale が不正です（${String(scale)}）`);
  }
  const px = position?.x ?? 0;
  const py = position?.y ?? 0;
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    throw new Error(`videoInsertPlacement: position が不正です（${JSON.stringify(position)}）`);
  }
  if (!Number.isFinite(anim.scale) || anim.scale < 0) {
    throw new Error(`videoInsertPlacement: アニメの scale が不正です（${String(anim.scale)}）`);
  }
  const width = Math.round(size.width * s * anim.scale);
  const height = Math.round(size.height * s * anim.scale);
  const rect = {
    width,
    height,
    // scale が先（中心基準）→ translate が後。外側アニメの scale は内側 translate も拡大する。
    x: Math.round(
      (size.width - width) / 2 +
        (anim.scale * (px * size.width)) / 2 +
        (anim.translateXPercent / 100) * size.width,
    ),
    y: Math.round(
      (size.height - height) / 2 +
        (anim.scale * (py * size.height)) / 2 +
        (anim.translateYPercent / 100) * size.height,
    ),
  };
  const crop = visibleCropOf(rect, size);
  return crop === undefined ? rect : { ...rect, crop };
}

/**
 * 正典①②③ を ffmpeg のフィルタ列で作る（**T2 実測1 で確定した canon 写像・変更禁止**）。
 *
 * ```
 * tpad=stop=-1:stop_mode=clone,
 * setpts='if(eq(N,0),0, round((max(0, ceil((((T+PREV_INT)/2 - S/fps)/rate)*fps - 1e-6)) + 0.5)/fps/TB))',
 * fps=<合成fps>:round=down:eof_action=pass
 * ```
 *
 * 各項が実測で必要と分かっているので**整理・簡略化しないこと**:
 * - `fps` フィルタの意味論は「各入力フレームを丸めでスロットへ割り当て、次の割り当てまで保持・
 *   同一スロットは最後が勝つ」。**丸め規則（near/up/down/zero/inf）はどれも正典②（最近傍・
 *   タイは後ろ）を再現しない**（T2 実測1: 9ケース中いずれも赤）。そこで丸めではなく
 *   **スロット割当そのもの**を「自分が最近傍になる最初のスロット＝直前フレームとの中点の ceil」に
 *   置き換え、`fps=…:round=down` の保持規則の上で最近傍を作る。同値タイは ceil によって
 *   後ろのフレームがそのスロットを取る＝正典②のタイ規則と一致する。
 * - **`tpad` は `setpts` の前**。`fps` は EOF 直前の最終フレーム（尺 0）を捨てるため、後段に置くと
 *   最終フレーム自体が既に失われている（実測: 255 が出ず 254 が複製された）。前段で無限クローン
 *   すれば捨てられるのはクローンだけになり、**正典③（末尾クランプ）も同時に満たす**。
 * - **`-1e-6` スロットが要る**。倍精度で中点が `20` ではなく `20.000000000000004` になり ceil が
 *   21 へ跳ねる（実測 f5 k=20）。実在の刻みより 4 桁小さく非タイには影響しない。
 * - **PTS は「スロットの境界」ではなく `+0.5` で**スロットの中心**へ置き、`round()` で整数化する
 *   （受入 F の回帰・2026-09-04）**。スロットから PTS へ直す `スロット/fps/TB` は倍精度なので、
 *   境界に置くと丸め誤差がそのまま**スロット 1 つ分のずれ**になる:
 *   - 整数 fps（実測 1/600 × 25fps）では値が整数をわずかに下回り（3384 のはずが
 *     `3383.9999999995`）、ffmpeg の整数化（切り捨て）で **1 タイムベース単位失われ**、
 *     後段 `fps=…:round=down` が `floor(3383/24)=140` と**1 スロット手前**へ割り当てる。
 *   - **非整数 fps では `round()` だけでは足りない**。`videoConfig.ts` の `FPS` は
 *     `59.94` という**10 進リテラル**（`60000/1001` ではない）なので、理想 pts
 *     `スロット × 1000000/999` は 999 スロットに 1 回しか整数にならず、最寄り整数へ丸めても
 *     ±0.5 単位の誤差が残る。その半分で floor が 1 つ下のスロットへ落ちる
 *     （実測 1/60000 × 59.94: 境界置き 120/120 フレームがずれ・中心置き 0/120）。
 *   中心へ置けば誤差の許容が ±半スロットになり、**time_base と fps の組み合わせに依存しない**。
 *   スロットの算出（`ceil(…-1e-6)`）は触っていないので**同値タイの規則は不変**。
 *   回帰は `nativeExportVideoTimebase.e2e.test.ts`（fps 25 / 30 / 59.94 × time_base 4 種）が守る。
 * - 窓より前のフレームは `max(0,…)` で slot 0 へ潰す（同一スロットは最後が勝つので
 *   「k=0 の最近傍」がそのまま残る）。
 * - `eof_action=pass` が要る（既定の round は最後の入力フレームの尺を丸めて 0 なら捨てる）。
 */
export function videoSourceChain(layer: VideoOverlayLayer, fps: number): string {
  const { sourceInFrame: s, playbackRate: rate } = layer;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`applyOverlays: playbackRate が不正です（${String(rate)}）`);
  }
  if (!Number.isFinite(s)) {
    throw new Error(`applyOverlays: sourceInFrame が不正です（${String(s)}）`);
  }
  const windowFrames = layer.endFrame - layer.startFrame;
  if (!Number.isInteger(windowFrames) || windowFrames <= 0) {
    throw new Error(
      `applyOverlays: サブ動画の窓が空です（[${layer.startFrame},${layer.endFrame})）`,
    );
  }
  /**
   * **素材 time_base が粗い側の設計限界（I-1）**。`den/fps` が 1 スロットあたりのタイムベース
   * 単位数で、中心置きの許容はその半分。2 単位を切ると中心が表現できず全フレームがずれるので、
   * **素材 time_base の整数倍**へ引き上げてから canon 写像を掛ける。倍率 1 のときは何も挟まない
   * （既存の出力は 1 文字も変わらない）。
   */
  const settb =
    layer.timeBaseDen === undefined || canonTimeBaseMultiplier(layer.timeBaseDen, fps) === 1
      ? ''
      : `settb=1/${canonTimeBaseDen(layer.timeBaseDen, fps)},`;
  return (
    settb +
    'tpad=stop=-1:stop_mode=clone,' +
    `setpts='if(eq(N,0),0,round((max(0,ceil((((T+PREV_INT)/2-${s}/${fps})/${rate})*${fps}-1e-6))+0.5)/${fps}/TB))',` +
    `fps=${fps}:round=down:eof_action=pass,` +
    /**
     * **窓長で打ち切る（I-1）。**
     *
     * `tpad=stop=-1` は入力を無限にするので、これが無いと鎖は合成の**全尺**を流れ、
     * 窓が 1 フレームでも 300 フレームでもコストが変わらない（＝窓幅ではなく全尺 × 本数に
     * 比例する。実測: 4K・scale=5 で 13.5s / CPU 95s / 最大 RSS 4.1GB）。
     *
     * canon 写像は各ソースフレームを**窓内相対フレーム k のスロット**へ置き、`fps` は
     * スロット 0 から連番で吐くので、`fps` 出力の N 番目 = k。よって
     * `trim=end_frame=<窓長>` がちょうど窓の分だけを通す。`trim` は end に達すると
     * 上流へ EOF を返すため `tpad` のクローン生成もそこで止まる。
     * 後段の `setpts=N+startFrame` は trim 後の連番（0 起点）で PTS を振り直すので、
     * **時間軸（正典①②③）の値は 1 つも変わらない**。
     */
    `trim=end_frame=${windowFrames}`
  );
}

/**
 * 正典⑤ の幾何を ffmpeg のフィルタ列にする（contain → 配置寸法）。
 *
 * contain（全画面枠に内接）と外側 scale は**1回の `scale` にまとめられる**——
 * 「全画面枠へ内接させてから s 倍」＝「(幅×s, 高さ×s) の枠へ内接させる」なので、
 * 再標本化は1回で済む（2段に分けると無駄に画質を落とす）。余白は**透明**の `pad`
 * （既定の黒で塗ると Remotion の contain と違う絵になる）。
 */
function videoGeometryChain(placement: VideoInsertPlacement): string {
  const { width, height } = placement;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`applyOverlays: placement の寸法が不正です（${width}x${height}）`);
  }
  const { crop } = placement;
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    // 中心へ寄せる。`round` は 0.5 画素の位置で正典（ブラウザの描画）と同じ側へ倒すため
    // （T1(c) c5: 予測 437.5 に対し観測 438）。
    `pad=${width}:${height}:round((ow-iw)/2):round((oh-ih)/2):color=0x00000000` +
    /**
     * 可視領域だけを残す（I-1）。overlay は合成の外へ出た画素を捨てるだけなので、
     * **捨てる画素を作らない**方が速い（`scale > 1` で顕著）。crop は表示される画素を
     * 1 つも変えない——描画位置を `x + crop.x` / `y + crop.y` へ寄せるのは overlay 側の責務。
     * 全面可視・完全に画面外のときは `crop` が無く、文字列は従来どおり。
     */
    (crop === undefined ? '' : `,crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`)
  );
}

/** overlay 鎖へ積む1段（M4 T4・1 レイヤが複数段になりうる）。 */
interface OverlayStepPlan {
  /** この段の素材ラベル（`[…]shp…`）。 */
  label: string;
  x: number;
  y: number;
  /** 合成の絶対フレームで `[startFrame,endFrame)`。 */
  startFrame: number;
  endFrame: number;
  /** サブ動画か（`format=rgb` を付けるのはサブ動画だけ）。 */
  video: boolean;
}

/**
 * 出入りアニメ付きサブ動画の layer 行を作る（M4 T4）。
 *
 * ```
 * [i:v]<canon 写像>,format=rgba,settb=1/fps,split=<段数>[vs{i}_0]…;
 * [vs{i}_j]trim=start_frame=<kS>:end_frame=<kE>,setpts=N+<startFrame+kS>,<contain/配置>[,alpha][shp{i}_j];
 * ```
 *
 * - **canon 写像（正典①②③）は 1 本だけ**。`split` で分けるので `-i` の本数も
 *   素材のデコード回数も増えない（入力 index の割当は他種と同じ `inputIndexBase + 配列順`）。
 * - `trim=start_frame/end_frame` は **canon 写像の出力の連番**（= 窓内相対フレーム k）で刻む。
 *   canon 写像は各ソースフレームを k のスロットへ置き `fps` がスロット 0 から連番で吐くので、
 *   `fps` 出力の N 番目がそのまま k（I-1 の `trim=end_frame=<窓長>` と同じ根拠）。
 * - `setpts=N+<絶対フレーム>` は **trim 後の連番（0 起点）**に対して振るので、その段の先頭が
 *   `startFrame + kStart` に載る。
 * - alpha は**幾何の後**に掛ける（正典もラスタライズ後の要素に `opacity` を掛ける）。
 *   不透明（1）の段には付けない＝平坦部の文字列は従来と同じ形のまま。
 */
function pushAnimatedVideoLayer(
  layerLines: string[],
  plannedSteps: OverlayStepPlan[],
  layer: VideoOverlayLayer,
  steps: readonly VideoInsertAnimStepLike[],
  layerIndex: number,
  inputIndex: number,
  fps: number,
  labelPrefix: string,
): void {
  const windowFrames = layer.endFrame - layer.startFrame;
  if (steps.length === 0) {
    throw new Error(`applyOverlays: サブ動画の animSteps が空です（step が 0 段）`);
  }
  let prevEnd = 0;
  for (const s of steps) {
    if (
      !Number.isInteger(s.kStart) ||
      !Number.isInteger(s.kEnd) ||
      s.kStart < prevEnd ||
      s.kEnd <= s.kStart ||
      s.kEnd > windowFrames
    ) {
      throw new Error(
        `applyOverlays: サブ動画の animSteps が窓 [0,${windowFrames}) に収まっていません（step [${s.kStart},${s.kEnd})）`,
      );
    }
    if (!Number.isFinite(s.opacity) || s.opacity <= 0 || s.opacity > 1) {
      throw new Error(`applyOverlays: サブ動画の animSteps の opacity が不正です（${String(s.opacity)}）`);
    }
    prevEnd = s.kEnd;
  }
  const P = labelPrefix;
  const outs = steps.map((_, j) => `[${P}vs${layerIndex}_${j}]`).join('');
  layerLines.push(
    `[${inputIndex}:v]${videoSourceChain(layer, fps)},format=rgba,settb=1/${fps},split=${steps.length}${outs};`,
  );
  steps.forEach((s, j) => {
    // 不透明度は straight alpha の乗算。1 のときは何も足さない（平坦部＝従来の文字列）。
    const alpha = s.opacity >= 1 ? '' : `,colorchannelmixer=aa=${String(Number(s.opacity.toFixed(6)))}`;
    layerLines.push(
      `[${P}vs${layerIndex}_${j}]trim=start_frame=${s.kStart}:end_frame=${s.kEnd},` +
        `setpts=N+${layer.startFrame + s.kStart},${videoGeometryChain(s.placement)}${alpha}[${P}shp${layerIndex}_${j}];`,
    );
    plannedSteps.push({
      label: `${P}shp${layerIndex}_${j}`,
      x: s.placement.x + (s.placement.crop?.x ?? 0),
      y: s.placement.y + (s.placement.crop?.y ?? 0),
      startFrame: layer.startFrame + s.kStart,
      endFrame: layer.startFrame + s.kEnd,
      video: true,
    });
  });
}

/**
 * filter script の**出力ラベル**（各行の末尾に並ぶ `[…]`）を出現順に返す（I-1）。
 *
 * filter graph の 1 行は `[入力]…filter=…[出力][出力2];` の形で、出力ラベルは
 * **行末（`;` を除く）に連なる角括弧**だけ。入力側の `[0:v]` や式の中の文字は拾わない。
 */
export function filterOutputLabels(script: string): string[] {
  const out: string[] = [];
  for (const raw of script.split('\n')) {
    const line = raw.trim().replace(/;$/, '');
    if (line.length === 0) continue;
    const tail = /((?:\[[^[\]]+\])+)$/.exec(line);
    if (tail === null) continue;
    for (const m of tail[1]!.matchAll(/\[([^[\]]+)\]/g)) out.push(m[1]!);
  }
  return out;
}

/**
 * 出力ラベルの一意性を検算する（I-1）。
 *
 * `[outv]` が1個であることの pin（下の各関数）は「どこへ挿すか」の契約で、
 * **中間ラベルの衝突**は捕まえない。overlay 鎖を2回に割る経路（色レイヤを図形鎖と
 * 撮影 PNG 鎖の間へ挟む・設計判断5）では、2回目の既定ラベル（`shbase`/`shp{i}`/`ov{i}`）が
 * 1回目と重複して filter graph が壊れる——そこは接頭辞で分離しているが、
 * **分離が効いていることを毎回機械で確かめる**のがこの assert。
 */
export function assertUniqueFilterOutputLabels(script: string): void {
  const labels = filterOutputLabels(script);
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const l of labels) {
    if (seen.has(l)) dup.add(l);
    seen.add(l);
  }
  if (dup.size > 0) {
    throw new Error(
      `filter の出力ラベルが重複しています（${[...dup].join(', ')}）。overlay 鎖を2回積むときは接頭辞で分離すること`,
    );
  }
}

/**
 * filter_complex スクリプトへ図形（InsertShape）の PNG オーバーレイを足す
 * （nativeExport 映像工程・applyAudioMix とは独立・scale 挿入の後に適用する）。
 *
 * script 中の最後の `[outv]`（concat または scale の出力ラベル）を `[shbase]` に
 * 付け替え、各図形 PNG 入力を `format=rgba` → フェード（fade 対 or geq） →
 * `setpts` でクリップ相対の開始時刻へシフトしたものを順に overlay 合成する。
 * overlay 鎖の最終出力を `[outv]` として再構成するので `-map [outv]` は不変。
 *
 * PNG 入力の index は `inputIndexBase + 配列順`（呼び出し側が音声 extraInputs の
 * 本数を踏まえて算出する。applyAudioMix の `[i+1:a]` 添字には一切触れない）。
 *
 * 既知の乖離（I-5・**許容確定（2026-09-02 コントローラ判断）**・yuv444 化はしない）:
 * overlay は既定 format=yuv420（クロマ半解像度）で合成する。Remotion は RGB 合成後に
 * 1回だけ yuv420 化するため、図形エッジとフェード中の半透明フレームの色は厳密同値では
 * ない（最終出力が yuv420p である以上、差は細い有彩色ストロークのエッジ数レベル/255 に
 * 留まる。単発実測: #FF3B30 で最大6/255）。**M2c T6 の受入再実測（実プロジェクト全画面）:
 * 平均差 0.489/255・96.2% の画素が差3以内・0.31% のみ差>24**——yuv444 は不採用のまま
 * 確定（全フレームのクロマ再標本化コストに見合わない）。
 *
 * 前提（契約）:
 * - `[outv]` ラベルは script 中に必ず1個だけ存在すること（concat または scale の
 *   出力ラベル）。2個以上見つかった場合は「どちらを付け替えるべきか」を沈黙して
 *   誤判定しないよう明示的に throw する（将来 [outv] という文字列が入力パスや
 *   コメントなど別の文脈で紛れ込んだ事故を早期検出するため）
 * - script の末尾（trimEnd 後）に `;` が付いていないこと。付け替え後の文へ
 *   `rewritten.trimEnd() + ';\n'` として無条件に `;` を足すため、既にあると
 *   `;;` の二重終端になる。buildCutFilterScript / applyAudioMix はどちらも
 *   最後の文を `;` 無しで終える流儀（このファイルの出力も同様）なのでこの前提は
 *   既存経路と整合する
 */
/**
 * filter_complex スクリプトへ PNG オーバーレイ（静止型・連番型どちらも）を足す
 * （applyShapeOverlays の一般化・M2c T4）。層の構造・[outv] 付け替え規約・入力 index の
 * 割当（`inputIndexBase + 配列順`）は applyShapeOverlays と完全に同じ。差分は各 layer の
 * フィルタチェーン（static は fade/geq を通す・sequence は素通し）だけ。
 *
 * 前提（契約）は applyShapeOverlays と同一（[outv] は script 中に必ず1個・script 末尾に
 * `;` が付いていないこと）。
 *
 * ## PTS グリッドを揃える（M2c T6 で実測・**frame-exact の必須条件**）
 * `concat` フィルタの出力タイムベースは **1/1000000（マイクロ秒）固定**で、1/30 秒は
 * このタイムベースで表現できない。実測（ffmpeg showinfo）:
 *   フレーム88 pts_time=2.933333 / 89=2.966666 / 90=**2.999999** / 92=3.066666 / 93=3.099999
 * 一方、連番 PNG（image2・`-framerate fps`）はタイムベース 1/fps なので PTS は
 * 3.000000 / 3.033333 / 3.066667 / 3.100000 と**厳密なグリッド上**にある。overlay の
 * framesync は「main の PTS 以下で最新の副入力フレーム」を選ぶため、main が
 * 3.066666、副が 3.066667 のようにマイクロ秒だけ手前へずれたフレームでは**1つ前の
 * オーバーレイ絵が選ばれる**。実測では 3 フレームに 1 回この取り違えが起き、
 * 出力にはオーバーレイの重複フレームとして現れた（fixture 実測: mp4 のフレーム 91 と 92 が
 * 画素同一・撮影 PNG は別物）。秒の小数を桁数で丸めても直らない（量子化は表記より前の層）。
 *
 * 対策は2段:
 *   1. ベース側 `[shraw]settb=1/fps,setpts=N` — concat が作った µs グリッドを捨て、
 *      タイムベース 1/fps・PTS=フレーム番号の厳密なグリッドへ載せ直す。
 *   2. 各オーバーレイ入力 `settb=1/fps,setpts=N+startFrame` — シフトを秒（小数）ではなく
 *      **フレーム番号の整数**で与える。両者が同一タイムベースの整数 PTS になるため、
 *      framesync の比較は整数同士の一致となり丸めの余地が消える。
 * どちらも overlay 鎖に入るときだけ挿入される（オーバーレイ 0 個の「カットしただけ」経路の
 * スクリプトは 1 文字も変わらない＝M1a〜M1c の出力は不変）。
 */
export function applyOverlays(
  script: string,
  layers: readonly OverlayLayer[],
  fps: number,
  inputIndexBase: number,
  /**
   * 中間ラベルの接頭辞（設計判断5）。色レイヤを図形鎖と撮影 PNG 鎖の**間**に挟むには
   * applyOverlays を2回呼ぶ必要があり、既定ラベル（`shbase`/`shp{i}`/`ov{i}`）のままだと
   * filter graph 内でラベルが重複して壊れる。2回目の呼び出しだけ接頭辞を与えて分離する。
   * **既定は空文字**＝1回だけ呼ぶ従来経路の出力は1文字も変わらない。
   */
  labelPrefix = '',
): string {
  if (layers.length === 0) return script;
  layers.forEach((l) => {
    if (l.kind === 'static') assertShapeOverlayInvariant(l);
  });

  const marker = '[outv]';
  const idx = script.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error('applyOverlays: script に [outv] が見つかりません');
  }
  if (script.indexOf(marker) !== idx) {
    throw new Error('applyOverlays: script に [outv] が複数個あります（どれを付け替えるべきか一意に決まりません）');
  }
  const P = labelPrefix;
  const rewritten = script.slice(0, idx) + `[${P}shraw]` + script.slice(idx + marker.length);

  const layerLines: string[] = [];
  /**
   * overlay 鎖へ積む「1 段」の一覧（M4 T4）。
   *
   * T3 までは **1 レイヤ = 1 overlay** だったが、出入りアニメは窓内をフレーム単位の区間へ
   * 割るので **1 レイヤが複数段**になる。`[outv]` を持つのは全レイヤを通した**最後の段**。
   * アニメ無しのレイヤは 1 段しか作らないので、鎖の文字列は従来と一致する（受入 E）。
   */
  const plannedSteps: OverlayStepPlan[] = [];
  // 【フレーム写像の正規化】(M2c T6 実測・下の doc「PTS グリッドを揃える」参照)
  // ベース側を「タイムベース 1/fps・PTS=フレーム番号」へ揃えてから overlay 鎖へ渡す。
  layerLines.push(`[${P}shraw]settb=1/${fps},setpts=N[${P}shbase];`);
  layers.forEach((o, i) => {
    const inputIndex = inputIndexBase + i;
    // オーバーレイ側も同じグリッドへ。シフト量は「秒」ではなく **フレーム番号**
    // （N+startFrame）で書く——秒の小数表記は 1/fps が有限小数でないとき丸めを持ち込む。
    const tail = `settb=1/${fps},setpts=N+${o.startFrame}[${P}shp${i}];`;
    if (o.kind === 'video') {
      if (o.animSteps !== undefined) {
        // 出入りアニメあり（M4 T4）: canon 写像は 1 本のまま split し、区間ごとに静的レイヤを作る。
        pushAnimatedVideoLayer(layerLines, plannedSteps, o, o.animSteps, i, inputIndex, fps, P);
        return;
      }
      // サブ動画（M4 T2）: canon 写像（正典①②③）→ format=rgba → contain/配置（正典⑤）。
      layerLines.push(`[${inputIndex}:v]${videoSourceChain(o, fps)},format=rgba,${videoGeometryChain(o.placement)},${tail}`);
      plannedSteps.push({
        label: `${P}shp${i}`,
        // 可視領域へ crop した場合（I-1）は、切り落とした分だけ描画位置を寄せる。
        x: o.placement.x + (o.placement.crop?.x ?? 0),
        y: o.placement.y + (o.placement.crop?.y ?? 0),
        startFrame: o.startFrame,
        endFrame: o.endFrame,
        video: true,
      });
      return;
    }
    const chain =
      o.kind === 'static'
        ? `,${fadeExprFor(o.durationFrames)}`
        : o.scaleTo !== undefined
        ? `,scale=${o.scaleTo.width}:${o.scaleTo.height}`
        : '';
    layerLines.push(`[${inputIndex}:v]format=rgba${chain},${tail}`);
    // 位置を持つのはサブ動画だけ（画像/図形/撮影 PNG は全画面の合成済み素材なので x=y=0 のまま）。
    plannedSteps.push({ label: `${P}shp${i}`, x: 0, y: 0, startFrame: o.startFrame, endFrame: o.endFrame, video: false });
  });

  const overlayLines: string[] = [];
  let prevLabel = `${P}shbase`;
  plannedSteps.forEach((s, i) => {
    const isLast = i === plannedSteps.length - 1;
    const outLabel = isLast ? 'outv' : `${P}ov${i}`;
    const enable = enableExprFor(s.startFrame, s.endFrame, fps);
    const terminator = isLast ? '' : ';';
    /**
     * サブ動画だけ **RGB で合成する**（M4 T2 実測 2026-09-03）。
     *
     * overlay の既定（yuv420）では**クロマ格子に合わせて位置が偶数へ丸められ**、正典⑤ の
     * 座標が最大 1 画素ずれる。さらに前段の `pad` も yuv420 で折衝されると余白の中心寄せが
     * もう 1 画素ずれる（実測: 期待 y=60 に対し 58）。`format=rgb` を指定すると鎖全体が RGB で
     * 折衝され、実測で **期待どおり y=60・x=80** に載った（rows 60..119 / cols 80..239）。
     * 正典（Remotion）も RGB 合成なので、画素位置・色ともにこちらが近い。
     * x=y=0 固定の他種レイヤは丸めの影響を受けないため**従来どおり既定のまま**（出力1文字不変）。
     *
     * T4 で alpha（`colorchannelmixer`）が入っても、混色そのものが RGB で行われるので
     * 正典（ブラウザの RGB 合成）と同じ計算になる。
     */
    const format = s.video ? ':format=rgb' : '';
    overlayLines.push(
      `[${prevLabel}][${s.label}]overlay=x=${s.x}:y=${s.y}:eof_action=pass${format}:enable='${enable}'[${outLabel}]${terminator}`,
    );
    prevLabel = outLabel;
  });

  const composed = rewritten.trimEnd() + ';\n' + layerLines.join('\n') + '\n' + overlayLines.join('\n') + '\n';
  // I-1: 中間ラベルの衝突（2回目の鎖で接頭辞を付け忘れる）をここで止める。
  assertUniqueFilterOutputLabels(composed);
  return composed;
}

/**
 * 図形（InsertShape）PNG専用の従来 API。applyOverlays への薄いラッパー
 * （既存呼び出し元・既存テストへの後方互換のため維持。挙動・出力文字列は不変）。
 */
export function applyShapeOverlays(
  script: string,
  overlays: readonly ShapeOverlay[],
  fps: number,
  inputIndexBase: number,
): string {
  const layers: OverlayLayer[] = overlays.map((o) => ({ kind: 'static', ...o }));
  return applyOverlays(script, layers, fps, inputIndexBase);
}

/**
 * シーン転換の fade 色レイヤ（fadeBlack/fadeWhite/fadeColor）を合成する（M3 T2）。
 *
 * **合成位置は「図形鎖の後・撮影 PNG（telop+title）鎖の前」**（設計判断5・64f5fd4 で確定）。
 * 正典の重なりは 主映像 → 画像 → 図形 → 色レイヤ（zIndex なし・DOM 最後）→ タイトル(100) →
 * テロップ(200)。T1 修正ラウンド（C-1）の弁別実験で「色レイヤはテロップより**下**」が確定し、
 * T2 初回の「最前面」実装はここで訂正した。呼び出し側は `fastCutPlan.composeOverlayChains` が正
 * （撮影 PNG がある経路では applyOverlays を2回に割り、この関数をその間に挟む）。
 *
 * 各レイヤは入力を消費しない `color` ソースなので `-i` の本数・`applyAudioMix` の `[i+1:a]` 添字・
 * `computeOverlayInputIndexBase` の割当には一切影響しない。
 *
 * 前提（契約）は applyOverlays と同一: script 中に `[outv]` が1個・script 末尾に `;` が無いこと。
 * layers が空なら script を1文字も変えない（転換の無いプロジェクトの出力は不変）。
 */
export function applySceneFadeLayers(
  script: string,
  layers: readonly SceneFadeSpec[],
  fps: number,
  size: { width: number; height: number },
  totalFrames: number,
): string {
  if (layers.length === 0) return script;

  const marker = '[outv]';
  const idx = script.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error('applySceneFadeLayers: script に [outv] が見つかりません');
  }
  if (script.indexOf(marker) !== idx) {
    throw new Error('applySceneFadeLayers: script に [outv] が複数個あります');
  }
  const rewritten = script.slice(0, idx) + '[fdraw]' + script.slice(idx + marker.length);

  const lines: string[] = [];
  // ベース側を applyOverlays と同じ「タイムベース 1/fps・PTS=フレーム番号」のグリッドへ載せ直す
  // （overlay の framesync が µs グリッドの丸めで 1 フレーム取り違えるのを防ぐ・M2c T6 実測）。
  lines.push(`[fdraw]settb=1/${fps},setpts=N[fdbase];`);
  layers.forEach((l, i) => {
    lines.push(sceneFadeLayer(l, i, fps, size, totalFrames));
  });

  const overlayLines: string[] = [];
  let prevLabel = 'fdbase';
  layers.forEach((l, i) => {
    const isLast = i === layers.length - 1;
    const outLabel = isLast ? 'outv' : `fdov${i}`;
    const terminator = isLast ? '' : ';';
    // 色ソースは窓長ぶんしか無い（C-3）ので、applyOverlays の連番レイヤと同じく
    // enable で窓の外を素通しにする（framesync が窓外で直前フレームを引き伸ばさないように）。
    const win = sceneFadeWindow(l.at, l.durationFrames, totalFrames);
    const enable = enableExprFor(win.startFrame, win.startFrame + win.frames, fps);
    overlayLines.push(
      `[${prevLabel}][fd${i}]overlay=x=0:y=0:eof_action=pass:enable='${enable}'[${outLabel}]${terminator}`,
    );
    prevLabel = outLabel;
  });

  const composed = rewritten.trimEnd() + ';\n' + lines.join('\n') + '\n' + overlayLines.join('\n') + '\n';
  // I-1: 色レイヤ鎖のラベル（`fdbase`/`fd{i}`/`fdov{i}`）が既存の鎖と衝突していないこと。
  assertUniqueFilterOutputLabels(composed);
  return composed;
}

/**
 * inputIndexBase の順送りヘルパ（M2c 設計判断8）。
 *
 * overlay 鎖の入力 index は「1（main）+ 音声 extraInputs 本数 → 画像連番群 →
 * 図形静止群 → telop+title 連番群」の順に積み上がる。extraInputs（fastCutRender）へ
 * 渡す配列順序と一致させることが契約（音声 `[i+1:a]` の添字には一切触れない —
 * 音声本数はこのヘルパの入力としてのみ使い、返り値はすべて画像以降の base）。
 */
export interface OverlayInputIndexPlanInput {
  /** main 入力(index 0)の直後に積む音声 extraInputs の本数。 */
  audioInputCount: number;
  /** 画像（挿入画像）連番型 layer の本数。 */
  imagesCount: number;
  /**
   * サブ動画（videoInserts）layer の本数（M4 T2）。**画像の後・図形の前**（正典⑦）。
   * 省略時は 0（サブ動画が無い従来経路の割当は1つも動かない・受入 E）。
   */
  videosCount?: number;
  /** 図形（InsertShape）静止型 layer の本数。 */
  shapesCount: number;
  /** telop+title 統合レイヤ（連番型）の本数。 */
  telopTitleCount: number;
}

export interface OverlayInputIndexPlan {
  /** 画像連番群の先頭 inputIndexBase。 */
  imagesBase: number;
  /** サブ動画群の先頭 inputIndexBase（M4 T2）。 */
  videosBase: number;
  /** 図形静止群の先頭 inputIndexBase。 */
  shapesBase: number;
  /** telop+title 連番群の先頭 inputIndexBase。 */
  telopTitleBase: number;
  /** 全群の後ろに続けるとしたら次に使う index（将来拡張の余地）。 */
  nextBase: number;
}

export function computeOverlayInputIndexBase(input: OverlayInputIndexPlanInput): OverlayInputIndexPlan {
  const imagesBase = 1 + input.audioInputCount;
  const videosBase = imagesBase + input.imagesCount;
  const shapesBase = videosBase + (input.videosCount ?? 0);
  const telopTitleBase = shapesBase + input.shapesCount;
  const nextBase = telopTitleBase + input.telopTitleCount;
  return { imagesBase, videosBase, shapesBase, telopTitleBase, nextBase };
}
