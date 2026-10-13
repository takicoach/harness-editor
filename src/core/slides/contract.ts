import { SequenceError } from '../sequence/errors';
import { emphasisCount, stripEmphasis } from '../sequence/renderExtras';
import { SLIDE_LAYOUTS } from './layouts';
import { SLIDE_LAYOUT_IDS, SLIDES_MAX_NOTES_CHARS, SLIDES_MAX_PAGES, SLIDES_MAX_PAGES_PER_REQUEST, SLIDES_MAX_PARAGRAPH_CHARS, SLIDES_MAX_PARAGRAPHS,
  type SlideDocument, type SlideFields, type SlideGlossaryEntry, type SlideImageSlotRequest, type SlideLayoutId, type SlideOutline, type SlideOutlinePage,
  type SlidePageBody, type SlideParagraph, type SlideScript } from './model';

/** 公開する版つきのスキーマ名。版を上げるときは名前の末尾の数字を変え、古い版は検証器で拒否する。 */
export const SLIDES_OUTLINE_SCHEMA = 'harness-slides-outline/1';
export const SLIDES_PAGE_SCHEMA = 'harness-slides-page/1';
export const OUTLINE_KEY = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
export const PARAGRAPH_ID = /^p[1-9][0-9]{0,3}$/;
export type SlideIssueCode = 'SCHEMA_VERSION' | 'SHAPE' | 'REQUIRED' | 'TOO_LONG' | 'COUNT' | 'UNKNOWN_LAYOUT' | 'UNKNOWN_PARAGRAPH' | 'DUPLICATE' | 'MISSING'
  | 'EMPHASIS' | 'UNKNOWN_KEY' | 'LAYOUT_MISMATCH' | 'ALREADY_GENERATED' | 'TOO_MANY' | 'UNKNOWN_FIELD' | 'IMAGE_SLOT' | 'RUN_STATE';
/** 問題の位置（path）と理由（message）。key はページ本文・構成案のどのページか。 */
export interface SlideIssue { path: string; key?: string; code: SlideIssueCode; message: string }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const issue = (path: string, code: SlideIssueCode, message: string, key?: string): SlideIssue => ({ path, code, message, ...(key ? { key } : {}) });
const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
/** 見た目の 1 文字（絵文字・結合文字を 1 と数える）。 */
export function graphemeLength(text: string): number { let count = 0; for (const _ of segmenter.segment(text)) count++; return count; }
/** 1 回の検証で返す問題の上限と、メッセージに写すユーザー入力の長さの上限（巨大な入力が応答・操作記録に丸ごと残らないように）。 */
export const SLIDES_MAX_ISSUES = 50;
const SHOW_CHARS = 40;
/** 1 ページの画像枠の指定の上限（枠の重複は別に拒否するので、取り込みはこの件数を超えない）。 */
const SLIDES_MAX_IMAGE_SLOT_REQUESTS = 4;
const show = (value: unknown): string => { const text = String(value); return text.length > SHOW_CHARS ? `${text.slice(0, SHOW_CHARS)}…` : text; };
function capIssues(list: SlideIssue[], path = ''): SlideIssue[] {
  if (list.length <= SLIDES_MAX_ISSUES) return list;
  return [...list.slice(0, SLIDES_MAX_ISSUES), issue(path, 'TOO_MANY', `ほかにも問題があります（${list.length - SLIDES_MAX_ISSUES} 件以上は省略）`, list[0]!.key)];
}
const LAYOUT_LIST = SLIDE_LAYOUT_IDS.join('・');

/** 台本を段落に分けて p1, p2 … を付ける。空行で分け、空行が無ければ行で分ける。 */
export function splitScript(text: string): SlideParagraph[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  let parts = normalized.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
  if (parts.length === 1 && parts[0]!.includes('\n')) parts = parts[0]!.split('\n').map(line => line.trim()).filter(Boolean);
  if (parts.length > SLIDES_MAX_PARAGRAPHS) throw new SequenceError('INVALID_RANGE', `段落は ${SLIDES_MAX_PARAGRAPHS} までです（${parts.length}）`);
  return parts.map((part, index) => {
    if (part.length > SLIDES_MAX_PARAGRAPH_CHARS) throw new SequenceError('INVALID_RANGE', `段落 p${index + 1} が長すぎます（${SLIDES_MAX_PARAGRAPH_CHARS} 文字まで）`);
    return { id: `p${index + 1}`, text: part };
  });
}

