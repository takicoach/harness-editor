import { describe, expect, it } from 'vitest';
import { validateSequenceDocument } from '../sequence/validate';
import { videoFrameLayer } from '../thumbnail/fixtures';
import { pageBody, SLIDE_IMAGE_ASSET, slidesFixture } from './fixtures';
import type { SlideDocument } from './model';
import { slidePageToSequence } from './pageView';
import { parseSlides, serializeSlides, slideContentBytes, validateSlideDocument } from './validate';

const broken = (change: (document: SlideDocument) => void) => { const document = slidesFixture(); change(document); return () => validateSlideDocument(document); };
const cases: Array<[string, (document: SlideDocument) => void, string]> = [
  ['キャンバスが 1920×1080 でない', d => { d.canvas = { width: 1280, height: 720 }; }, 'キャンバスの大きさが不正です'],
  ['ページが 121', d => { d.pages = Array.from({ length: 121 }, (_, i) => ({ ...structuredClone(d.pages[0]!), id: `p${i}`, layers: [], bindings: {} })); }, 'ページは 120 までです'],
  ['1 ページのレイヤーが 41 以上', d => { const page = d.pages[1]!; for (let i = 0; i < 41; i++) page.layers.push({ ...structuredClone(page.layers[1]!), id: `extra-${i}` }); }, '1 ページに置けるレイヤーは 40 までです'],
  ['同梱でない書体の上書き', d => { d.theme = { id: 'forest-gold', overrides: { fonts: { body: 'system-gothic' } } }; }, 'スライドで使える書体は同梱の書体だけです'],
  ['動画のコマのレイヤー', d => { d.pages[1]!.layers.push(videoFrameLayer('frame')); }, 'スライドに置けるのは文字・画像・図形だけです'],
  ['結び付きの先のレイヤーが無い', d => { d.pages[1]!.bindings['ghost'] = { slot: 'heading' }; }, 'レイヤーの結び付きが不正です'],
  ['台本に無い段落を参照', d => { d.pages[1]!.sourceParagraphIds = ['p9']; }, '元の段落が台本にありません'],
  ['構成案が無いのに key を持つ', d => { d.pages[1]!.outlineKey = 's01'; }, '構成案に無いページです'],
  ['レイヤー ID の重複', d => { d.pages[0]!.layers.push(structuredClone(d.pages[1]!.layers[1]!)); }, 'レイヤーの ID が重複しています'],
  ['素材が画像でない', d => { d.assets.push({ ...SLIDE_IMAGE_ASSET, kind: 'media' }); }, 'スライドの素材が不正です'],
  ['生成の状態が構成案と合わない', d => { d.generation = { runId: 'r1', status: 'outline', confirmed: false, glossary: [], model: null,
    outline: [{ key: 's01', layout: 'cover', title: '題', sourceParagraphIds: ['p1'] }], pages: [] }; }, '生成の状態が構成案と合いません'],
  ['置き換え案の形が不正', d => { d.generation = { runId: 'r1', status: 'generating', confirmed: true, glossary: [], model: null,
    outline: [{ key: 's01', layout: 'points', title: '題', sourceParagraphIds: ['p1'] }],
    pages: [{ key: 's01', status: 'generated', pageId: null, reasons: [], proposal: { body: { ...pageBody('s01', 'points'), fields: { heading: '見出し' } as never }, images: {} } }] }; }, '置き換え案が不正です'],
];

describe('スライド文書の検証', () => {
  it('見本の文書は通り、直列化しても同じバイト列に戻る。内容のバイトは版を含まない', () => {
    const document = slidesFixture();
    expect(() => validateSlideDocument(document)).not.toThrow();
    const text = serializeSlides(document);
    expect(serializeSlides(parseSlides(text))).toBe(text);
    expect(slideContentBytes({ ...document, revision: 9 })).toBe(slideContentBytes(document));
  });
  it('各ページを 1 コマの描画用文書にできる（サムネの変換を流用）', () => {
    const document = slidesFixture(), sequence = slidePageToSequence(document, 'page-2');
    expect(() => validateSequenceDocument(sequence)).not.toThrow();
    expect(sequence.resolution).toEqual({ width: 1920, height: 1080 });
    expect(sequence.clips.map(clip => clip.id)).toEqual(document.pages[1]!.layers.map(layer => layer.id));
  });
  it.each(cases)('%s は拒否する', (_label, change, message) => { expect(broken(change)).toThrow(message); });
  it('生成の途中状態（構成案・置き換え案・ページとのつながり）を持てる。つながりが食い違えば拒否する', () => {
    const document = slidesFixture();
    document.generation = { runId: 'r1', status: 'generating', confirmed: true, glossary: [], model: 'claude',
      outline: [{ key: 's01', layout: 'points', title: '握り方', sourceParagraphIds: ['p1', 'p2', 'p3'] }],
      pages: [{ key: 's01', status: 'generated', pageId: 'page-2', reasons: [], proposal: { body: pageBody('s01', 'points'), images: {} } }] };
    document.pages[1]!.outlineKey = 's01'; document.pages[1]!.origin = 'ai';
    expect(() => validateSlideDocument(document)).not.toThrow();
    document.generation.pages[0]!.pageId = 'page-1';
    expect(() => validateSlideDocument(document)).toThrow('生成の状態とページが合いません');
  });
});
