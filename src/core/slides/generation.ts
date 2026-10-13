import { SequenceError } from '../sequence/errors';
import { buildSlideLayers, titleFields } from './build';
import { RUN_ID } from './contract';
import { findSlidePage, SLIDE_LAYOUT_IDS, SLIDES_MAX_PAGES, type SlideDocument, type SlideGeneration, type SlideGenerationStatus, type SlideGlossaryEntry,
  type SlideLayoutId, type SlideOutlinePage, type SlidePage, type SlideProposal } from './model';
import { checkIndex, fillPageFromBody, freshPageId, invalid, layerIdAllocator, outOfRange, record, slideTheme } from './pageOps';

export type SlideGenerationCommand =
  | { type: 'set-outline'; runId: string; outline: SlideOutlinePage[]; glossary: SlideGlossaryEntry[]; model: string | null }
  | { type: 'move-outline-page'; key: string; index: number }
  | { type: 'remove-outline-page'; key: string }
  | { type: 'set-outline-layout'; key: string; layout: SlideLayoutId }
  | { type: 'confirm-outline' }
  | { type: 'apply-page-bodies'; runId: string; bodies: SlideProposal[]; failures: Array<{ key: string; reasons: string[] }>; model: string | null }
  | { type: 'adopt-proposal'; pageId: string }
  | { type: 'discard-proposal'; pageId: string }
  | { type: 'cancel-generation'; runId: string }
  | { type: 'resume-generation'; runId: string };
export const SLIDE_GENERATION_COMMAND_TYPES = ['set-outline', 'move-outline-page', 'remove-outline-page', 'set-outline-layout', 'confirm-outline',
  'apply-page-bodies', 'adopt-proposal', 'discard-proposal', 'cancel-generation', 'resume-generation'] as const;
export function isGenerationCommand(command: { type: unknown }): command is SlideGenerationCommand {
  return (SLIDE_GENERATION_COMMAND_TYPES as readonly unknown[]).includes(command.type);
}

function generationOf(document: SlideDocument): SlideGeneration {
  if (!document.generation) return outOfRange('構成案がありません');
  return document.generation;
}
function expectStatus(generation: SlideGeneration, statuses: readonly SlideGenerationStatus[], message: string): void {
  if (!statuses.includes(generation.status)) outOfRange(message);
}
function outlineIndex(generation: SlideGeneration, key: unknown): number {
  const index = generation.outline.findIndex(entry => entry.key === key);
  if (index < 0) throw new SequenceError('MISSING_TARGET', '構成案に無いページです', [String(key)]);
  return index;
}
/** 構成案の前後のページの間（無ければ末尾）。手で消したページを作り直すときの位置。 */
function insertIndexFor(document: SlideDocument, generation: SlideGeneration, index: number): number {
  const at = (i: number) => { const id = generation.pages[i]!.pageId; return id ? document.pages.findIndex(page => page.id === id) : -1; };
  for (let i = index - 1; i >= 0; i--) { const found = at(i); if (found >= 0) return found + 1; }
  for (let i = index + 1; i < generation.pages.length; i++) { const found = at(i); if (found >= 0) return found; }
  return document.pages.length;
}
/** 本文待ちのページ（題だけ）。 */
function waitingPage(document: SlideDocument, pageId: string, entry: SlideOutlinePage): SlidePage {
  const built = buildSlideLayers(entry.layout, titleFields(entry.layout, entry.title), slideTheme(document), layerIdAllocator(document, pageId));
  return { id: pageId, layout: entry.layout, layers: built.layers, bindings: built.bindings, notes: '', sourceParagraphIds: [...entry.sourceParagraphIds],
    origin: 'ai', editedAfterGeneration: false, outlineKey: entry.key };
}

