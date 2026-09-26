/**
 * `upgradePack` は案件の実ファイルを cpSync で上書きする（実測）。控えが無いと戻せない。
 * `telopTemplateUpdate.ts:308-315,271-275` と**同じ作り**（触るファイルだけ複写・無かったファイルは
 * `<name>.absent` の印）にし、復元も同じ規則を共有する。保持は直前の 1 世代だけ（裁定 8）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PACK_BACKUP_ROOT, PACK_DESCRIPTORS, backupPackComponents, findDescriptor, isPackStale,
  latestPackBackupVersion, packUpgradeNotices, restorePackComponents, upgradePacks,
} from './packUpgrade';
import { countBuiltinTelopClipsGainingAnimation } from './telopPackUpdate';
import { fixture } from '../core/sequence/fixtures';
import { DEFAULT_TEXT_APPEARANCE } from '../core/sequence/model';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** 旧版のパックが入った案件を作る（telopLegacyAnimation.ts はまだ無い＝.absent 経路）。 */
function legacyProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pack-backup-'));
  directories.push(dir);
  const target = join(dir, 'src/テロップテンプレート');
  mkdirSync(join(target, 'styles'), { recursive: true });
  writeFileSync(join(target, 'Telop.tsx'), '// 旧版の本体\n', 'utf8');
  writeFileSync(join(target, 'styles/WhiteBlue.tsx'), '// 旧版のスタイル\n', 'utf8');
  writeFileSync(join(target, 'telop-pack.json'), JSON.stringify({ pack: 'telop-templates', version: 'old' }), 'utf8');
  return dir;
}

