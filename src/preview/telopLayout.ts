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

/** ハーネス形式標準テロップの下端オフセット比（bottomOffset / compH）。フォーマット別。 */
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
 * テロップ帯の「ありうる最大幅」の標準比率（フォーマット別・compW に対する比率）。
 * project-template 標準 videoConfig.ts の TELOP_CONFIG_MAP.maxWidth（youtube 85% /
 * short 92% / square 90%）と同じ値を、telopBottomFrac と同じ理由（実際の
 * プロジェクトの TELOP_CONFIG を知らずに、エディタ⇄書き出しで同じ判定にするため）で
 * ここに標準固定する。実際の帯幅がこれより狭くても安全側（クランプが必要以上に
 * 強くなるだけ）、実際にこれより広い設定へ変更されたプロジェクトは対象外
 * （既知の残課題。移行ドキュメント参照）。
 */
export function telopMaxWidthFrac(compW: number, compH: number): number {
  if (compW > compH) return 0.85; // youtube
  if (compH > compW) return 0.92; // short
  return 0.9; // square
}

/**
 * position / scale を CSS transform 文字列へ変換する。
 * x は中心 50% 係数、y はフォーマット連動の縦係数（telopVCoeff）。
 * scale と併せて transformOrigin（telopScaleOriginY）で下端基準に拡縮する。
 *
 * **描画直前の安全網（2026-09-06 #2・B-1 差し戻し対応）**: position.x は
 * clampTelopX で必ずクランプしてから使う。書き込み側（ドラッグの実測クランプ・
 * titleToTelop）で既にクランプ済みの値も含め、position.x が「どう作られたか」
 * （既存プロジェクトの保存済み値・ドラッグのフォールバック枠・API/JSON 直書き）に
 * 関わらず、ここを通れば画面外へは出ない。実際の帯幅は分からないため
 * telopMaxWidthFrac（CSS max-width の標準値）× scale を「ありうる最大」とみなす
 * 保守的な見積りを使う（実際の帯がこれより狭ければ、その分だけ内側へ寄るだけ）。
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
    const worstElemW = compW * telopMaxWidthFrac(compW, compH) * (scale ?? 1);
    const x = clampTelopX(position.x, compW, worstElemW);
    parts.push(`translate(${x * 50}%, ${vy}%)`);
  }
  if (scale != null && scale !== 1) {
    parts.push(`scale(${scale})`);
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * position.x を「実際の帯の横幅 (elemW) を与えたときに画面内へ収まる範囲」へ丸める
 * （2026-09-05 の不具合の恒久対策）。
 *
 * `telopTransform` の x は AbsoluteFill（フレーム全幅 = containerW）へ掛かる
 * `translate(x*50%)` なので、実ピクセル移動量は `x*0.5*containerW`。帯はその中で中央寄せ
 * されるため、左端 = (containerW - elemW)/2 + x*0.5*containerW。両端が [0, containerW] へ
 * 収まる x の範囲は ±(containerW - elemW)/containerW（`titleConvertX` の `limit` と同式・
 * 単一の正本へ集約）。
 *
 * 帯がコンテナより広い（elemW >= containerW）場合は 0（中央）を返す。中央なら左右の
 * 見切れが対称になり、どちらか片側だけ切れて読めなくなる事故を避けられる
 * （`titleToTelop` が測れないときに 0 へ倒すのと同じ考え方）。
 *
 * containerW はステージ座標・合成座標のどちらでも良い（比率だけを使うため）。elemW は
 * 同じ座標系で測ること。
 */
export function clampTelopX(x: number, containerW: number, elemW: number): number {
  if (!(containerW > 0) || !(elemW >= 0) || !Number.isFinite(x)) return 0;
  if (elemW >= containerW) return 0;
  const limit = (containerW - elemW) / containerW;
  return Math.max(-limit, Math.min(limit, x));
}
