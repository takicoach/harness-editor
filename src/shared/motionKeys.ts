/**
 * キーフレーム（motion.keys）の対応判定に使う目印と、未対応時に利用者へ出す文言（F-1）。
 *
 * サーバ（部品ファイルの走査）とクライアント（注意書きの表示）の両方から使うため、
 * node 依存を持たない共有モジュールに置く。
 */

/** 対応済み部品に必ず含まれる目印。 */
export const MOTION_KEYFRAMES_MARKER = 'MOTION_KEYFRAMES_V1';

/** 未対応時に UI へ出す文言（テロップ）。 */
export const TELOP_KEYFRAMES_UNSUPPORTED =
  'この案件のテロップ部品は旧版のため、キーフレームは書き出しに反映されません（通常の書き出しも高速書き出しも静止したまま・プレビューだけ動きます）。新しく作った案件では使えます。';

/** 未対応時に UI へ出す文言（挿入画像）。 */
export const IMAGE_KEYFRAMES_UNSUPPORTED =
  'この案件の挿入画像部品は旧版のため、キーフレームは効きません（プレビューも書き出しも静止したままです）。新しく作った案件では使えます。';

/** キーを持つ motion の最小形（Motion の構造的部分集合）。 */
interface MotionWithKeys {
  preset: string;
  keys?: unknown[];
}

/**
 * 未対応の案件から**キーフレームだけ**を落とす（F-1 ラウンド2 差し戻し）。
 *
 * キーを実際に描くのは案件側のラッパー（TelopPlayer.tsx）で、旧版ならキーは反映されない。
 * ところが高速書き出し（撮影＋ffmpeg）は案件の部品ではなく**エディタ側のラッパー**
 * （capturePage の CaptureTelopLayer）で描くため、何もしないと**同じ案件で書き出しエンジンごとに
 * 別の絵が出る**（利用者はどちらが選ばれるか予測できない）。撮影データからキーを落として
 * 通常書き出し（Remotion 経路）と揃え、UI の注意書き（TELOP_KEYFRAMES_UNSUPPORTED）どおり
 * 「どちらの書き出しでも静止」にする。プレビューだけが動く — それは注意書きで伝えてある。
 *
 * プリセット（2点アニメ）は旧版の部品でも描けるので落とさない。
 */
export function withoutUnsupportedKeyframes<T extends { motion?: MotionWithKeys }>(
  segments: readonly T[],
  supported: boolean,
): T[] {
  const list = [...segments];
  if (supported) return list;
  return list.map((s) => {
    const m = s.motion;
    if (m === undefined || m.keys === undefined || m.keys.length === 0) return s;
    // preset 'keyframes' はキーが本体なので motion ごと外す（＝静止）。
    if (m.preset === 'keyframes') return { ...s, motion: undefined };
    const { keys: _keys, ...rest } = m;
    return { ...s, motion: rest as MotionWithKeys };
  });
}
