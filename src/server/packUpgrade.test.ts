import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PACK_DESCRIPTORS, payloadHash, findDescriptor, isPackStale, isPackInstalled,
  upgradePack, checkStalePacks, upgradePacks, currentPackVersion,
} from './packUpgrade';
import { installVideoInsert } from './installVideoInsert';
import { installBgm } from './installBgm';
import { installShape } from './installShape';
import { installTransition } from './installTransition';
import { installTelopPack } from './installTelopPack';
import { TELOP_PACK } from './telopPack/manifest';

const VI = () => findDescriptor('videoInsert');

let proj: string;
beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'sme-pu-'));
});
afterEach(() => rmSync(proj, { recursive: true, force: true }));

/** プロジェクトに videoInsert パックを「古い marker（version 無し）」で用意する。 */
function installVideoInsertOld(): void {
  const dir = join(proj, 'src', 'InsertVideo');
  mkdirSync(dir, { recursive: true });
  // データファイルとユーザー編集の痕跡。
  writeFileSync(join(dir, 'insertVideoData.ts'), 'export const insertVideoData = [/* user */];', 'utf8');
  // version 無し marker（旧導入）。
  writeFileSync(join(dir, 'insert-video.json'), JSON.stringify({ feature: 'insert-video', installedAt: 'editor' }), 'utf8');
}

