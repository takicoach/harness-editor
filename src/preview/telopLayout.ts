/**
 * テロップの位置・拡縮レイアウト（フォーマット連動）。
 *
 * ハーネス形式のテロップは画面下端（bottomOffset 上）に固定で描かれる。エディタの位置/拡縮
 * 操作はこの「下端固定」を前提に組む：
 *  - 縦移動 y は下端(0)〜上端(-1)。係数 telopVCoeff で y=-1 が画面上部（上下対称の余白）へ届く。
 *  - 拡縮は下端基準（telopScaleOriginY）で上へ伸縮し、下端は動かさない（拡縮で上下にズレない）。
 *
 * このモジュールはエディタ側（preview / app）の共有ロジック。プロジェクトへコピーされる
 * テロップアダプタ（src/server/telopPack/Telop.tsx）にも同じ式を自己完結で持たせている。
 */

/** テロップの正規化位置（フレーム中心が原点）。x: 左-1〜右1、y: 下0〜上-1。 */
export interface TelopPosition {
  x: number;
  y: number;
}

/** ハーネス標準テロップの下端オフセット比（bottomOffset / compH）。フォーマット別。 */
export function telopBottomFrac(compW: number, compH: number): number {
  if (compW > compH) return 100 / 1080; // youtube
  if (compH > compW) return 200 / 1920; // short
  return 140 / 1080; // square
}

/**
 * テロップ縦移動係数。y=-1 で「上端の余白＝下端の余白」になる対称配置にする
 * （フレーム高さに対し 1 - 2*bottomFrac だけ上へ動かせる）。これで y=-1 が画面上部まで届く。
 */
export function telopVCoeff(compW: number, compH: number): number {
  return 1 - 2 * telopBottomFrac(compW, compH);
}

/** 拡縮の基準（テロップ下端）の transformOrigin Y（%）。 */
export function telopScaleOriginY(compW: number, compH: number): number {
  return (1 - telopBottomFrac(compW, compH)) * 100;
}

/**
 * position / scale を CSS transform 文字列へ変換する。
 * x は中心 50% 係数、y はフォーマット連動の縦係数（telopVCoeff）。
 * scale と併せて transformOrigin（telopScaleOriginY）で下端基準に拡縮する。
 */
export function telopTransform(
  position: TelopPosition | undefined,
  scale: number | undefined,
  compW: number,
  compH: number,
): string | undefined {
  const parts: string[] = [];
  if (position) {
    const vy = position.y * telopVCoeff(compW, compH) * 100;
    parts.push(`translate(${position.x * 50}%, ${vy}%)`);
  }
  if (scale != null && scale !== 1) {
    parts.push(`scale(${scale})`);
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}
