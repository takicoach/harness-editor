/**
 * motionKeysSupport — 案件の部品がキーフレーム（motion.keys）に対応しているかの判定（F-1）。
 *
 * キーフレームを実際に絵にするのは**プロジェクト側へコピーされた部品**
 * （テロップ = ラッパー TelopPlayer.tsx、画像 = InsertImage.tsx）。
 * 既に作られた古い案件はこれらが旧版のままなので、キーフレームを打っても書き出しに出ない。
 * そのとき**黙って絵が変わる／黙って効かない**のが最悪なので、エディタは目印
 * （MOTION_KEYFRAMES_V1）の有無で対応可否を判定し、UI で利用者に伝える。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOTION_KEYFRAMES_MARKER } from '../shared/motionKeys';

export { MOTION_KEYFRAMES_MARKER } from '../shared/motionKeys';

export interface MotionKeysSupport {
  /** テロップのキーフレームが書き出しへ反映されるか。 */
  telop: boolean;
  /** 挿入画像のキーフレームが書き出しへ反映されるか。 */
  image: boolean;
}

function hasMarker(dir: string, rel: string): boolean {
  const path = join(dir, rel);
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').includes(MOTION_KEYFRAMES_MARKER);
  } catch {
    return false;
  }
}

/**
 * 案件ディレクトリの部品を見て対応状況を返す。
 *
 * テロップのキーを実際に適用するのは**ラッパー**（TelopPlayer.tsx）だけ、が F-1 の設計
 * （プレビュー・撮影・新版 TelopPlayer のいずれも「ラッパーで適用し、segment からは
 * position/scale/motion を外して」Telop を描く）。よって判定もラッパー1点に絞る
 * ——目印を持つのはキーを適用する部品だけ、という対応関係を崩さないため。
 *
 * テロップパックの Telop.tsx はキーを適用しないので目印を持たない。パック導入は Telop.tsx と
 * styles しか配らず TelopPlayer.tsx を差し替えないため、「旧ラッパー + 新パック」は実在する
 * 組み合わせで、そこで Telop.tsx 側の目印を根拠に true を返すと**黙って食い違う**案件に
 * 注意書きが出なくなる。ラッパーが無い／旧版なら false（fail-closed）。
 */
export function detectMotionKeysSupport(dir: string): MotionKeysSupport {
  const telopDir = join('src', 'テロップテンプレート');
  return {
    telop: hasMarker(dir, join(telopDir, 'TelopPlayer.tsx')),
    image:
      hasMarker(dir, join('src', 'InsertImage', 'imageMotion.ts')) ||
      hasMarker(dir, join('src', 'InsertImage', 'InsertImage.tsx')),
  };
}
