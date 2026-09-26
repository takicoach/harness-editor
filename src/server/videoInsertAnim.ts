/**
 * サブ動画インサートの出入りアニメ（正典⑥）を **静的レイヤの列**へ分解する（M4 T4）。
 *
 * 正典は `src/core/elementAnim.ts` の `animStyleAt`（旧配布原文は
 * `tests/fixtures/legacy-media-payloads/src/server/videoInsertPayload/elementAnim.ts.txt` に保全）。
 * 5 種はすべて opacity / scale / translate の 3 要素に分解でき、
 * **どれも「窓内相対フレーム k の関数」**で、k は整数しか取らない。
 *
 * ## なぜ時変式ではなくフレーム分割なのか（設計判断・T4）
 * ffmpeg で時変にする手段（`scale=eval=frame` の式・`zoompan`・`sendcmd` での
 * `colorchannelmixer` 操作）はどれも
 *   - 丸めや位相が T1/T2 で実測した**静的経路と別物**になり、正典との画素一致を測り直す羽目になる
 *   - `pop` の 1.12 倍オーバーシュートに対する `crop`（I-1 の省コスト）が**静的な配置基準のまま
 *     残り、動的に広がった分を切り落とす**（＝正典と違う絵を黙って出す）
 * という 2 つの穴を持つ。
 *
 * ここでは代わりに **k ごとに静的な矩形と定数 alpha を解き、同じ値が続く区間へまとめる**。
 * 各区間は既存の（T1〜T3 で Remotion 基準線と突合済みの）`scale`+`pad`+`crop`+`overlay` 経路を
 * そのまま通るので、丸めも crop も実測済みの経路と一致する。区間数は
 * `enter.frames + exit.frames + 1` が上限（UI のスライダ上限 30fr ずつ＝最大 61）。
 *
 * アニメが恒等（`none` / `frames<=0`）のときは `undefined` を返す＝呼び出し側は従来どおり
 * 1 レイヤで組み、**filter 文字列は 1 文字も変わらない**（受入 E）。
 */
import type { ElementAnim } from '../core/types';
import {
  videoInsertPlacement,
  videoInsertPlacementAt,
  type VideoInsertAnimSample,
  type VideoInsertPlacement,
} from './nativeExportVideo';

/**
 * 1 レイヤが持てる step の上限。
 *
 * UI（`AnimControls`）のスライダは 2〜30fr なので、enter/exit とも最大でも 30 + 30 + 平坦部 1 =
 * **61 段**。プロジェクト JSON を手で（または AI が）書けばこれを超えられるため上限を置き、
 * 超えたら**黙って近似せず** Remotion 経路へ退避する（呼び出し側が catch する）。
 */
export const MAX_VIDEO_INSERT_ANIM_STEPS = 64;

