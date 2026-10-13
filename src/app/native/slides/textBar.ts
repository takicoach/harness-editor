import type { TextAppearance } from '../../../core/sequence/model';

/** 空行を除く全行の頭が「・」（または「•」）なら箇条書き。 */
export function hasBullets(text: string): boolean {
  const lines = text.split('\n').filter(line => line.trim());
  return lines.length > 0 && lines.every(line => /^\s*[・•]/.test(line));
}
/** 箇条書きの入り切り。入れるときは空でない行の頭に「・」、切るときは外す。 */
export function toggleBullets(text: string): string {
  return hasBullets(text) ? text.split('\n').map(line => line.replace(/^\s*[・•]\s*/, '')).join('\n')
    : text.split('\n').map(line => line.trim() ? `・${line.replace(/^\s+/, '')}` : line).join('\n');
}
export const TEXT_ALIGNS: ReadonlyArray<{ value: TextAppearance['align']; label: string }> = [
  { value: 'left', label: '左揃え' }, { value: 'center', label: '中央揃え' }, { value: 'right', label: '右揃え' }];
