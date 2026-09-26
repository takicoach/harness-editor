import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import type { SequenceAsset } from '../../core/sequence/model';
import { fixture } from '../../core/sequence/fixtures';
import { applySequenceCommand } from '../../core/sequence/commands';
import { declaredTextStyleIds, prepareNativeTextStyles, textStyleAssetsToRegister } from './textStyles';

function componentAsset(id: string, catalog: SequenceAsset['textStyleCatalog'] | undefined): SequenceAsset {
  return { id, kind: 'component', file: `public/${id}.mjs`, name: id, fingerprint: `fp-${id}`, streams: [], textStyleCatalog: catalog };
}

const builtinCatalog: NonNullable<SequenceAsset['textStyleCatalog']> = {
  source: 'builtin', packId: 'editor-telop', version: '1', componentHash: '0000000000000000', entries: [{ id: 1, name: 'A' }],
};
const projectCatalog: NonNullable<SequenceAsset['textStyleCatalog']> = {
  source: 'project', packId: 'project-styles', version: 'fp-existing', componentHash: '1111111111111111', entries: [{ id: 1, name: 'B' }],
};

describe('textStyleAssetsToRegister', () => {
  it('全部が登録済みでカタログも揃っていれば、登録は不要', () => {
    const doc = fixture();
    doc.assets.push(componentAsset('builtin', builtinCatalog), componentAsset('existing', projectCatalog));
    const prepared = [componentAsset('builtin', builtinCatalog), componentAsset('existing', projectCatalog)];
    expect(textStyleAssetsToRegister(doc, prepared)).toEqual([]);
  });

  it('builtin が未登録なら builtin だけを対象にする', () => {
    const doc = fixture();
    doc.assets.push(componentAsset('existing', projectCatalog));
    const prepared = [componentAsset('builtin', builtinCatalog), componentAsset('existing', projectCatalog)];
    expect(textStyleAssetsToRegister(doc, prepared)).toEqual([componentAsset('builtin', builtinCatalog)]);
  });

  // I-6: pre-T0b の案件（カタログはあるが packId/version/componentHash が無い）。
  it('必須3項目が欠けた旧カタログは 1 回目で補い、2 回目は差分なし（冪等）', () => {
    const legacyCatalog: NonNullable<SequenceAsset['textStyleCatalog']> = { source: 'project', entries: [{ id: 1, name: 'B' }] };
    const doc = fixture();
    doc.assets.push(componentAsset('builtin', builtinCatalog), componentAsset('existing', legacyCatalog));
    const prepared = [componentAsset('builtin', builtinCatalog), componentAsset('existing', projectCatalog)];
    const first = textStyleAssetsToRegister(doc, prepared);
    expect(first).toEqual([componentAsset('existing', projectCatalog)]);
    const registered = applySequenceCommand(doc, { type: 'register-assets', assets: first });
    expect(registered.revision).toBe(doc.revision + 1);
    const filled = registered.assets.find(asset => asset.id === 'existing')!.textStyleCatalog!;
    expect(filled).toEqual({ ...legacyCatalog, packId: 'project-styles', version: 'fp-existing', componentHash: '1111111111111111' });
    // entries と source は補完で書き換わらない。
    expect(filled.entries).toEqual(legacyCatalog.entries);
    expect(textStyleAssetsToRegister(registered, prepared)).toEqual([]);
    expect(applySequenceCommand(registered, { type: 'register-assets', assets: prepared }).revision).toBe(registered.revision);
  });

  it('既に入っている識別子は、違う値が来ても上書きしない', () => {
    const doc = fixture();
    doc.assets.push(componentAsset('existing', { ...projectCatalog, componentHash: undefined }));
    const incoming = componentAsset('existing', { ...projectCatalog, packId: 'other-pack', componentHash: '2222222222222222' });
    const registered = applySequenceCommand(doc, { type: 'register-assets', assets: [incoming] });
    const filled = registered.assets.find(asset => asset.id === 'existing')!.textStyleCatalog!;
    expect(filled.packId).toBe('project-styles');
    expect(filled.componentHash).toBe('2222222222222222');
  });

  it('既存の component にカタログが無ければ、その1件だけを対象にする', () => {
    const doc = fixture();
    doc.assets.push(componentAsset('builtin', builtinCatalog), componentAsset('existing', undefined));
    const prepared = [componentAsset('builtin', builtinCatalog), componentAsset('existing', projectCatalog)];
    expect(textStyleAssetsToRegister(doc, prepared)).toEqual([componentAsset('existing', projectCatalog)]);
  });
});

