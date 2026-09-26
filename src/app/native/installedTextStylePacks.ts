import {parseInstalledTextStylePackInfo, type InstalledTextStylePackInfo} from '../../core/sequence/installedTextStylePack';

/**
 * 同梱されている追加パック（`src/server/<フォルダ>/textStylePack.json`）。ビルド時に Vite が集める。
 * パックのフォルダが無い配布物では空になり、一覧に追加ボタンもタブ名も出ない。
 */
const found = import.meta.glob('../../server/*/textStylePack.json', {eager: true, import: 'default'}) as Record<string, unknown>;
export const INSTALLED_TEXT_STYLE_PACKS: readonly InstalledTextStylePackInfo[] =
  Object.freeze(Object.keys(found).sort().map(key => parseInstalledTextStylePackInfo(found[key])));
