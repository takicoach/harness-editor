/**
 * 版を上げるだけでは互換は守れない（Codex (e)）。実効を持たせるのは
 * ①backfill が不明版を最新と推定しないこと ②更新は明示ボタンだけで起きること
 * ③旧資産が残って複数版が共存すること、の 3 点。
 */
import {createHash} from 'node:crypto';
import {mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {BUILTIN_TELOP_PACK_ID, BUILTIN_TELOP_PACK_VERSION, KNOWN_BUILTIN_PACK_STORED_HASHES,
  UNKNOWN_TELOP_PACK_VERSION} from './telopPack/identity';
import {backfillTextStyleCatalog, prepareNativeTextStyles, textStyleAssetsToRegister} from './sequence/textStyles';
import {planTelopPackUpdate} from './telopPackUpdate';
import {fixture} from '../core/sequence/fixtures';
import {DEFAULT_TEXT_APPEARANCE} from '../core/sequence/model';
import {validateSequenceDocument} from '../core/sequence/validate';
import type {SequenceAsset, SequenceDocument} from '../core/sequence/model';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, {recursive: true, force: true}); });
const project = (): string => { const dir = mkdtempSync(join(tmpdir(), 'telop-pack-update-')); directories.push(dir); return dir; };

/** 文書の中の builtin 資産だけを組み立てる軽い作り（凍結はしない）。 */
const builtinAsset = (version: string): SequenceAsset => ({
  id: `component-${version}`, kind: 'component', file: `.harness/components/${version}.mjs`,
  name: 'テロップスタイル', fingerprint: version.padEnd(64, '0'), streams: [],
  textStyleCatalog: {source: 'builtin', packId: BUILTIN_TELOP_PACK_ID, version,
    componentHash: '0123456789abcdef', entries: [{id: 1, name: 'スタイル 1', animations: ['none', 'slideIn']}]},
} as unknown as SequenceAsset);
const oldBuiltin = (): SequenceAsset => builtinAsset('1.0.0');
const newBuiltin = (): SequenceAsset => builtinAsset(BUILTIN_TELOP_PACK_VERSION);

/**
 * 識別情報を落とした pre-T0b 相当の資産を作る。`readSequenceComponent` は
 * `hash(bytes) !== asset.fingerprint` を例外にするので（`components.ts:127`）、
 * バイトを差し替えるときは fingerprint と file も一緒に付け替える。
 */
const staleWithBytes = (dir: string, asset: SequenceAsset, bytes: Uint8Array): SequenceAsset => {
  const fingerprint = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(dir, '.harness/components', `${fingerprint}.mjs`), bytes);
  return {...asset, fingerprint, file: `.harness/components/${fingerprint}.mjs`,
    textStyleCatalog: {source: 'builtin' as const, entries: asset.textStyleCatalog!.entries}} as SequenceAsset;
};

describe('版', () => {
  it('1.1.0 のまま（上げたのは Task 5。ここでは動かさない）', () => {
    expect(BUILTIN_TELOP_PACK_VERSION).toBe('1.1.0');
  });

  it('既知の版の表に 1.0.0 と 1.1.0 の両方がある', () => {
    expect(new Set(Object.values(KNOWN_BUILTIN_PACK_STORED_HASHES))).toEqual(new Set(['1.0.0', '1.1.0']));
  });
});