const dir = resolve(import.meta.dirname, '../../../project-template/src/テロップテンプレート');
const telop = readFileSync(resolve(dir, 'Telop.tsx'), 'utf8');

describe('project template text styles', () => {
  it('reads TEMPLATE_MAP keys from a compiled component that looks styles up by segment.template', () => {
    const compiled = `const a={},b={},c={};const TEMPLATE_MAP={1:a,2:b,22:c};
export function Telop({segment}){const style=TEMPLATE_MAP[segment.template]??a;return style;}`;
    expect(declaredTextStyleIds(compiled)).toEqual([1, 2, 22]);
  });

  it('still reads the legacy .template===N and switch forms', () => {
    expect(declaredTextStyleIds('export function T({segment}){if(segment.template===3)return 1;switch(segment.template){case 5:return 2;}}')).toEqual([3, 5]);
  });

  it('renders every declared field of TelopStyleConfig somewhere in Telop.tsx', () => {
    const types = readFileSync(resolve(dir, 'telopTypes.ts'), 'utf8');
    const block = types.match(/export interface TelopStyleConfig \{[\s\S]*?\n\}/)![0];
    // name は表示用ラベル。highlight は製品（Brain）側の Telop.tsx でも描画に使われていない
    // 既存の未使用フィールドなので、どちらも「移植漏れ」の指標にならない。裁定 3 は Brain 版の
    // 描画結果を正とするため、ここで highlight の描画を発明すると逆に正から外れる。
    const fields = [...block.matchAll(/^\s+([a-zA-Z]+)\??:/gm)].map(m => m[1]).filter(f => f !== 'name' && f !== 'highlight');
    for (const field of fields) expect(telop, `${field} は描画で参照されていない`).toMatch(new RegExp(`\\.${field}\\b|\\b${field}\\s*[,}]`));
  });

  // 位置クランプ・モーションの配線が残っているかは captureRuntime/telopMotionDrift.test.ts が
  // 見る（ソース検査に加えて、統合前の受け入れ参照との描画比較まで行う）。ここでは重ねない。

  it('telopData.ts が指定する全 template 番号が TEMPLATE_MAP に実在する', () => {
    const telopDataPath = resolve(dir, 'telopData.ts');
    const telopData = readFileSync(telopDataPath, 'utf8');
    const templateNumbers = [...telopData.matchAll(/template:\s*(\d+)/g)].map(m => Number(m[1]));

    const templateMapMatch = telop.match(/const TEMPLATE_MAP[\s\S]*?\n};/);
    expect(templateMapMatch).toBeTruthy();
    const mapKeys = [...templateMapMatch![0].matchAll(/^\s+(\d+):/gm)].map(m => Number(m[1]));
    const mapSet = new Set(mapKeys);

    for (const template of templateNumbers) {
      expect(mapSet.has(template), `template ${template} は TEMPLATE_MAP に存在しない`).toBe(true);
    }
  });
});

describe('能力宣言がカタログへ届く', () => {
  it('同梱パックは既存 9 種を名乗る（新 8 種は名乗らない）', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'harness-animations-'));
    const asset = await prepareNativeTextStyles(directory);
    expect(asset.textStyleCatalog?.animations).toEqual(
      ['none','slideIn','fadeOnly','slideFromLeft','fadeBlurFromBottom','slideLeftFadeBlur','fadeFromRight','fadeFromLeft','charByChar']);
    expect(asset.textStyleCatalog?.animations).not.toContain('popIn');
  });

  it('register-assets は欠けている animations だけを補い、入っている値は上書きしない', () => {
    // ブリーフの fixture() は component 種の素材を持たないため、componentAsset ヘルパで作る。
    const base = fixture();
    const withoutAnimations = componentAsset('telop-style', { source: 'project', entries: [{ id: 1, name: 'スタイル 1' }] });
    const seeded = applySequenceCommand(base, { type: 'register-assets', assets: [withoutAnimations] });
    const filled = applySequenceCommand(seeded, { type: 'register-assets',
      assets: [{ ...withoutAnimations, textStyleCatalog: { ...withoutAnimations.textStyleCatalog!, animations: ['none'] } }] });
    expect(filled.assets.find(item => item.id === withoutAnimations.id)!.textStyleCatalog!.animations).toEqual(['none']);
    const again = applySequenceCommand(filled, { type: 'register-assets',
      assets: [{ ...withoutAnimations, textStyleCatalog: { ...withoutAnimations.textStyleCatalog!, animations: ['none','popIn'] } }] });
    expect(again.assets.find(item => item.id === withoutAnimations.id)!.textStyleCatalog!.animations).toEqual(['none']);
  });
});
