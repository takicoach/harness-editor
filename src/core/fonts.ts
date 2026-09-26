export interface FontDef {
  id: string;
  /** CSS の font-family 名。@font-face の family と一致させる。 */
  family: string;
  label: string;
  /** public/fonts/ の中のファイル名。システム書体は null。 */
  file: string | null;
  group: 'bundled' | 'system';
}

/** 件数はここから数える。コードのどこにも「8」と書かない。 */
export const FONTS: readonly FontDef[] = [
  { id: 'system-gothic', family: 'Hiragino Sans', label: 'ゴシック（システム）', file: null, group: 'system' },
  { id: 'system-mincho', family: 'Hiragino Mincho ProN', label: '明朝（システム）', file: null, group: 'system' },
  { id: 'system-arial', family: 'Arial', label: 'Arial（システム）', file: null, group: 'system' },
  { id: 'noto-sans-jp', family: 'Noto Sans JP', label: '標準ゴシック（Noto Sans JP）', file: 'noto-sans-jp-400.woff2', group: 'bundled' },
  { id: 'zen-kaku-gothic-new', family: 'Zen Kaku Gothic New', label: '読みやすいゴシック（Zen Kaku Gothic New）', file: 'zen-kaku-gothic-new-400.woff2', group: 'bundled' },
  { id: 'biz-udpgothic', family: 'BIZ UDPGothic', label: 'UD ゴシック（BIZ UDPGothic）', file: 'biz-udpgothic-400.woff2', group: 'bundled' },
  { id: 'm-plus-rounded-1c', family: 'M PLUS Rounded 1c', label: '丸ゴシック（M PLUS Rounded 1c）', file: 'm-plus-rounded-1c-400.woff2', group: 'bundled' },
  { id: 'noto-serif-jp', family: 'Noto Serif JP', label: '明朝（Noto Serif JP）', file: 'noto-serif-jp-400.woff2', group: 'bundled' },
  { id: 'dela-gothic-one', family: 'Dela Gothic One', label: '太い見出し（Dela Gothic One）', file: 'dela-gothic-one.woff2', group: 'bundled' },
  { id: 'mochiy-pop-one', family: 'Mochiy Pop One', label: 'ポップ（Mochiy Pop One）', file: 'mochiy-pop-one.woff2', group: 'bundled' },
  { id: 'yusei-magic', family: 'Yusei Magic', label: '手書き風（Yusei Magic）', file: 'yusei-magic.woff2', group: 'bundled' },
  { id: 'zen-maru-gothic', family: 'Zen Maru Gothic', label: '手書き寄りの丸（Zen Maru Gothic）', file: 'zen-maru-gothic.woff2', group: 'bundled' },
  { id: 'kosugi-maru', family: 'Kosugi Maru', label: 'やわらかい丸（Kosugi Maru）', file: 'kosugi-maru.woff2', group: 'bundled' },
  { id: 'hachi-maru-pop', family: 'Hachi Maru Pop', label: '手書き風ポップ（Hachi Maru Pop）', file: 'hachi-maru-pop.woff2', group: 'bundled' },
  { id: 'zen-kurenaido', family: 'Zen Kurenaido', label: '手書き風（Zen Kurenaido）', file: 'zen-kurenaido.woff2', group: 'bundled' },
  { id: 'rocknroll-one', family: 'RocknRoll One', label: '太めの見出し（RocknRoll One）', file: 'rocknroll-one.woff2', group: 'bundled' },
  { id: 'reggae-one', family: 'Reggae One', label: '見出し（Reggae One）', file: 'reggae-one.woff2', group: 'bundled' },
  { id: 'shippori-mincho', family: 'Shippori Mincho', label: '明朝（Shippori Mincho）', file: 'shippori-mincho.woff2', group: 'bundled' },
  { id: 'zen-old-mincho', family: 'Zen Old Mincho', label: '明朝（Zen Old Mincho）', file: 'zen-old-mincho.woff2', group: 'bundled' },
];

export function fontById(id: string): FontDef | undefined {
  return FONTS.find(font => font.id === id);
}

/** appearance.fontFamily に入れる値。欠落文字はここの控えで描かれる。 */
export function fontStack(font: FontDef): string {
  const fallback = /Mincho|Serif/i.test(font.family)
    ? `'Hiragino Mincho ProN', 'Yu Mincho', serif`
    : `'Hiragino Sans', 'Yu Gothic', sans-serif`;
  return `'${font.family}', ${fallback}`;
}

/**
 * 保存済みの fontFamily 値（生 family／fontStack のスタック／先頭が `"<family>"` の
 * 旧フォールバックスタック、いずれも可）から該当する FontDef を照合する。
 * NativeFontField の現在値表示・選択状態の判定に使う。
 */
export function resolveFontByValue(value: string): FontDef | undefined {
  const trimmed = value.trim();
  return FONTS.find(font =>
    font.family === trimmed ||
    fontStack(font) === trimmed ||
    trimmed.startsWith(`"${font.family}"`) ||
    trimmed.startsWith(`'${font.family}'`));
}