function textField(value: unknown, path: string, label: string, max: number, required: boolean, key: string | undefined, out: SlideIssue[]): void {
  if (value === undefined || value === '') { if (required) out.push(issue(path, 'REQUIRED', `${label}がありません`, key)); return; }
  if (typeof value !== 'string') { out.push(issue(path, 'SHAPE', `${label}は文字列にしてください`, key)); return; }
  if (/[\r\n]/.test(value)) out.push(issue(path, 'SHAPE', `${label}に改行は入れられません`, key));
  const length = graphemeLength(stripEmphasis(value));
  if (stripEmphasis(value).includes('**')) out.push(issue(path, 'EMPHASIS', `${label}の強調（**語**）の ** が対になっていません`, key));
  if (length > max) out.push(issue(path, 'TOO_LONG', `${label}が長すぎます（${length} 文字。${max} 文字まで）`, key));
}
/** 強調語（**語**）は 1 ページ 2 語まで。 */
export const SLIDES_MAX_EMPHASIS = 2;
function collectTexts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectTexts);
  return record(value) ? Object.values(value).flatMap(collectTexts) : [];
}
/** レイアウト別の入力型（fields）の検証。項目・必須・文字数・件数・知らない項目を見る。 */
export function fieldIssues(layout: SlideLayoutId, fields: unknown, path: string, key?: string): SlideIssue[] {
  const spec = SLIDE_LAYOUTS[layout], out: SlideIssue[] = [];
  if (!record(fields)) return [issue(path, 'SHAPE', 'fields はオブジェクトにしてください', key)];
  const names = spec.fields.map(field => field.name);
  for (const name of Object.keys(fields)) {
    if (out.length >= SLIDES_MAX_ISSUES) break;
    if (!names.includes(name)) out.push(issue(`${path}.${show(name)}`, 'UNKNOWN_FIELD', `「${spec.name}」に ${show(name)} という項目はありません（使える項目: ${names.join('・')}）`, key));
  }
  for (const field of spec.fields) {
    const value = fields[field.name], at = `${path}.${field.name}`;
    if (field.kind === 'text') textField(value, at, field.label, field.maxChars, field.required, key, out);
    else if (field.kind === 'list') {
      if (!Array.isArray(value)) { out.push(issue(at, value === undefined ? 'REQUIRED' : 'SHAPE', `${field.label}は文字列の配列にしてください`, key)); continue; }
      if (value.length < field.min || value.length > field.max) out.push(issue(at, 'COUNT', `${field.label}は ${field.min}〜${field.max} 件です（${value.length} 件）`, key));
      if (value.length > field.max) continue;
      value.forEach((item: unknown, index: number) => textField(item, `${at}[${index}]`, `${field.label} ${index + 1}`, field.maxChars, true, key, out));
    } else {
      if (!record(value)) { out.push(issue(at, value === undefined ? 'REQUIRED' : 'SHAPE', `${field.label}は {"title", "body"} にしてください`, key)); continue; }
      for (const name of Object.keys(value)) {
        if (out.length >= SLIDES_MAX_ISSUES) break;
        if (name !== 'title' && name !== 'body') out.push(issue(`${at}.${show(name)}`, 'UNKNOWN_FIELD', `${field.label}に ${show(name)} という項目はありません`, key));
      }
      textField(value.title, `${at}.title`, `${field.label}の題`, field.titleChars, true, key, out);
      textField(value.body, `${at}.body`, `${field.label}の本文`, field.bodyChars, true, key, out);
    }
  }
  const emphasized = collectTexts(fields).reduce((sum, text) => sum + emphasisCount(text), 0);
  if (emphasized > SLIDES_MAX_EMPHASIS) out.push(issue(path, 'EMPHASIS', `強調（**語**）は 1 ページ ${SLIDES_MAX_EMPHASIS} 語までです（${emphasized} 語）。減らしてください`, key));
  return capIssues(out, path);
}

