import type { EditorTelop } from '../../core/types';

/**
 * テロップ配列を字幕（manual !== true）と手動テロップ（manual === true）に分割する。
 * Task 2: じまく/テロップ2列分離のユーティリティ。
 */
export function splitTelops(telops: EditorTelop[]): {
  subtitles: EditorTelop[];
  manuals: EditorTelop[];
} {
  const subtitles: EditorTelop[] = [];
  const manuals: EditorTelop[] = [];
  for (const t of telops) {
    if (t.manual === true) {
      manuals.push(t);
    } else {
      subtitles.push(t);
    }
  }
  return { subtitles, manuals };
}
