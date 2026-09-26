import { describe, expect, it } from 'vitest';
import type { SequenceAsset, SequenceDocument } from '../../core/sequence/model';
import type { TextContent } from '../../core/sequence/textStyle';
import { applySequenceCommand } from '../../core/sequence/commands';
import { assetAnimationSupport, supportsAnimation, telopClipsLosingAnimation, textAnimationSupport } from './telopAnimationSupport';
import { fixture } from '../../core/sequence/fixtures';

const asset = (animations?: string[]): SequenceAsset => ({
  id: 'component-1', kind: 'component', name: 'テロップスタイル', fingerprint: 'abc',
  textStyleCatalog: { source: 'project', entries: [{ id: 1, name: 'スタイル 1' }], ...(animations ? { animations } : {}) },
} as SequenceAsset);

describe('動きの対応表', () => {
  it('宣言が無い資産は不明＝全種非対応（9 種対応とみなさない）', () => {
    const support = assetAnimationSupport(asset());
    expect(support).toBeNull();
    for (const id of ['none', 'fadeOnly', 'popIn'] as const) expect(supportsAnimation(support, id)).toBe(false);
  });

  it('宣言した種だけを対応とする', () => {
    const support = assetAnimationSupport(asset(['none', 'fadeOnly']));
    expect(supportsAnimation(support, 'fadeOnly')).toBe(true);
    expect(supportsAnimation(support, 'popIn')).toBe(false);
  });

  it('資産そのものが無ければ不明', () => {
    expect(assetAnimationSupport(undefined)).toBeNull();
  });

  it('自由な書式はリポジトリの実装なので常に 17 種対応', () => {
    const document = fixture();
    const content = { kind: 'telop' as const, textMode: 'free' as const, data: { text: 'x', animation: 'popIn' },
      appearance: { fontSize: 40 } } as never;
    const support = textAnimationSupport(document, content);
    expect(supportsAnimation(support, 'popIn')).toBe(true);
    expect(supportsAnimation(support, 'charByChar')).toBe(true);
  });

  it('移る先で動きを失う字幕だけを数える', () => {
    const document = fixture();
    const target = document.clips.find(clip => clip.content.kind === 'telop')!;
    (target.content as { data: { animation?: string } }).data.animation = 'popIn';
    // B6-2: 支援集合ではなく資産を渡す（スタイル単位の判定を中で行うため）。
    expect(telopClipsLosingAnimation(document, asset(['none', 'fadeOnly']))).toEqual([target.id]);
    expect(telopClipsLosingAnimation(document, asset(['none', 'popIn']))).toEqual([]);
    expect(telopClipsLosingAnimation(document, asset())).toEqual([target.id]);   // 宣言なし＝不明
  });

  it('動きが none／未設定の字幕は数えない', () => {
    const document = fixture();
    for (const clip of document.clips) if (clip.content.kind === 'telop') delete (clip.content as { data: { animation?: string } }).data.animation;
    expect(telopClipsLosingAnimation(document, asset())).toEqual([]);
  });
});

/**
 * ここから下は裁定 5（設計 §3.3 案 (ii)）。能力判定をスタイル単位にし、旧文書
 * （entries[].animations 未定義）はカタログ単位へフォールバックして今日と同じ挙動になること、までを固定する。
 * 上の `asset(animations?)` は「カタログ単位だけを持つ資産」の作り。こちらは entries も指定できる別の作り。
 */
const BUILTIN_NINE = ['none','slideIn','fadeOnly','slideFromLeft','fadeBlurFromBottom','slideLeftFadeBlur','fadeFromRight','fadeFromLeft','charByChar'];
const EIGHT = BUILTIN_NINE.filter(id => id !== 'charByChar');

function styledAsset(entries: {id: number; name: string; animations?: string[]}[], animations = BUILTIN_NINE): SequenceAsset {
  return {id: 'a1', kind: 'component', file: 'public/a1.tsx', name: 'テロップスタイル', fingerprint: 'f', streams: [],
    textStyleCatalog: {source: 'builtin', packId: 'harness.builtin', version: '1.1.0',
      componentHash: '0123456789abcdef', entries, animations}} as unknown as SequenceAsset;
}