describe('控えと復元', () => {
  it('更新の前に componentEntries の現物が控えへ退避される', () => {
    const dir = legacyProject();
    const before = readFileSync(join(dir, 'src/テロップテンプレート/Telop.tsx'), 'utf8');
    upgradePacks(dir, ['telopPack']);
    const version = latestPackBackupVersion(findDescriptor('telopPack'), dir)!;
    // 置き場は常に <root>/<packId>/<version>/ の 3 段（F10-2）。
    expect(readFileSync(join(dir, PACK_BACKUP_ROOT, 'telopPack', version, 'Telop.tsx'), 'utf8')).toBe(before);
  });

  it('無かったファイルは <name>.absent で覚える（telopLegacyAnimation.ts）', () => {
    const dir = legacyProject();
    upgradePacks(dir, ['telopPack']);
    const version = latestPackBackupVersion(findDescriptor('telopPack'), dir)!;
    expect(existsSync(join(dir, PACK_BACKUP_ROOT, 'telopPack', version, 'telopLegacyAnimation.ts.absent'))).toBe(true);
  });

  it('更新 → 復元 → 再更新 で案件ファイルがバイト一致に戻る', () => {
    const dir = legacyProject();
    const target = join(dir, 'src/テロップテンプレート');
    const original = readFileSync(join(target, 'Telop.tsx'), 'utf8');
    upgradePacks(dir, ['telopPack']);
    const upgraded = readFileSync(join(target, 'Telop.tsx'), 'utf8');
    expect(upgraded).not.toBe(original);
    restorePackComponents(findDescriptor('telopPack'), dir);
    expect(readFileSync(join(target, 'Telop.tsx'), 'utf8')).toBe(original);
    // 復元で新設ファイルが消える（.absent 経路）
    expect(existsSync(join(target, 'telopLegacyAnimation.ts'))).toBe(false);
    upgradePacks(dir, ['telopPack']);
    expect(readFileSync(join(target, 'Telop.tsx'), 'utf8')).toBe(upgraded);
  });

  it('フォルダの entry も更新前の中身ちょうどに戻る（更新で増えたスタイルが残らない）', () => {
    const dir = legacyProject();
    const styles = join(dir, 'src/テロップテンプレート/styles');
    expect(readdirSync(styles)).toEqual(['WhiteBlue.tsx']);
    const original = readFileSync(join(styles, 'WhiteBlue.tsx'), 'utf8');
    upgradePacks(dir, ['telopPack']);
    expect(readdirSync(styles).length).toBeGreaterThan(1);
    restorePackComponents(findDescriptor('telopPack'), dir);
    expect(readdirSync(styles)).toEqual(['WhiteBlue.tsx']);
    expect(readFileSync(join(styles, 'WhiteBlue.tsx'), 'utf8')).toBe(original);
  });

  it('控えは直前の 1 世代だけ残る（裁定 8）', () => {
    const dir = legacyProject();
    upgradePacks(dir, ['telopPack']);
    // 版を偽って 2 回目の更新を起こす
    writeFileSync(join(dir, 'src/テロップテンプレート/telop-pack.json'), JSON.stringify({ version: 'older' }), 'utf8');
    upgradePacks(dir, ['telopPack']);
    // **telopPack の下だけ**を数える。root 直下を数えると、将来 payloadDir を持つパックが増えた
    // 瞬間に誤検知で赤になる（F10-2）。
    expect(readdirSync(join(dir, PACK_BACKUP_ROOT, 'telopPack'))).toHaveLength(1);
    expect(latestPackBackupVersion(findDescriptor('telopPack'), dir)).toBe('older');
  });

  /** 案件の外（`base/outside/`）と案件の中（`<案件>/victim/`）の両方に人質を置いた案件。
   *  marker の `version` は手で編集できるので、控えの宛先に経路文字が混じり得る（レビュー C2）。 */
  function traversalProject(version: string): { base: string; dir: string } {
    const base = mkdtempSync(join(tmpdir(), 'pack-backup-outside-'));
    directories.push(base);
    const dir = join(base, 'project');
    const target = join(dir, 'src/テロップテンプレート');
    mkdirSync(join(target, 'styles'), { recursive: true });
    writeFileSync(join(target, 'Telop.tsx'), '// 旧版の本体\n', 'utf8');
    writeFileSync(join(target, 'styles/WhiteBlue.tsx'), '// 旧版のスタイル\n', 'utf8');
    writeFileSync(join(target, 'telop-pack.json'), JSON.stringify({ pack: 'telop-templates', version }), 'utf8');
    mkdirSync(join(base, 'outside'), { recursive: true });
    writeFileSync(join(base, 'outside/important.txt'), '案件の外', 'utf8');
    mkdirSync(join(dir, 'victim'), { recursive: true });
    writeFileSync(join(dir, 'victim/important.txt'), '案件の中', 'utf8');
    return { base, dir };
  }

  // 実測: 検査が無いと `version: "../../../victim"` の案件を更新しただけで `<案件>/victim/` が
  // まるごと消えた（レビュー C2 の再現③）。削除は不可逆なので宛先は検査済みの名前だけで組む。
  it.each(['../../../victim', '../../../../outside', '..', '.', 'ま/../..'])(
    'marker の版名に経路文字があっても控えの外を消さず、控えは unknown に入る（%s）', (version) => {
      const { base, dir } = traversalProject(version);
      upgradePacks(dir, ['telopPack']);
      expect(readFileSync(join(base, 'outside/important.txt'), 'utf8')).toBe('案件の外');
      expect(readFileSync(join(dir, 'victim/important.txt'), 'utf8')).toBe('案件の中');
      expect(readdirSync(join(dir, PACK_BACKUP_ROOT, 'telopPack'))).toEqual(['unknown']);
      expect(latestPackBackupVersion(findDescriptor('telopPack'), dir)).toBe('unknown');
    });

  it('更新の後に足した自作ファイルは復元で消えない（消すのは更新が持ち込んだ分だけ）', () => {
    const dir = legacyProject();
    const target = join(dir, 'src/テロップテンプレート');
    const original = readFileSync(join(target, 'styles/WhiteBlue.tsx'), 'utf8');
    upgradePacks(dir, ['telopPack']);
    const brought = readdirSync(join(target, 'styles')).find((name) => name !== 'WhiteBlue.tsx')!;
    writeFileSync(join(target, 'styles/MyOwn.tsx'), '// 自作スタイル\n', 'utf8');
    mkdirSync(join(target, 'styles/sub'), { recursive: true });
    writeFileSync(join(target, 'styles/sub/deep.txt'), '自作の中身\n', 'utf8');
    restorePackComponents(findDescriptor('telopPack'), dir);
    // 控えにも payload にも無い＝利用者が後から足したものは残る（戻す先が無いので消してはいけない）。
    expect(readFileSync(join(target, 'styles/MyOwn.tsx'), 'utf8')).toBe('// 自作スタイル\n');
    expect(readFileSync(join(target, 'styles/sub/deep.txt'), 'utf8')).toBe('自作の中身\n');
    // 更新が持ち込んだスタイルは消え、控えのバイトが戻る。
    expect(existsSync(join(target, 'styles', brought))).toBe(false);
    expect(readFileSync(join(target, 'styles/WhiteBlue.tsx'), 'utf8')).toBe(original);
    expect(existsSync(join(target, 'telopLegacyAnimation.ts'))).toBe(false);
    expect(readdirSync(join(target, 'styles')).sort()).toEqual(['MyOwn.tsx', 'WhiteBlue.tsx', 'sub']);
  });

  it('stale でない id を 2 回渡しても、本当の「更新前」の控えが残る', () => {
    const dir = legacyProject();
    const target = join(dir, 'src/テロップテンプレート');
    const original = readFileSync(join(target, 'Telop.tsx'), 'utf8');
    upgradePacks(dir, ['telopPack']);
    upgradePacks(dir, ['telopPack']);   // 2 回目は stale でない＝何もしない
    expect(latestPackBackupVersion(findDescriptor('telopPack'), dir)).toBe('old');
    expect(readFileSync(join(dir, PACK_BACKUP_ROOT, 'telopPack', 'old', 'Telop.tsx'), 'utf8')).toBe(original);
    restorePackComponents(findDescriptor('telopPack'), dir);
    expect(readFileSync(join(target, 'Telop.tsx'), 'utf8')).toBe(original);
  });

  it('復元に成功したら控えを畳む（⚠ の入口が恒久的に残らない）', () => {
    const dir = legacyProject();
    const d = findDescriptor('telopPack');
    upgradePacks(dir, ['telopPack']);
    expect(latestPackBackupVersion(d, dir)).toBe('old');
    restorePackComponents(d, dir);
    // 案件は更新前と同じ姿なので戻る先は要らない → `/api/pack-status` の `revertable` が false になる。
    expect(latestPackBackupVersion(d, dir)).toBeNull();
    expect(() => restorePackComponents(d, dir)).toThrowError(/backup-missing/);
  });

  it('控えが無い状態の復元は backup-missing', () => {
    const dir = legacyProject();
    expect(() => restorePackComponents(findDescriptor('telopPack'), dir)).toThrowError(/backup-missing/);
  });

  it('復元すると marker は控えの版に戻り、再び「古い」と判定される（更新ボタンが出る）', () => {
    const dir = legacyProject();
    const d = findDescriptor('telopPack');
    expect(isPackStale(d, dir)).toBe(true);
    upgradePacks(dir, ['telopPack']);
    expect(isPackStale(d, dir)).toBe(false);
    const result = restorePackComponents(d, dir);
    expect(result.version).toBe('old');
    expect(result.restored).toContain('Telop.tsx');
    expect(isPackStale(d, dir)).toBe(true);
  });

  it('退避は単体でも呼べる（apply 失敗時の復旧と同じ関数を共有する）', () => {
    const dir = legacyProject();
    const saved = backupPackComponents(findDescriptor('telopPack'), dir, 'manual');
    expect(saved).toContain('Telop.tsx');
    expect(saved).toContain('telopLegacyAnimation.ts.absent');
    expect(latestPackBackupVersion(findDescriptor('telopPack'), dir)).toBe('manual');
  });
});

