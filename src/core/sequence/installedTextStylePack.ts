/**
 * 本体に同梱しない追加のテロップスタイルパック（`src/server/<フォルダ>/textStylePack.json`）の表示と識別。
 * パックのフォルダが無い配布物（OSS 版）では、サーバーも画面も何も足さない。
 */
export interface InstalledTextStylePackInfo {
  /** 凍結カタログの packId。本体パック（harness.builtin）と別の名前空間にする。 */
  packId: string;
  /** 凍結部品の資産名・一覧の見出し。 */
  name: string;
  /** スタイル一覧のタブの短い名前。 */
  tabLabel: string;
  /** 現在のスタイルの横に出す出どころの名前。 */
  groupLabel: string;
  /** 収録スタイル数（manifest.json の件数と一致させる）。 */
  count: number;
  /** 全スタイルが描ける動き。 */
  animations: readonly string[];
}

export function parseInstalledTextStylePackInfo(value: unknown): InstalledTextStylePackInfo {
  const v = value as Record<string, unknown> | null;
  const text = (key: string) => {
    if (!v || typeof v[key] !== 'string' || !(v[key] as string).trim()) throw new Error(`textStylePack.json の ${key} が不正です`);
    return v[key] as string;
  };
  const packId = text('packId'), name = text('name'), tabLabel = text('tabLabel'), groupLabel = text('groupLabel');
  if (packId === 'harness.builtin') throw new Error('textStylePack.json の packId は本体パックと別にしてください');
  if (!Number.isSafeInteger(v!.count) || (v!.count as number) < 1) throw new Error('textStylePack.json の count が不正です');
  if (!Array.isArray(v!.animations) || !v!.animations.length || v!.animations.some(a => typeof a !== 'string')) throw new Error('textStylePack.json の animations が不正です');
  return {packId, name, tabLabel, groupLabel, count: v!.count as number, animations: Object.freeze([...(v!.animations as string[])])};
}