/** 1 段ぶんの静的レイヤ（窓内相対フレーム `[kStart,kEnd)` に、この配置・この不透明度で出す）。 */
export interface VideoInsertAnimStep {
  kStart: number;
  kEnd: number;
  /** 0 < opacity <= 1（0 のフレームは「描かれない」ので step にしない）。 */
  opacity: number;
  placement: VideoInsertPlacement;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

const NO_ANIM: ElementAnim = { kind: 'none', frames: 0 };

/**
 * 正典 `elementAnim.endpointStyle` の数値版（**式は正典の写し・変えないこと**）。
 * `toFixed(4)` まで含めて写す——正典は transform 文字列を 4 桁で作るので、そこで丸めた値が
 * 実際に描かれた値であり、native もその値で矩形を解く必要がある。
 */
function endpointSample(anim: ElementAnim, p: number): VideoInsertAnimSample {
  const t = clamp(p, 0, 1);
  switch (anim.kind) {
    case 'none':
      return { opacity: 1, scale: 1, translateXPercent: 0, translateYPercent: 0 };
    case 'fade':
      return { opacity: t, scale: 1, translateXPercent: 0, translateYPercent: 0 };
    case 'zoom': {
      const scale = 0.85 + 0.15 * t; // 0.85 → 1
      return { opacity: t, scale: Number(scale.toFixed(4)), translateXPercent: 0, translateYPercent: 0 };
    }
    case 'pop': {
      // 0→1.12（70%地点）→1 のオーバーシュート。不透明度は前半で立ち上げる。
      const scale = t < 0.7 ? (t / 0.7) * 1.12 : 1.12 + ((t - 0.7) / 0.3) * (1 - 1.12);
      return {
        opacity: clamp(t / 0.4, 0, 1),
        scale: Number(scale.toFixed(4)),
        translateXPercent: 0,
        translateYPercent: 0,
      };
    }
    case 'slideIn': {
      const dist = (1 - t) * 100; // % 退避量（100→0）
      const dir = anim.direction ?? 'left';
      const tx = dir === 'left' ? -dist : dir === 'right' ? dist : 0;
      const ty = dir === 'up' ? -dist : dir === 'down' ? dist : 0;
      return {
        opacity: t,
        scale: 1,
        translateXPercent: Number(tx.toFixed(4)),
        translateYPercent: Number(ty.toFixed(4)),
      };
    }
  }
}

/**
 * 正典 `elementAnim.animStyleAt` の数値版。窓は `enter: [0, frames)` / `exit: (D − frames, D]`、
 * 両窓が重なるときは **enter が優先**（正典の判定順そのもの）。
 */
export function videoInsertAnimSampleAt(
  k: number,
  durationFrames: number,
  enter: ElementAnim | undefined,
  exit: ElementAnim | undefined,
): VideoInsertAnimSample {
  const e = enter ?? NO_ANIM;
  const x = exit ?? NO_ANIM;
  if (durationFrames <= 0) return { opacity: 0, scale: 1, translateXPercent: 0, translateYPercent: 0 };
  const enterFrames = Math.max(0, e.frames);
  const exitFrames = Math.max(0, x.frames);
  if (e.kind !== 'none' && enterFrames > 0 && k < enterFrames) {
    return endpointSample(e, k / enterFrames);
  }
  if (x.kind !== 'none' && exitFrames > 0 && k > durationFrames - exitFrames) {
    return endpointSample(x, (durationFrames - k) / exitFrames);
  }
  return { opacity: 1, scale: 1, translateXPercent: 0, translateYPercent: 0 };
}

function samePlacement(a: VideoInsertPlacement, b: VideoInsertPlacement): boolean {
  if (a.width !== b.width || a.height !== b.height || a.x !== b.x || a.y !== b.y) return false;
  if (a.crop === undefined || b.crop === undefined) return a.crop === b.crop;
  return a.crop.x === b.crop.x && a.crop.y === b.crop.y && a.crop.width === b.crop.width && a.crop.height === b.crop.height;
}

/**
 * 窓 `[0, durationFrames)` を、静的な配置・不透明度が一定の区間へ分解する。
 *
 * - **恒等（アニメ無し）なら `undefined`**。呼び出し側は従来の 1 レイヤ経路へ落ちる（受入 E）。
 * - 正典で**見えない** k（`opacity === 0`・矩形が 0 画素）は step にしない。ffmpeg で
 *   `colorchannelmixer=aa=0` や 0 幅の `scale` を作らないため（後者はフィルタが失敗する）。
 *   enter の k=0 は 5 種すべて t=0＝不可視なので、必ずここで落ちる。
 * - 区間数が `MAX_VIDEO_INSERT_ANIM_STEPS` を超えたら throw（呼び出し側が Remotion へ退避）。
 */
export function videoInsertAnimSteps(
  size: { width: number; height: number },
  position: { x: number; y: number } | undefined,
  scale: number | undefined,
  durationFrames: number,
  enter: ElementAnim | undefined,
  exit: ElementAnim | undefined,
): VideoInsertAnimStep[] | undefined {
  if (!Number.isInteger(durationFrames) || durationFrames <= 0) {
    throw new Error(`videoInsertAnimSteps: 窓長が不正です（${String(durationFrames)}）`);
  }
  const base = videoInsertPlacement(size, position, scale);
  const steps: VideoInsertAnimStep[] = [];
  let animated = false;
  for (let k = 0; k < durationFrames; k += 1) {
    const a = videoInsertAnimSampleAt(k, durationFrames, enter, exit);
    if (a.opacity !== 1 || a.scale !== 1 || a.translateXPercent !== 0 || a.translateYPercent !== 0) {
      animated = true;
    }
    if (a.opacity <= 0) continue;
    const placement = videoInsertPlacementAt(size, position, scale, a);
    if (placement.width <= 0 || placement.height <= 0) continue;
    const last = steps.at(-1);
    if (last !== undefined && last.kEnd === k && last.opacity === a.opacity && samePlacement(last.placement, placement)) {
      last.kEnd = k + 1;
      continue;
    }
    steps.push({ kStart: k, kEnd: k + 1, opacity: a.opacity, placement });
  }
  if (!animated) return undefined;
  if (steps.length === 0) {
    throw new Error('videoInsertAnimSteps: 全フレームが不可視になりました（アニメ指定が壊れています）');
  }
  // 見た目が窓全体で恒等（例: frames=1 で k=0 だけが不可視、以降は素通し）でも、
  // 「頭の 1 フレームが出ない」ことは正典の挙動なので step として残す。
  const single = steps.length === 1 && steps[0]!.kStart === 0 && steps[0]!.kEnd === durationFrames;
  if (single && steps[0]!.opacity === 1 && samePlacement(steps[0]!.placement, base)) return undefined;
  if (steps.length > MAX_VIDEO_INSERT_ANIM_STEPS) {
    throw new Error(
      `videoInsertAnimSteps: アニメの step が多すぎます（${steps.length} > ${MAX_VIDEO_INSERT_ANIM_STEPS}）`,
    );
  }
  return steps;
}