describe('backfill は不明版を最新と推定しない（Codex P1-6）', () => {
  it('表に無い保存バイトの旧 builtin 資産は version:"unknown" になる', async () => {
    const dir = project();
    const asset = await prepareNativeTextStyles(dir);
    const stale = staleWithBytes(dir, asset, new TextEncoder().encode('export const Telop=()=>null;\n'));
    const filled = await backfillTextStyleCatalog(dir, stale);
    expect(filled.textStyleCatalog!.version).toBe(UNKNOWN_TELOP_PACK_VERSION);
    expect(filled.textStyleCatalog!.packId).toBe(BUILTIN_TELOP_PACK_ID);
  });

  it('"unknown" はスキーマを通る（validate.ts:102 の書式）', async () => {
    // `validate.ts:62-70` は schemaVersion:2 / id / name / background / transitions / transcripts / ducking を
    // 必須にするので、手書きリテラルでは `not.toThrow()` が必ず落ちる（事前検査 B の F9-4）。
    // `src/core/sequence/fixtures` の `fixture()` を土台にして assets へ**足す**
    // （差し替えると fixture のクリップが参照する media 資産が消えて素材参照の検査で落ちる）。
    const base = fixture();
    const asset = await prepareNativeTextStyles(project());
    const document = {...base,
      assets: [...base.assets, {...asset, textStyleCatalog: {...asset.textStyleCatalog!, version: UNKNOWN_TELOP_PACK_VERSION}}]};
    expect(() => validateSequenceDocument(document)).not.toThrow();
  });
});

describe('選択の副作用で文書を書き換えない（既往の規律）', () => {
  it('同じカタログで 2 回 prepare しても登録対象は空になる', async () => {
    const dir = project();
    const asset = await prepareNativeTextStyles(dir);
    const document = {revision: 1, assets: [asset], clips: []} as unknown as SequenceDocument;
    expect(textStyleAssetsToRegister(document, [asset])).toEqual([]);
  });

  it('版が上がっても登録対象にならない（更新は明示ボタン経由のみ）', async () => {
    const dir = project();
    const asset = await prepareNativeTextStyles(dir);
    const old = {...asset, textStyleCatalog: {...asset.textStyleCatalog!, version: '1.0.0'}};
    const document = {revision: 1, assets: [old], clips: []} as unknown as SequenceDocument;
    // 既存資産は 1.0.0（old）のまま、prepared 側だけ現行版（asset=1.1.0）にする。
    // CATALOG_IDENTITY_KEYS に version 差を足すと、ここが非空になって「選択だけで dirty」になる。
    expect(textStyleAssetsToRegister(document, [asset])).toEqual([]);
  });
});

