import type { SlideDocument, SlideGenerationPageStatus, SlidePage, SlideProposal } from '../../../core/slides/model';

export interface PageGenerationInfo { key: string | null; status: SlideGenerationPageStatus | null; reasons: string[]; proposal: SlideProposal | null; canRegenerate: boolean }
/** 今のページの生成の情報（構成案の key・状態・失敗の理由・置き換え案・作り直せるか）。 */
export function pageGenerationInfo(document: SlideDocument, page: SlidePage): PageGenerationInfo {
  const generation = document.generation, state = page.outlineKey ? generation?.pages.find(item => item.key === page.outlineKey) : undefined;
  return { key: state ? page.outlineKey! : null, status: state?.status ?? null, reasons: state?.reasons ?? [], proposal: state?.proposal ?? null,
    canRegenerate: !!state && !!generation?.confirmed && (generation.status === 'generating' || generation.status === 'complete') };
}
/** 置き換え案の要約（題・見出し・副題・箇条書き・手順・左右）。 */
export function proposalSummary(proposal: SlideProposal): string[] {
  const fields = proposal.body.fields as unknown as Record<string, unknown>, lines: string[] = [];
  for (const name of ['number', 'title', 'heading', 'subtitle']) { const value = fields[name]; if (typeof value === 'string' && value) lines.push(value); }
  for (const name of ['bullets', 'steps']) { const value = fields[name]; if (Array.isArray(value)) lines.push(...value.filter((item): item is string => typeof item === 'string')); }
  for (const name of ['left', 'right']) { const value = fields[name] as { title?: string; body?: string } | undefined; if (value) lines.push(`${value.title ?? ''}：${value.body ?? ''}`); }
  return lines;
}