/** 構成案の形・段落の実在・key の重複（文書の検証でも使う）。全段落を網羅しているかは coverageIssues。 */
export function outlineStructureIssues(script: SlideScript, pages: unknown, glossary: unknown): SlideIssue[] {
  const out: SlideIssue[] = [], paragraphs = new Set(script.paragraphs.map(paragraph => paragraph.id)), keys = new Set<string>();
  if (!Array.isArray(pages)) return [issue('pages', 'SHAPE', 'pages は配列にしてください')];
  if (pages.length < 1 || pages.length > SLIDES_MAX_PAGES) out.push(issue('pages', 'COUNT', `ページは 1〜${SLIDES_MAX_PAGES} です（${pages.length}）`));
  if (pages.length > SLIDES_MAX_PAGES) return out;
  pages.forEach((raw: unknown, index: number) => {
    const at = `pages[${index}]`;
    if (!record(raw)) { out.push(issue(at, 'SHAPE', 'ページは {"key", "layout", "title", "sourceParagraphIds"} にしてください')); return; }
    const key = typeof raw.key === 'string' && OUTLINE_KEY.test(raw.key) ? raw.key : undefined;
    for (const name of Object.keys(raw)) if (out.length < SLIDES_MAX_ISSUES && !['key', 'layout', 'title', 'sourceParagraphIds'].includes(name)) out.push(issue(`${at}.${show(name)}`, 'UNKNOWN_FIELD', `${show(name)} という項目はありません`, key));
    if (!key) out.push(issue(`${at}.key`, 'SHAPE', 'key は英数字と - の 40 文字以内にしてください'));
    else if (keys.has(key)) out.push(issue(`${at}.key`, 'DUPLICATE', `key「${key}」が重複しています`, key));
    else keys.add(key);
    if (!SLIDE_LAYOUT_IDS.includes(raw.layout as SlideLayoutId)) out.push(issue(`${at}.layout`, 'UNKNOWN_LAYOUT', `知らないレイアウト「${show(raw.layout)}」です（使えるもの: ${LAYOUT_LIST}）`, key));
    textField(raw.title, `${at}.title`, '題', 60, true, key, out);
    const sources = raw.sourceParagraphIds;
    if (!Array.isArray(sources) || sources.some(id => typeof id !== 'string')) out.push(issue(`${at}.sourceParagraphIds`, 'SHAPE', 'sourceParagraphIds は段落番号（p1 など）の配列にしてください', key));
    else if (sources.length > script.paragraphs.length) out.push(issue(`${at}.sourceParagraphIds`, 'COUNT', `段落番号は ${script.paragraphs.length} 件までです（${sources.length} 件）`, key));
    else sources.forEach((id: string, n: number) => { if (!paragraphs.has(id)) out.push(issue(`${at}.sourceParagraphIds[${n}]`, 'UNKNOWN_PARAGRAPH', `存在しない段落「${show(id)}」です`, key)); });
  });
  if (out.length > SLIDES_MAX_ISSUES) return capIssues(out);
  if (!Array.isArray(glossary) || glossary.length > 100) out.push(issue('glossary', 'SHAPE', 'glossary は 100 件までの配列にしてください'));
  else glossary.forEach((entry: unknown, index: number) => {
    if (!record(entry) || Object.keys(entry).some(name => name !== 'term' && name !== 'note')) { out.push(issue(`glossary[${index}]`, 'SHAPE', '用語は {"term", "note"} にしてください')); return; }
    textField(entry.term, `glossary[${index}].term`, '用語', 40, true, undefined, out);
    textField(entry.note, `glossary[${index}].note`, '用語の注記', 120, false, undefined, out);
  });
  return capIssues(out);
}
/** 全段落がどれか 1 ページだけに入っているか（欠落・重複なし）。 */
export function coverageIssues(script: SlideScript, pages: readonly SlideOutlinePage[]): SlideIssue[] {
  const owners = new Map<string, string[]>(), out: SlideIssue[] = [];
  for (const page of pages) for (const id of page.sourceParagraphIds) owners.set(id, [...(owners.get(id) ?? []), page.key]);
  for (const paragraph of script.paragraphs) {
    const keys = owners.get(paragraph.id) ?? [];
    if (!keys.length) out.push(issue('pages', 'MISSING', `段落「${paragraph.id}」がどのページにも入っていません`));
    else if (keys.length > 1) out.push(issue('pages', 'DUPLICATE', `段落「${paragraph.id}」が ${keys.length} つのページ（${keys.join('・')}）に入っています`));
  }
  return out;
}
/** 構成案（harness-slides-outline/1）の検証。通れば正規化した構成案を返す。 */
export function validateOutline(script: SlideScript, payload: unknown): { outline: SlideOutline | null; issues: SlideIssue[] } {
  if (!script.paragraphs.length) return { outline: null, issues: [issue('script', 'REQUIRED', '台本がありません。先に台本を段落に分けてください')] };
  if (!record(payload)) return { outline: null, issues: [issue('', 'SHAPE', '構成案は JSON のオブジェクトにしてください')] };
  const issues: SlideIssue[] = [];
  if (payload.schema !== SLIDES_OUTLINE_SCHEMA) issues.push(issue('schema', 'SCHEMA_VERSION', `schema は「${SLIDES_OUTLINE_SCHEMA}」にしてください（「${show(payload.schema)}」は使えません）`));
  for (const name of Object.keys(payload)) if (issues.length < SLIDES_MAX_ISSUES && !['schema', 'pages', 'glossary'].includes(name)) issues.push(issue(show(name), 'UNKNOWN_FIELD', `${show(name)} という項目はありません`));
  issues.push(...outlineStructureIssues(script, payload.pages, payload.glossary ?? []));
  if (!issues.length) issues.push(...coverageIssues(script, payload.pages as SlideOutlinePage[]));
  if (issues.length) return { outline: null, issues: capIssues(issues) };
  return { outline: { schema: SLIDES_OUTLINE_SCHEMA, pages: structuredClone(payload.pages as SlideOutlinePage[]), glossary: structuredClone((payload.glossary ?? []) as SlideGlossaryEntry[]) }, issues };
}

