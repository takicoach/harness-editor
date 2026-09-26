import type { PublicEditorOperation } from './editorOperations';

export interface EditorActivityPage {
  operations: PublicEditorOperation[]; total: number; nextOffset: number | null;
}

/** append-onlyの受付順を境界に使うため、page間の新規追記で古い範囲がずれない。 */
export function editorOperationActivityPage(
  operations: PublicEditorOperation[],
  offset: number | undefined,
  limit = 20,
): EditorActivityPage {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('INVALID_PAGE: 取得件数は1〜100件で指定してください');
  }
  // nextOffsetは0を返さないため、初回のoffset=0は省略時と同じ意味で受け付ける。
  const end = offset === undefined || offset === 0 ? operations.length : offset;
  if (!Number.isSafeInteger(end) || end < 0 || end > operations.length) {
    throw new Error('INVALID_PAGE: 履歴の続き位置が不正です');
  }
  const start = Math.max(0, end - limit);
  return { operations: operations.slice(start, end).reverse(), total: operations.length,
    nextOffset: start > 0 ? start : null };
}
