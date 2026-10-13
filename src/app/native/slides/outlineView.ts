import { SLIDE_LAYOUTS } from '../../../core/slides/layouts';
import type { SlideDocument, SlideGenerationPageStatus, SlideLayoutId } from '../../../core/slides/model';

export const STATUS_LABELS: Readonly<Record<SlideGenerationPageStatus, string>> = { pending: '本文待ち', generated: 'できた', failed: '失敗', cancelled: '中止' };
/** 元の段落の番号を「段落 4〜6」「段落 1・3〜4」の形にする。 */
export function paragraphRangeLabel(ids: readonly string[]): string {
  const numbers = ids.map(id => Number(id.slice(1))).filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return '';
  const runs: string[] = [];
  let start = numbers[0]!, previous = start;
  const close = () => runs.push(start === previous ? `${start}` : `${start}〜${previous}`);
  for (const value of numbers.slice(1)) { if (value === previous + 1) { previous = value; continue; } close(); start = previous = value; }
  close();
  return `段落 ${runs.join('・')}`;
}
export interface OutlineRow {
  key: string; index: number; title: string; layout: SlideLayoutId; layoutName: string; range: string;
  status: SlideGenerationPageStatus; reasons: string[]; hasProposal: boolean; pageId: string | null;
}
export function outlineRows(document: SlideDocument): OutlineRow[] {
  const generation = document.generation;
  if (!generation) return [];
  return generation.outline.map((entry, index) => {
    const state = generation.pages[index]!;
    return { key: entry.key, index, title: entry.title, layout: entry.layout, layoutName: SLIDE_LAYOUTS[entry.layout].name, range: paragraphRangeLabel(entry.sourceParagraphIds),
      status: state.status, reasons: state.reasons, hasProposal: !!state.proposal, pageId: state.pageId };
  });
}
/** 構成案に入っている段落の数（全段落がどれかのページに入っているか）。 */
export function outlineCoverage(document: SlideDocument): { covered: number; total: number } {
  const ids = new Set(document.generation?.outline.flatMap(entry => entry.sourceParagraphIds) ?? []);
  return { covered: document.script.paragraphs.filter(paragraph => ids.has(paragraph.id)).length, total: document.script.paragraphs.length };
}
export function generationCounts(document: SlideDocument): Record<SlideGenerationPageStatus, number> & { total: number } {
  const counts = { pending: 0, generated: 0, failed: 0, cancelled: 0, total: 0 };
  for (const state of document.generation?.pages ?? []) { counts[state.status]++; counts.total++; }
  return counts;
}