export function applyGenerationCommand(document: SlideDocument, command: SlideGenerationCommand): SlideDocument {
  switch (command.type) {
    case 'set-outline': {
      if (document.generation?.status === 'generating') outOfRange('生成の途中です。中止してから構成案を出し直してください');
      if (typeof command.runId !== 'string' || !RUN_ID.test(command.runId)) invalid('生成の ID が不正です');
      if (!Array.isArray(command.outline) || !Array.isArray(command.glossary)) invalid('構成案の形が不正です');
      // 前の生成のページは正本として残す（構成案とのつながりだけ外す）。
      for (const page of document.pages) delete page.outlineKey;
      document.generation = { runId: command.runId, status: 'outline', confirmed: false, outline: structuredClone(command.outline), glossary: structuredClone(command.glossary),
        pages: command.outline.map(entry => ({ key: entry.key, status: 'pending', pageId: null, reasons: [] })), model: command.model ?? null };
      return document;
    }
    case 'move-outline-page': {
      const generation = generationOf(document);
      expectStatus(generation, ['outline'], '構成案を直せるのは、確定する前だけです');
      const from = outlineIndex(generation, command.key), to = checkIndex(command.index, generation.outline.length - 1);
      const [entry] = generation.outline.splice(from, 1), [state] = generation.pages.splice(from, 1);
      generation.outline.splice(to, 0, entry!); generation.pages.splice(to, 0, state!);
      return document;
    }
    case 'remove-outline-page': {
      const generation = generationOf(document);
      expectStatus(generation, ['outline'], '構成案を直せるのは、確定する前だけです');
      if (generation.outline.length <= 1) outOfRange('最後のページは消せません');
      const index = outlineIndex(generation, command.key), [removed] = generation.outline.splice(index, 1);
      generation.pages.splice(index, 1);
      // 段落は隣のページへ移す（欠落を作らない）。
      const target = generation.outline[index - 1] ?? generation.outline[index]!;
      target.sourceParagraphIds = [...target.sourceParagraphIds, ...removed!.sourceParagraphIds];
      return document;
    }
    case 'set-outline-layout': {
      const generation = generationOf(document);
      expectStatus(generation, ['outline'], '構成案を直せるのは、確定する前だけです');
      if (!SLIDE_LAYOUT_IDS.includes(command.layout)) invalid('知らないレイアウトです', [String(command.layout)]);
      generation.outline[outlineIndex(generation, command.key)]!.layout = command.layout;
      return document;
    }
    case 'confirm-outline': {
      const generation = generationOf(document);
      expectStatus(generation, ['outline'], '確定できるのは構成案の確認中だけです');
      if (document.pages.length + generation.outline.length > SLIDES_MAX_PAGES)
        outOfRange(`ページは ${SLIDES_MAX_PAGES} までです（今 ${document.pages.length}・構成案 ${generation.outline.length}）`);
      for (const [index, entry] of generation.outline.entries()) {
        const page = waitingPage(document, freshPageId(document, `pg-${generation.runId}-${entry.key}`), entry);
        document.pages.push(page); generation.pages[index]!.pageId = page.id;
      }
      generation.status = 'generating'; generation.confirmed = true;
      return document;
    }
    case 'apply-page-bodies': {
      const generation = generationOf(document);
      if (generation.runId !== command.runId) outOfRange('別の生成への本文です。読み直してください');
      expectStatus(generation, ['generating', 'complete'], '中止された生成です。画面の「続きから作る」で再開してください');
      if (!Array.isArray(command.bodies) || !Array.isArray(command.failures)) invalid('本文の形が不正です');
      for (const proposal of command.bodies) {
        if (!record(proposal) || !record(proposal.body)) invalid('本文の形が不正です');
        const index = outlineIndex(generation, proposal.body.key), state = generation.pages[index]!, entry = generation.outline[index]!;
        const page = state.pageId ? document.pages.find(item => item.id === state.pageId) : undefined;
        if (page?.editedAfterGeneration) state.proposal = structuredClone(proposal); // 手で直したページは上書きしない（置き換え案）
        else if (page) { fillPageFromBody(document, page, proposal, entry.sourceParagraphIds); delete state.proposal; }
        else {
          if (document.pages.length >= SLIDES_MAX_PAGES) outOfRange(`ページは ${SLIDES_MAX_PAGES} までです`);
          const created = waitingPage(document, freshPageId(document, `pg-${generation.runId}-${entry.key}`), entry);
          document.pages.splice(insertIndexFor(document, generation, index), 0, created);
          fillPageFromBody(document, created, proposal, entry.sourceParagraphIds);
          state.pageId = created.id;
        }
        state.status = 'generated'; state.reasons = [];
      }
      for (const failure of command.failures) {
        const state = generation.pages[outlineIndex(generation, failure.key)]!;
        if (state.status === 'generated') continue;
        state.status = 'failed'; state.reasons = failure.reasons.slice(0, 10).map(reason => String(reason).slice(0, 300));
      }
      if (command.model) generation.model = command.model;
      if (generation.pages.every(state => state.status === 'generated')) generation.status = 'complete';
      return document;
    }
    case 'adopt-proposal': case 'discard-proposal': {
      const generation = generationOf(document), page = findSlidePage(document, command.pageId);
      const state = page.outlineKey ? generation.pages.find(item => item.key === page.outlineKey) : undefined;
      if (!state?.proposal) outOfRange('このページに置き換え案はありません');
      if (command.type === 'adopt-proposal') fillPageFromBody(document, page, state.proposal, generation.outline[generation.pages.indexOf(state)]!.sourceParagraphIds);
      delete state.proposal;
      return document;
    }
    case 'cancel-generation': {
      const generation = generationOf(document);
      if (generation.runId !== command.runId) outOfRange('別の生成への操作です。読み直してください');
      expectStatus(generation, ['outline', 'generating'], '中止できるのは、構成案の確認中か生成中だけです');
      generation.status = 'cancelled';
      for (const state of generation.pages) if (state.status === 'pending') state.status = 'cancelled';
      return document;
    }
    case 'resume-generation': {
      const generation = generationOf(document);
      if (generation.runId !== command.runId) outOfRange('別の生成への操作です。読み直してください');
      expectStatus(generation, ['cancelled'], '再開できるのは中止した生成だけです');
      for (const state of generation.pages) if (state.status === 'cancelled') state.status = 'pending';
      generation.status = !generation.confirmed ? 'outline' : generation.pages.every(state => state.status === 'generated') ? 'complete' : 'generating';
      return document;
    }
  }
}
