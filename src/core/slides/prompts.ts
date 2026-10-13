import { SequenceError } from '../sequence/errors';
import { placeholderFields } from './build';
import { SLIDES_OUTLINE_SCHEMA, SLIDES_PAGE_SCHEMA } from './contract';
import { SLIDE_LAYOUTS, type FieldSpec } from './layouts';
import { SLIDE_LAYOUT_IDS, SLIDES_MAX_NOTES_CHARS, SLIDES_MAX_PAGES, SLIDES_MAX_PAGES_PER_REQUEST, type SlideDocument } from './model';

function fieldText(field: FieldSpec): string {
  if (field.kind === 'text') return `"${field.name}": 文字（${field.label}・${field.maxChars} 文字まで${field.required ? '' : '・省略可'}）`;
  if (field.kind === 'list') return `"${field.name}": 文字の配列（${field.label}・${field.min}〜${field.max} 件・各 ${field.maxChars} 文字まで）`;
  return `"${field.name}": {"title": ${field.titleChars} 文字まで, "body": ${field.bodyChars} 文字まで}（${field.label}）`;
}
/** レイアウト 6 種の入力型と上限（依頼文に入れる）。 */
export function layoutCatalogText(): string {
  return SLIDE_LAYOUT_IDS.map(id => {
    const spec = SLIDE_LAYOUTS[id];
    return `- ${id}（${spec.name}・${spec.summary}）: ${spec.fields.map(fieldText).join('、')}${spec.imageSlots.length ? `。画像枠: ${spec.imageSlots.join('・')}` : ''}`;
  }).join('\n');
}
/** 構成案の依頼文。 */
export function outlineRequestText(document: SlideDocument): string {
  if (!document.script.paragraphs.length) throw new SequenceError('MISSING_TARGET', '台本がありません。先に台本を段落に分けてください');
  return [
    'あなたはセミナー用スライドの構成担当です。下の台本（段落に番号付き）から、スライドの構成案を作ってください。',
    '答えは JSON だけにしてください（説明の文章やコードの囲みは付けない）。',
    '',
    '# 形式',
    `{"schema":"${SLIDES_OUTLINE_SCHEMA}","pages":[{"key":"s01","layout":"cover","title":"題","sourceParagraphIds":["p1"]}],"glossary":[{"term":"用語","note":"表記の決まり"}]}`,
    '',
    '# 守ること',
    '- すべての段落を、どれか 1 つのページの sourceParagraphIds に入れる（抜けも重複もなし）。',
    `- ページは ${SLIDES_MAX_PAGES} まで。key は英数字と - の 40 文字以内で、ページごとに違うものにする。title は 60 文字以内。`,
    '- layout は次の 6 種から選ぶ（本文はあとで別に頼みます。ここでは選ぶだけ）。',
    layoutCatalogText(),
    '- 数字・比較・手順は文字と図形で見せるので、画像に頼らない構成にする。',
    '- glossary には、台本で表記がゆれそうな用語と決めた書き方を入れる（無ければ空の配列）。',
    '',
    '# 台本',
    ...document.script.paragraphs.map(paragraph => `${paragraph.id}: ${paragraph.text}`),
  ].join('\n');
}
/** 次に頼むページ（待ちと失敗から、構成案の順に）。 */
export function nextPendingKeys(document: SlideDocument, limit = SLIDES_MAX_PAGES_PER_REQUEST - 2): string[] {
  return document.generation?.pages.filter(page => page.status === 'pending' || page.status === 'failed').slice(0, limit).map(page => page.key) ?? [];
}
/** 本文の依頼文。各回に全体の構成案と用語表を入れ、元段落は頼むページの分だけ入れる。 */
export function pagesRequestText(document: SlideDocument, keys: readonly string[], options: { regenerate?: boolean; shorten?: boolean } = {}): string {
  const generation = document.generation;
  if (!generation || !generation.confirmed) throw new SequenceError('MISSING_TARGET', '構成案が確定していません');
  const wanted = generation.outline.filter(entry => keys.includes(entry.key));
  if (!wanted.length || wanted.length > SLIDES_MAX_PAGES_PER_REQUEST) throw new SequenceError('INVALID_RANGE', `頼めるページは 1〜${SLIDES_MAX_PAGES_PER_REQUEST} です`);
  const ids = new Set(wanted.flatMap(entry => entry.sourceParagraphIds)), first = wanted[0]!;
  const example = { schema: SLIDES_PAGE_SCHEMA, key: first.key, layout: first.layout, fields: placeholderFields(first.layout), notes: 'このページで話すこと',
    imageSlots: SLIDE_LAYOUTS[first.layout].imageSlots.map(slot => ({ slot, prompt: 'どんな画像か' })) };
  return [
    `あなたはセミナー用スライドの本文担当です。下の構成案のうち、key が「${wanted.map(entry => entry.key).join('・')}」のページの本文を作ってください。`,
    '答えは JSON の配列だけにしてください（説明の文章やコードの囲みは付けない）。',
    ...(options.shorten ? ['このページは文字が枠に収まっていません。意味を変えずに、上限より短くしてください。'] : []),
    ...(options.regenerate ? ['これは作り直しです。構成案の題と元の段落に沿って、前より伝わりやすくしてください。'] : []),
    '',
    '# 1 ページの形式（例）',
    JSON.stringify(example),
    '',
    '# 守ること',
    '- layout は構成案と同じにする。fields は次のレイアウト別の形にし、文字数・件数の上限を守る。改行は入れない。',
    layoutCatalogText(),
    '- 強調したい語は文字の中で **語** と書く。強調は 1 ページ 1〜2 語まで（3 語以上は直す対象）。',
    '- 用語は用語表の書き方にそろえる。',
    `- notes には、そのページで話す内容を ${SLIDES_MAX_NOTES_CHARS} 文字以内で書く。`,
    '- 画像枠のあるレイアウトは imageSlots に {"slot":"image","prompt":"どんな画像か"} を書く（画像そのものは作らなくてよい。あとで画面から取り込めます）。',
    '',
    '# 構成案（全体）',
    ...generation.outline.map(entry => `${entry.key} ${entry.layout}「${entry.title}」段落 ${entry.sourceParagraphIds.join('・')}`),
    '',
    '# 用語表',
    ...(generation.glossary.length ? generation.glossary.map(entry => `- ${entry.term}${entry.note ? `（${entry.note}）` : ''}`) : ['なし']),
    '',
    '# 元の段落（今回のページの分だけ）',
    ...document.script.paragraphs.filter(paragraph => ids.has(paragraph.id)).map(paragraph => `${paragraph.id}: ${paragraph.text}`),
  ].join('\n');
}