describe('検知（plan）', () => {
  /** `planTelopPackUpdate` は**同期**（compile も store もしない。F9-2）。 */
  const telop = (id: string, assetId: string, data: Record<string, unknown>) =>
    ({id, content: {kind: 'telop', textMode: 'component', componentAssetId: assetId, data}});

  it('版が現行と同じなら null（更新できるものが無い）', async () => {
    const dir = project();
    const asset = await prepareNativeTextStyles(dir);
    const document = {...fixture(), assets: [asset],
      clips: [telop('c1', asset.id, {template: 1, animation: 'slideIn'})]} as unknown as SequenceDocument;
    expect(planTelopPackUpdate(dir, document)).toEqual({plan: null, reason: 'up-to-date'});
  });

  it('plan はプロジェクトに 1 バイトも書かない（読み取りのはずの操作）', async () => {
    const dir = project();
    const asset = await prepareNativeTextStyles(dir);
    const old = {...asset, id: 'old-asset', textStyleCatalog: {...asset.textStyleCatalog!, version: '1.0.0'}};
    const document = {...fixture(), assets: [old],
      clips: [telop('c1', 'old-asset', {template: 1, animation: 'slideIn'})]} as unknown as SequenceDocument;
    const before = readdirSync(join(dir, '.harness/components')).sort();
    planTelopPackUpdate(dir, document);
    planTelopPackUpdate(dir, document);
    expect(readdirSync(join(dir, '.harness/components')).sort()).toEqual(before);
  });

  it('版が違えば、対象字幕数と「新しく動き始める件数」を返す', async () => {
    const dir = project();
    const asset = await prepareNativeTextStyles(dir);
    const old = {...asset, id: 'old-asset', textStyleCatalog: {...asset.textStyleCatalog!, version: '1.0.0'}};
    const document = {...fixture(), assets: [old], clips: [
      telop('c1', 'old-asset', {template: 1, animation: 'slideIn'}),
      telop('c2', 'old-asset', {template: 1, animation: 'none'}),
      telop('c3', 'old-asset', {template: 1, animation: 'charByChar'}),
      // 別の部品（案件テンプレート由来）を参照する字幕。**この更新とは無関係**なので数えない。
      telop('c4', 'other-asset', {template: 1, animation: 'charByChar'}),
    ]} as unknown as SequenceDocument;
    const plan = planTelopPackUpdate(dir, document).plan!;
    expect(plan.fromVersion).toBe('1.0.0');
    expect(plan.toVersion).toBe('1.1.0');
    expect(plan.captionCount).toBe(3);
    // 「動きを失う 0 件」ではなく**逆向き**の数（Codex P1-5）: 7 種のいずれかを選んでいる字幕。
    expect(plan.gainingCount).toBe(1);
    // スタイル 1 は charByChar 非対応（T6）。更新すると選べなくなる字幕として数える。
    // **c4 は含めない**（無関係の部品を参照している。事前検査 B の F9-3）。
    expect(plan.losingClipIds).toEqual(['c3']);
  });

  it('version:"unknown" も更新候補になる', async () => {
    const dir = project();
    const asset = await prepareNativeTextStyles(dir);
    const old = {...asset, id: 'old-asset', textStyleCatalog: {...asset.textStyleCatalog!, version: 'unknown'}};
    const document = {...fixture(), assets: [old],
      clips: [telop('c1', 'old-asset', {template: 1, animation: 'slideIn'})]} as unknown as SequenceDocument;
    expect(planTelopPackUpdate(dir, document).plan?.fromVersion).toBe('unknown');
  });

  it('更新後（新旧が共存する文書）では null を返す（Codex P1-6・B9-2）', async () => {
    // `find(asset => …source === 'builtin')` は配列先頭＝**旧資産**を返し続けるので、旧実装では
    // 更新済みでも `fromVersion:'1.0.0'` の plan が出続け、もう一度 apply すると
    // `replace-text-style-asset` が MISSING_TARGET（`commands.ts:675`）で落ちる。
    const dir = project();
    const next = await prepareNativeTextStyles(dir);
    const old = {...next, id: 'old-asset', textStyleCatalog: {...next.textStyleCatalog!, version: '1.0.0'}};
    const document = {...fixture(), assets: [old, next],
      clips: [telop('c1', next.id, {template: 1, animation: 'slideIn'})]} as unknown as SequenceDocument;
    expect(planTelopPackUpdate(dir, document)).toEqual({plan: null, reason: 'up-to-date'});
  });

  it('新版が assets で先にあり両方が参照されていても、旧版が起点になる（Codex P2-1）', () => {
    // `find(asset => referenced.has(asset.id))` は**配列の最初の 1 件**なので、新版が先だと
    // 参照中の新版を掴んで plan が null ＝ 旧版の字幕が残っていても「最新です」になっていた。
    const dir = project();
    const document = {...fixture(),
      assets: [{...newBuiltin(), id: 'new-asset'}, {...oldBuiltin(), id: 'old-asset'}],
      clips: [telop('c1', 'new-asset', {template: 1, animation: 'slideIn'}),
        telop('c2', 'old-asset', {template: 1, animation: 'slideIn'})]} as unknown as SequenceDocument;
    const plan = planTelopPackUpdate(dir, document).plan!;
    expect(plan.assetId).toBe('old-asset');
    expect(plan.fromVersion).toBe('1.0.0');
    // 母集団は旧資産を参照している字幕だけ（新版の c1 は乗らない）。
    expect(plan.captionCount).toBe(1);
    expect(plan.gainingCount).toBe(1);
  });

  it('builtin 資産が 1 つも無い案件では null（全件通過に退化しない。レビュー I-1）', () => {
    // `builtinCaptions` が `!current` で全件通過していたため、案件テンプレート由来の字幕まで
    // captionCount / gainingCount に乗り、押しても何も切り替わらないのに「更新しました」が出ていた。
    // この状態は `textStylePreparation('needs-builtin')` が別導線として区別している実在の状態。
    const dir = project();
    const document = {...fixture(), assets: [],
      clips: [telop('c1', 'template-asset', {template: 1, animation: 'slideIn'}),
        telop('c2', 'template-asset', {template: 1, animation: 'fadeFromLeft'})]} as unknown as SequenceDocument;
    expect(planTelopPackUpdate(dir, document)).toEqual({plan: null, reason: 'not-adopted'});
  });

  it('クリップが旧資産を参照したままなら、共存していても更新候補になる', () => {
    // 「参照されている builtin」を起点にする、の裏側。register だけ済んで replace が失敗した状態。
    const dir = project();
    const document = {...fixture(),
      assets: [{...oldBuiltin(), id: 'old-asset'}, {...newBuiltin(), id: 'new-asset'}],
      clips: [telop('c1', 'old-asset', {template: 1, animation: 'slideIn'})]} as unknown as SequenceDocument;
    expect(planTelopPackUpdate(dir, document).plan?.assetId).toBe('old-asset');
  });

  it('旧資産を参照する字幕が 0 件なら計画を返さない（apply が空集合で必ず落ちる経路。Codex 2 巡目 #4）', () => {
    // 全字幕が案件スタイルへ移ったあと、文書には旧 builtin 資産だけが残る。
    // 旧実装は captionCount:0 の計画を返し、押すと `replace-text-style-asset` が
    // 「切り替える字幕が見つかりません」（`commands.ts:676`）で**必ず**落ちていた。
    const dir = project();
    const document = {...fixture(), assets: [{...oldBuiltin(), id: 'old-asset'}],
      clips: [telop('c1', 'template-asset', {template: 1, animation: 'slideIn'})]} as unknown as SequenceDocument;
    const outcome = planTelopPackUpdate(dir, document);
    expect(outcome).toEqual({plan: null, reason: 'no-captions'});
    // 画面が apply へ進む条件は `plan` が真であること。計画が無い＝apply に到達しない。
    expect(outcome.plan).toBeNull();
  });

  it('自由書式の字幕は件数の母集団に入れない（最終レビュー N-1・Codex 2 巡目 #6）', () => {
    // NativeText が描いている字幕は、スタイル部品を差し替えても 1 ピクセルも変わらない。
    // 旧実装は旧 builtin 資産＋`slideIn` の自由書式字幕を「動き始める」に数えていた。
    const dir = project();
    const free = (id: string, assetId: string, data: Record<string, unknown>) =>
      ({id, content: {kind: 'telop', textMode: 'free', componentAssetId: assetId, data,
        appearance: {...DEFAULT_TEXT_APPEARANCE}}});
    const document = {...fixture(), assets: [{...oldBuiltin(), id: 'old-asset'}], clips: [
      telop('c1', 'old-asset', {template: 1, animation: 'slideIn'}),
      free('c2', 'old-asset', {template: 1, animation: 'slideIn'}),
      free('c3', 'old-asset', {template: 1, animation: 'charByChar'}),
    ]} as unknown as SequenceDocument;
    const plan = planTelopPackUpdate(dir, document).plan!;
    expect(plan.captionCount).toBe(1);
    expect(plan.gainingCount).toBe(1);
    // charByChar の c3 は自由書式なので「使えなくなる」警告にも出さない。
    expect(plan.losingClipIds).toEqual([]);
  });

  it('自由書式しか参照していなくても計画は出る（参照は切り替わるので apply は成功する）', () => {
    // 母集団（#6）と「切替の相手がいるか」（#4）は別の問い。`replace-text-style-asset` は
    // 自由書式の字幕の参照も動かすので、ここで計画を消すと更新できない案件が生まれる。
    const dir = project();
    const document = {...fixture(), assets: [{...oldBuiltin(), id: 'old-asset'}],
      clips: [{id: 'c1', content: {kind: 'telop', textMode: 'free', componentAssetId: 'old-asset',
        data: {template: 1, animation: 'slideIn'}, appearance: {...DEFAULT_TEXT_APPEARANCE}}}],
    } as unknown as SequenceDocument;
    const plan = planTelopPackUpdate(dir, document).plan!;
    expect(plan.assetId).toBe('old-asset');
    expect(plan.captionCount).toBe(0);
  });
});