describe('payloadHash', () => {
  it('同一記述子で安定（決定的）', () => {
    expect(payloadHash(VI())).toBe(payloadHash(VI()));
  });
  it('データファイルとテストはハッシュに含めない（除外）', () => {
    // videoInsertPayload には insertVideoData.ts と InsertVideo.test.tsx がある。
    const entries = (PACK_DESCRIPTORS.find((d) => d.id === 'videoInsert')!);
    expect(entries.dataFiles).toContain('insertVideoData.ts');
    // ハッシュは安定値（16桁hex）。
    expect(payloadHash(VI())).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('isPackStale', () => {
  it('marker 無し（未導入）は古くない', () => {
    expect(isPackStale(VI(), proj)).toBe(false);
    expect(isPackInstalled(VI(), proj)).toBe(false);
  });
  it('version 無し marker は古い', () => {
    installVideoInsertOld();
    expect(isPackInstalled(VI(), proj)).toBe(true);
    expect(isPackStale(VI(), proj)).toBe(true);
  });
  it('現行版を書いた marker は古くない', () => {
    installVideoInsertOld();
    // 現行ハッシュへ更新。
    const mp = join(proj, 'src', 'InsertVideo', 'insert-video.json');
    writeFileSync(mp, JSON.stringify({ feature: 'insert-video', version: payloadHash(VI()) }), 'utf8');
    expect(isPackStale(VI(), proj)).toBe(false);
  });
});

describe('upgradePack', () => {
  it('部品を再コピーしデータを保持・marker version を更新', () => {
    installVideoInsertOld();
    upgradePack(VI(), proj);
    const dir = join(proj, 'src', 'InsertVideo');
    // 部品が入る（InsertVideo.tsx）。
    expect(existsSync(join(dir, 'InsertVideo.tsx'))).toBe(true);
    // テストは配らない。
    expect(existsSync(join(dir, 'InsertVideo.test.tsx'))).toBe(false);
    // データは保持（ユーザー痕跡が残る）。
    expect(readFileSync(join(dir, 'insertVideoData.ts'), 'utf8')).toContain('/* user */');
    // marker version が現行へ。
    expect(isPackStale(VI(), proj)).toBe(false);
  });
});

describe('checkStalePacks / upgradePacks', () => {
  it('古い videoInsert を検出し、更新で消える', () => {
    installVideoInsertOld();
    expect(checkStalePacks(proj)).toContain('videoInsert');
    const r = upgradePacks(proj, ['videoInsert']);
    expect(r.upgraded).toContain('videoInsert');
    expect(checkStalePacks(proj)).not.toContain('videoInsert');
  });
});

/** install が成立する最小 ハーネス形式プロジェクトを作る（MainVideo にアンカー有り）。 */
function makeMinimalProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sme-pu-inst-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'videoConfig.ts'), `export const VIDEO_FILE='main.mp4';`, 'utf8');
  writeFileSync(
    join(dir, 'src', 'MainVideo.tsx'),
    `import { AbsoluteFill } from 'remotion';\nimport { CutPlayer } from './CutPlayer';\nimport { TelopPlayer } from './テロップテンプレート';\nexport const MainVideo = () => (<AbsoluteFill><CutPlayer /><TelopPlayer /></AbsoluteFill>);\n`,
    'utf8',
  );
  return dir;
}

describe('install は marker に現行版を書く（install 直後は stale でない）', () => {
  it.each([
    ['videoInsert', installVideoInsert],
    ['bgm', installBgm],
    ['shape', installShape],
    ['transition', installTransition],
    ['telopPack', installTelopPack],
  ] as const)('%s', (id, install) => {
    const dir = makeMinimalProject();
    try {
      install(dir);
      expect(isPackStale(findDescriptor(id), dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('telopPack: 縮小方向の上書きを提示しない（旧35種パック導入済みの保護）', () => {
  const TELOP_MARKER = ['src', 'テロップテンプレート', 'telop-pack.json'] as const;
  const TELOP_COMPONENT = ['src', 'テロップテンプレート', 'Telop.tsx'] as const;
  const SENTINEL = '/* ここは旧パックの描画エンジン（35種対応） */';

  /**
   * telopPack を導入したうえで marker を任意の count / 古い version へ差し替え、
   * Telop.tsx にユーザー環境の目印を入れる（＝上書きされたら消える）。
   */
  function installTelopWithMarkerCount(count: number | undefined): string {
    const dir = makeMinimalProject();
    installTelopPack(dir);
    const marker: Record<string, unknown> = { pack: 'telop-templates', version: 'stale-old-version' };
    if (count !== undefined) marker.count = count;
    writeFileSync(join(dir, ...TELOP_MARKER), JSON.stringify(marker, null, 2), 'utf8');
    const componentPath = join(dir, ...TELOP_COMPONENT);
    writeFileSync(componentPath, `${SENTINEL}\n${readFileSync(componentPath, 'utf8')}`, 'utf8');
    return dir;
  }

  function withProject(count: number | undefined, body: (dir: string) => void): void {
    const dir = installTelopWithMarkerCount(count);
    try {
      body(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('同梱数(3)より多い count=35 の marker は stale としない（更新を提示しない）', () => {
    expect(TELOP_PACK.length).toBeLessThan(35);
    withProject(35, (dir) => {
      expect(isPackStale(findDescriptor('telopPack'), dir)).toBe(false);
      expect(checkStalePacks(dir)).not.toContain('telopPack');
    });
  });

  it('count=35 の marker では「部品の更新」を実行しても Telop.tsx が上書きされない', () => {
    withProject(35, (dir) => {
      const r = upgradePacks(dir, checkStalePacks(dir));
      expect(r.upgraded).not.toContain('telopPack');
      expect(readFileSync(join(dir, ...TELOP_COMPONENT), 'utf8')).toContain(SENTINEL);
    });
  });

  it('count が同梱数と同じなら従来どおり stale（更新できる）', () => {
    withProject(TELOP_PACK.length, (dir) => {
      expect(isPackStale(findDescriptor('telopPack'), dir)).toBe(true);
      expect(checkStalePacks(dir)).toContain('telopPack');
    });
  });

  it('count が同梱数より少ない（増加方向）なら従来どおり stale', () => {
    withProject(1, (dir) => {
      expect(isPackStale(findDescriptor('telopPack'), dir)).toBe(true);
    });
  });

  it('count が無い marker（旧導入）は従来どおり stale', () => {
    withProject(undefined, (dir) => {
      expect(isPackStale(findDescriptor('telopPack'), dir)).toBe(true);
    });
  });

  it('更新を実行したら marker の count も現在の同梱数へ揃える（縮小判定の材料を古いままにしない）', () => {
    // count=1（増加方向＝従来どおり stale）で更新すると、部品と marker が現行へ揃う。
    withProject(1, (dir) => {
      expect(upgradePacks(dir, checkStalePacks(dir)).upgraded).toContain('telopPack');
      const marker = JSON.parse(readFileSync(join(dir, ...TELOP_MARKER), 'utf8')) as { count?: number };
      expect(marker.count).toBe(TELOP_PACK.length);
      expect(isPackStale(findDescriptor('telopPack'), dir)).toBe(false);
    });
  });

  it('縮小防止は telopPack 限定（他パックの count は判定に影響しない）', () => {
    installVideoInsertOld();
    const mp = join(proj, 'src', 'InsertVideo', 'insert-video.json');
    writeFileSync(mp, JSON.stringify({ feature: 'insert-video', count: 999 }), 'utf8');
    expect(isPackStale(VI(), proj)).toBe(true);
  });
});

describe('speed pack (Plan 2)', () => {
  it('speed パックが登録され version を取得できる', () => {
    const d = findDescriptor('speed');
    expect(d.packDir).toBe('Speed');
    expect(d.markerName).toBe('speed.json');
    expect(typeof currentPackVersion('speed')).toBe('string');
    expect(currentPackVersion('speed').length).toBeGreaterThan(0);
  });
});