describe('スタイル単位の能力', () => {
  const styled = styledAsset([
    {id: 1, name: '白文字黒シャドウ', animations: EIGHT},
    {id: 17, name: '白赤テロップ', animations: BUILTIN_NINE},
  ]);

  it('スタイル 17 は charByChar を名乗る', () => {
    expect(supportsAnimation(assetAnimationSupport(styled, 17), 'charByChar')).toBe(true);
  });

  it('スタイル 1 は charByChar を名乗らない', () => {
    expect(supportsAnimation(assetAnimationSupport(styled, 1), 'charByChar')).toBe(false);
  });

  it('7 種はどちらのスタイルでも使える', () => {
    for (const id of ['slideIn','slideFromLeft','fadeBlurFromBottom','slideLeftFadeBlur','fadeFromRight','fadeFromLeft','fadeOnly'] as const)
      for (const styleId of [1, 17])
        expect(supportsAnimation(assetAnimationSupport(styled, styleId), id), `${id}/t${styleId}`).toBe(true);
  });

  it('styleId を渡さなければカタログ単位（従来どおり）', () => {
    expect(supportsAnimation(assetAnimationSupport(styled), 'charByChar')).toBe(true);
  });

  it('一覧に無いスタイル番号はカタログ単位へ落ちる（推定しない）', () => {
    // このフォールバックが効くのは **UI 経路**（`data.template` が一覧外の旧文書）だけ。
    // `apply-text-style-all` は `commands.ts` の `entries.some(entry => entry.id === command.styleId)` で
    // 先に弾くので、一覧外の styleId はそもそも到達しない（事前検査 B の F6-4）。
    expect(supportsAnimation(assetAnimationSupport(styled, 99), 'charByChar')).toBe(true);
  });
});

describe('既存カタログの entries は register-assets で上書きされない（凍結資産の同一性・F6-2）', () => {
  it('animations を足した entries を送っても、既にあるカタログの entries は変わらない', () => {
    // これが「T6 単体では既存案件の挙動が変わらない」ことの機械的な根拠。
    // 変わるようになったら、凍結資産の同一性が崩れているので赤にする。
    const existing = styledAsset([{id: 1, name: 'スタイル 1'}]);   // 旧文書＝entries に animations が無い
    const document = fixture();
    document.assets.push(existing);
    const next = applySequenceCommand(document as SequenceDocument, {type: 'register-assets', assets: [{...existing,
      textStyleCatalog: {...existing.textStyleCatalog!, entries: [{id: 1, name: 'スタイル 1', animations: ['none']}]}}]});
    expect(next.assets.find(item => item.id === existing.id)!.textStyleCatalog!.entries[0]!.animations).toBeUndefined();
  });
});

describe('旧文書の互換（entries[].animations が無い）', () => {
  const legacy = styledAsset([{id: 1, name: 'スタイル 1'}, {id: 17, name: 'スタイル 17'}]);

  it('どのスタイルでもカタログ単位の集合になる（今日と同じ挙動）', () => {
    for (const styleId of [1, 17])
      expect(supportsAnimation(assetAnimationSupport(legacy, styleId), 'charByChar')).toBe(true);
  });

  it('宣言そのものが無い資産は「不明」＝全種非対応のまま', () => {
    const unknown = {...legacy, textStyleCatalog: {...legacy.textStyleCatalog!, animations: undefined}} as SequenceAsset;
    expect(assetAnimationSupport(unknown, 1)).toBeNull();
  });
});

describe('動きを失う字幕の数え方（スタイル単位）', () => {
  const styled = styledAsset([
    {id: 1, name: 'スタイル 1', animations: EIGHT},
    {id: 17, name: 'スタイル 17', animations: BUILTIN_NINE},
  ]);
  const document = {
    revision: 1, assets: [styled],
    clips: [
      {id: 'c1', content: {kind: 'telop', textMode: 'component', componentAssetId: 'a1', data: {template: 17, animation: 'charByChar'}}},
      {id: 'c2', content: {kind: 'telop', textMode: 'component', componentAssetId: 'a1', data: {template: 1, animation: 'charByChar'}}},
      {id: 'c3', content: {kind: 'telop', textMode: 'component', componentAssetId: 'a1', data: {template: 1, animation: 'none'}}},
      {id: 'c4', content: {kind: 'telop', textMode: 'component', componentAssetId: 'a1', data: {template: 1}}},
    ],
  } as unknown as SequenceDocument;

  it('スタイルを変えない切替では、非対応スタイルの charByChar だけを数える', () => {
    // 今日は「WhiteRed 以外の charByChar 字幕」を 0 件と数えていた（カタログ単位で可と見えるため）。
    expect(telopClipsLosingAnimation(document, styled)).toEqual(['c2']);
  });

  it('全体適用（styleId 固定）では、その 1 スタイルの能力で全件を数える', () => {
    expect(telopClipsLosingAnimation(document, styled, 1)).toEqual(['c1', 'c2']);
    expect(telopClipsLosingAnimation(document, styled, 17)).toEqual([]);
  });

  it('none と未設定は数えない', () => {
    expect(telopClipsLosingAnimation(document, styled, 1)).not.toContain('c3');
    expect(telopClipsLosingAnimation(document, styled, 1)).not.toContain('c4');
  });
});

describe('自由書式は常に 17 種（裁定 7 の告知の根拠）', () => {
  it('appearance を持つ字幕はスタイルの宣言を見ない', () => {
    const document = {assets: [], clips: []} as unknown as SequenceDocument;
    const content = {kind: 'telop', textMode: 'free', appearance: {},
      data: {text: 'x', template: 1, animation: 'charByChar'}} as unknown as TextContent;
    expect(supportsAnimation(textAnimationSupport(document, content), 'charByChar')).toBe(true);
  });
});