export interface PageBodyCheck { index: number; key: string | null; body: SlidePageBody | null; issues: SlideIssue[] }
/** ページ本文（harness-slides-page/1 の配列）の検証。ページごとに合否を出す（成功したページだけ採用できる）。 */
export function validatePageBodies(document: SlideDocument, payload: unknown, options: { regenerate: boolean }): { requestIssues: SlideIssue[]; pages: PageBodyCheck[] } {
  const generation = document.generation;
  if (!generation || !generation.confirmed || (generation.status !== 'generating' && generation.status !== 'complete'))
    return { requestIssues: [issue('', 'RUN_STATE', '構成案が確定していないか、生成が中止されています')], pages: [] };
  if (!Array.isArray(payload)) return { requestIssues: [issue('', 'SHAPE', 'ページ本文は配列で渡してください')], pages: [] };
  if (payload.length < 1 || payload.length > SLIDES_MAX_PAGES_PER_REQUEST)
    return { requestIssues: [issue('', 'TOO_MANY', `1 回に渡せるページは 1〜${SLIDES_MAX_PAGES_PER_REQUEST} です（${payload.length}）`)], pages: [] };
  const seen = new Set<string>();
  const pages = payload.map((raw: unknown, index: number): PageBodyCheck => {
    const at = `[${index}]`, issues: SlideIssue[] = [];
    if (!record(raw)) return { index, key: null, body: null, issues: [issue(at, 'SHAPE', 'ページ本文はオブジェクトにしてください')] };
    const key = typeof raw.key === 'string' && raw.key.length <= 40 ? raw.key : null, k = key ?? undefined;
    if (raw.schema !== SLIDES_PAGE_SCHEMA) issues.push(issue(`${at}.schema`, 'SCHEMA_VERSION', `schema は「${SLIDES_PAGE_SCHEMA}」にしてください（「${show(raw.schema)}」は使えません）`, k));
    for (const name of Object.keys(raw)) if (issues.length < SLIDES_MAX_ISSUES && !['schema', 'key', 'layout', 'fields', 'notes', 'imageSlots'].includes(name)) issues.push(issue(`${at}.${show(name)}`, 'UNKNOWN_FIELD', `${show(name)} という項目はありません`, k));
    const entry = key ? generation.outline.find(page => page.key === key) : undefined;
    if (!key || !entry) issues.push(issue(`${at}.key`, 'UNKNOWN_KEY', `構成案に key「${show(raw.key)}」はありません`, k));
    else if (seen.has(key)) issues.push(issue(`${at}.key`, 'DUPLICATE', `key「${key}」が 1 回の要求に 2 回あります`, key));
    else {
      seen.add(key);
      if (generation.pages.find(page => page.key === key)?.status === 'generated' && !options.regenerate)
        issues.push(issue(`${at}.key`, 'ALREADY_GENERATED', `key「${key}」は生成済みです（作り直す時は regenerate を指定）`, key));
    }
    const layout = SLIDE_LAYOUT_IDS.includes(raw.layout as SlideLayoutId) ? raw.layout as SlideLayoutId : null;
    if (!layout) issues.push(issue(`${at}.layout`, 'UNKNOWN_LAYOUT', `知らないレイアウト「${show(raw.layout)}」です（使えるもの: ${LAYOUT_LIST}）`, k));
    else if (entry && entry.layout !== layout) issues.push(issue(`${at}.layout`, 'LAYOUT_MISMATCH', `構成案のレイアウト「${entry.layout}」と違います`, k));
    if (layout) issues.push(...fieldIssues(layout, raw.fields, `${at}.fields`, k));
    if (typeof raw.notes !== 'string') issues.push(issue(`${at}.notes`, 'REQUIRED', '話すメモ（notes）は文字列にしてください（無ければ空の文字列）', k));
    else if (graphemeLength(raw.notes) > SLIDES_MAX_NOTES_CHARS) issues.push(issue(`${at}.notes`, 'TOO_LONG', `話すメモが長すぎます（${SLIDES_MAX_NOTES_CHARS} 文字まで）`, k));
    const slots = raw.imageSlots ?? [];
    if (!Array.isArray(slots)) issues.push(issue(`${at}.imageSlots`, 'SHAPE', 'imageSlots は配列にしてください', k));
    else if (slots.length > SLIDES_MAX_IMAGE_SLOT_REQUESTS) issues.push(issue(`${at}.imageSlots`, 'COUNT', `画像枠の指定は ${SLIDES_MAX_IMAGE_SLOT_REQUESTS} 件までです（${slots.length} 件）。同じ枠は 1 回だけ指定できます`, k));
    else slots.forEach((slot: unknown, n: number) => {
      const sat = `${at}.imageSlots[${n}]`;
      if (!record(slot) || Object.keys(slot).some(name => !['slot', 'prompt', 'file'].includes(name))) { issues.push(issue(sat, 'SHAPE', '画像枠は {"slot", "prompt", "file"} にしてください', k)); return; }
      if (!layout || !SLIDE_LAYOUTS[layout].imageSlots.includes(String(slot.slot))) issues.push(issue(`${sat}.slot`, 'IMAGE_SLOT', `このレイアウトに画像枠「${show(slot.slot)}」はありません`, k));
      else if (slots.findIndex((other: unknown) => record(other) && other.slot === slot.slot) !== n) issues.push(issue(`${sat}.slot`, 'DUPLICATE', `画像枠「${show(slot.slot)}」が重複しています`, k));
      textField(slot.prompt, `${sat}.prompt`, '画像の説明', 400, true, k, issues);
      if (slot.file !== undefined && (typeof slot.file !== 'string' || !/^(\/|[A-Za-z]:\\).+\.(png|jpe?g|webp)$/i.test(slot.file)))
        issues.push(issue(`${sat}.file`, 'IMAGE_SLOT', '画像ファイルは PNG・JPEG・WebP の絶対パスにしてください', k));
    });
    if (issues.length) return { index, key, body: null, issues: capIssues(issues, at) };
    return { index, key, issues, body: { schema: SLIDES_PAGE_SCHEMA, key: key!, layout: layout!, fields: structuredClone(raw.fields) as SlideFields,
      notes: raw.notes as string, imageSlots: structuredClone(slots) as SlideImageSlotRequest[] } };
  });
  return { requestIssues: [], pages };
}
/** 保存済みの本文（置き換え案）の形。key とレイアウトは構成案と一致し、画像ファイルのパスは持たない。 */
export function storedBodyIssues(body: unknown, key: string, layout: SlideLayoutId): SlideIssue[] {
  if (!record(body) || Object.keys(body).some(name => !['schema', 'key', 'layout', 'fields', 'notes', 'imageSlots'].includes(name))) return [issue('', 'SHAPE', '本文の形が不正です', key)];
  const out: SlideIssue[] = [];
  if (body.schema !== SLIDES_PAGE_SCHEMA || body.key !== key || body.layout !== layout) out.push(issue('', 'SHAPE', '本文の版・key・レイアウトが構成案と合いません', key));
  out.push(...fieldIssues(layout, body.fields, 'fields', key));
  if (typeof body.notes !== 'string' || body.notes.length > SLIDES_MAX_NOTES_CHARS) out.push(issue('notes', 'SHAPE', '話すメモが不正です', key));
  if (!Array.isArray(body.imageSlots) || body.imageSlots.some((slot: unknown) => !record(slot) || Object.keys(slot).some(name => name !== 'slot' && name !== 'prompt')
    || !SLIDE_LAYOUTS[layout].imageSlots.includes(String(slot.slot)) || typeof slot.prompt !== 'string')) out.push(issue('imageSlots', 'SHAPE', '画像枠の指定が不正です', key));
  return out;
}