describe('事前説明のための情報', () => {
  it('telopPack descriptor が「描画が変わる」と説明文を持つ', () => {
    const descriptor = PACK_DESCRIPTORS.find(item => item.id === 'telopPack')!;
    expect(descriptor.drawingChanges).toBe(true);
    expect(descriptor.changeNote).toContain('動き');
  });

  it('他のパックは drawingChanges を持たない（説明が出しっぱなしにならない）', () => {
    for (const descriptor of PACK_DESCRIPTORS.filter(item => item.id !== 'telopPack'))
      expect(descriptor.drawingChanges, descriptor.id).toBeUndefined();
  });

  it('upgradePacks は**戻れる先**（更新前の版）を返す（画面が「戻す」を出せる）', () => {
    // 旧稿は `payloadHash(d)`＝更新**後**の版を期待値に固定していた（F10-1）。画面が「戻す」を
    // 出す材料として要るのは控えの版なので、`latestPackBackupVersion` と同じ値でなければならない。
    const dir = legacyProject();
    const result = upgradePacks(dir, ['telopPack']);
    expect(result.upgraded).toEqual(['telopPack']);
    expect(result.backups.telopPack).toBe('old');   // legacyProject の telop-pack.json が名乗る版
    expect(result.backups.telopPack).toBe(latestPackBackupVersion(findDescriptor('telopPack'), dir));
  });

  it('系統 A（Remotion 案件）では「動き始める件数」は null が既定（推定しない）', () => {
    // `SequenceStore` が読むのは native の `.harness/project.v2.json`。Remotion 運用のままの案件には
    // それが無いので、件数は数えられない。**黙って 0 を返さない**（0 件と読める報告になる）。
    // 画面側は「この案件では数えられません」と出す（F10-3。受け入れ条件から件数は外す）。
    const dir = legacyProject();
    const notices = packUpgradeNotices(dir, ['telopPack']);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.gainingCount).toBeNull();
    expect(notices[0]!.note).toContain('動き');
  });

  it('Remotion 一括更新の件数は案件テンプレート側を数える（native 側の字幕は乗らない。レビュー I-2）', () => {
    // この導線が差し替えるのは `src/テロップテンプレート/` のファイルなので、動きが付くのは
    // **案件フォルダの部品を参照している字幕**。builtin 凍結資産を参照している字幕は何も変わらない。
    // 母集団を 1 本の関数へ統合していたとき（旧 `countTelopClipsGainingAnimation`）は逆側を数えていた。
    // fixture は混在（builtin 2 / 案件テンプレート 1 が旧アニメ）で、両側の期待値が**違う数**になる。
    const dir = legacyProject();
    const base = fixture();
    const catalog = { source: 'builtin' as const, packId: 'harness.builtin', version: '1.0.0',
      entries: [{ id: 1, name: 'スタイル 1', animations: ['none', 'slideIn'] }] };
    const component = (id: string, source: 'builtin' | 'project') => ({
      id, kind: 'component' as const, file: `.harness/components/${id}.mjs`, name: 'テロップスタイル',
      fingerprint: id.padEnd(64, '0'), streams: [], textStyleCatalog: { ...catalog, source },
    });
    const telop = (id: string, assetId: string, animation: string, startFrame: number) => ({
      id, name: '字幕', trackId: 'v2', startFrame, durationFrames: 30,
      clock: { offset: { num: 0, den: 1 }, rate: { num: 1, den: 1 }, duration: { num: 30, den: 1 } },
      content: { kind: 'telop', textMode: 'component', componentAssetId: assetId,
        data: { text: '字幕', template: 1, animation } },
    });
    const free = (id: string, assetId: string, animation: string, startFrame: number) => {
      const clip = telop(id, assetId, animation, startFrame);
      return { ...clip, content: { ...clip.content, textMode: 'free',
        appearance: { ...DEFAULT_TEXT_APPEARANCE } } };
    };
    const document = { ...base, assets: [...base.assets, component('builtin-asset', 'builtin'), component('template-asset', 'project')],
      clips: [
        // builtin 側（native 3 段導線の母集団）: 旧アニメ 2 件。
        telop('c1', 'builtin-asset', 'slideIn', 0),
        telop('c4', 'builtin-asset', 'fadeFromLeft', 90),
        telop('c2', 'builtin-asset', 'none', 30),         // 旧アニメではない
        // 案件テンプレート側（この導線の母集団）: 旧アニメ 1 件。
        telop('c3', 'template-asset', 'slideIn', 60),
        // 自由書式（NativeText 描画）の字幕は**どちらの母集団にも入らない** — 部品を差し替えても
        // 見た目が変わらないのに「動き始める」に数えられていた（最終レビュー N-1・Codex 2 巡目 #6）。
        free('c5', 'template-asset', 'slideIn', 120),
        free('c6', 'builtin-asset', 'slideIn', 150),
      ] };
    mkdirSync(join(dir, '.harness'), { recursive: true });
    writeFileSync(join(dir, '.harness/project.v2.json'),
      JSON.stringify({ format: 'harness-sequence', version: 2, document, receipts: [] }), 'utf8');
    const notices = packUpgradeNotices(dir, ['telopPack']);
    // Remotion 側は案件テンプレート由来の 1 件。
    expect(notices[0]!.gainingCount).toBe(1);
    // native 側は builtin 資産を参照する 2 件。**数が違う**ので、母集団の取り違えは緑にならない。
    const builtin = document.assets.find(asset => asset.id === 'builtin-asset')!;
    expect(countBuiltinTelopClipsGainingAnimation(document as never, builtin as never)).toBe(2);
  });

  it('描画が変わらないパックには説明を出さない', () => {
    const dir = legacyProject();
    expect(packUpgradeNotices(dir, ['bgm', 'shape'])).toEqual([]);
  });
});
