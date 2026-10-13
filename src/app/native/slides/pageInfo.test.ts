import { describe, expect, it } from 'vitest';
import { applySlideCommand } from '../../../core/slides/commands';
import { splitScript } from '../../../core/slides/contract';
import { pageBody, scriptText } from '../../../core/slides/fixtures';
import { emptySlideDocument } from '../../../core/slides/model';
import { pageGenerationInfo, proposalSummary } from './pageInfo';

function generated() {
  let document = emptySlideDocument('slides-i'); document.script = { paragraphs: splitScript(scriptText(3)) };
  document = applySlideCommand(document, { type: 'set-outline', runId: 'r1', glossary: [], model: null, outline: [{ key: 's1', layout: 'compare', title: '比較', sourceParagraphIds: ['p1', 'p2', 'p3'] }] });
  document = applySlideCommand(document, { type: 'confirm-outline' });
  return applySlideCommand(document, { type: 'apply-page-bodies', runId: 'r1', failures: [], model: null, bodies: [{ body: pageBody('s1', 'compare'), images: {} }] });
}
describe('ページの情報', () => {
  it('構成案の key・状態・作り直せるか', () => {
    const document = generated();
    expect(pageGenerationInfo(document, document.pages[0]!)).toEqual({ key: 's1', status: 'generated', reasons: [], proposal: null, canRegenerate: true });
    expect(pageGenerationInfo(document, { ...document.pages[0]!, outlineKey: undefined })).toMatchObject({ key: null, canRegenerate: false });
  });
  it('置き換え案の要約（題・見出し・項目・左右）', () => {
    expect(proposalSummary({ body: pageBody('s1', 'compare'), images: {} })).toEqual(['良い例と悪い例', '良い例：肩の力が抜けている', '悪い例：腕だけで振っている']);
    expect(proposalSummary({ body: pageBody('s2', 'points'), images: {} })).toEqual(['握り方のコツ', '左手から握る', '親指は少し右', '力は 3 割']);
  });
});
