import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installBgm, isBgmInstalled } from './installBgm';

let dir: string;
const MAIN_VIDEO = `import { AbsoluteFill } from 'remotion';
import { SESequence } from './SoundEffects/SESequence';
import { CutPlayer } from './CutPlayer';

export const MainVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <CutPlayer />
      <SESequence />
    </AbsoluteFill>
  );
};
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sme-bgm-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'videoConfig.ts'), `export const VIDEO_FILE = 'main.mp4';`, 'utf8');
  writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO, 'utf8');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('installBgm', () => {
  it('非プロジェクト（videoConfig 無し）は 400 で中断', () => {
    rmSync(join(dir, 'src', 'videoConfig.ts'));
    expect(() => installBgm(dir)).toThrow();
    expect(isBgmInstalled(dir)).toBe(false);
  });

  it('部品をコピーし MainVideo に BgmSequence を SESequence 直前へ挿入する', () => {
    const r = installBgm(dir);
    expect(r.installed).toBe(true);
    expect(existsSync(join(dir, 'src', 'Bgm', 'BgmSequence.tsx'))).toBe(true);
    expect(existsSync(join(dir, 'src', 'Bgm', 'bgm-track.json'))).toBe(true);
    expect(existsSync(join(dir, 'src', 'MainVideo.original.bak.tsx'))).toBe(true);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain("import { BgmSequence } from './Bgm';");
    // SESequence の前に挿入されている
    expect(mv.indexOf('<BgmSequence')).toBeLessThan(mv.indexOf('<SESequence'));
  });

  it('冪等: 2回呼んでも壊れない', () => {
    installBgm(dir);
    const once = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    installBgm(dir);
    const twice = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(twice).toBe(once); // 二重挿入しない
    expect(isBgmInstalled(dir)).toBe(true);
  });

  it('アンカー（SESequence も AbsoluteFill も）が無ければ中断（marker を書かない）', () => {
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), `export const MainVideo = () => null;`, 'utf8');
    expect(() => installBgm(dir)).toThrow();
    expect(isBgmInstalled(dir)).toBe(false);
    // ファイルシステムに副作用が無いことを確認
    expect(existsSync(join(dir, 'src', 'Bgm'))).toBe(false);
    expect(existsSync(join(dir, 'src', 'MainVideo.original.bak.tsx'))).toBe(false);
  });

  it('バックアップ既存時は上書きしない', () => {
    const bakPath = join(dir, 'src', 'MainVideo.original.bak.tsx');
    writeFileSync(bakPath, 'EXISTING_BAK', 'utf8');
    installBgm(dir);
    expect(readFileSync(bakPath, 'utf8')).toBe('EXISTING_BAK');
  });

  it('保存先行（bgmData.ts 既存）でも部品一式をコピーし、既存データは保持する', () => {
    // BGM→保存を install より先に行うと src/Bgm/bgmData.ts が先に作られる。
    // install が「ディレクトリ存在＝導入済み」と見なして部品コピーをスキップすると、
    // BgmSequence.tsx / index.ts / types.ts が無いまま marker と import だけ書かれ壊れる。
    const destDir = join(dir, 'src', 'Bgm');
    mkdirSync(destDir, { recursive: true });
    const userData = '// USER SAVED DATA\nexport const bgmData = [{ id: 1 }];\n';
    writeFileSync(join(destDir, 'bgmData.ts'), userData, 'utf8');

    const r = installBgm(dir);
    expect(r.installed).toBe(true);
    // 部品一式がコピーされている
    expect(existsSync(join(destDir, 'BgmSequence.tsx'))).toBe(true);
    expect(existsSync(join(destDir, 'index.ts'))).toBe(true);
    expect(existsSync(join(destDir, 'types.ts'))).toBe(true);
    // ユーザーの保存済みデータは payload のスタブで上書きされず保持される
    expect(readFileSync(join(destDir, 'bgmData.ts'), 'utf8')).toBe(userData);
    // 導入済みになり、MainVideo にも組み込まれている
    expect(isBgmInstalled(dir)).toBe(true);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain("import { BgmSequence } from './Bgm';");
  });

  it('既存 <BGM .../> を <BgmSequence /> に置換する', () => {
    const main = `import { AbsoluteFill } from 'remotion';
import { BGM } from './SoundEffects/BGM';
import { SESequence } from './SoundEffects/SESequence';
export const MainVideo = () => (
  <AbsoluteFill>
    <BGM volume={0.08} />
    <SESequence />
  </AbsoluteFill>
);`;
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), main, 'utf8');
    installBgm(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('<BgmSequence');
    expect(mv).not.toMatch(/<BGM\s+volume/); // 旧 <BGM/> は消える
  });

  it('<BGM> で始まる別タグ（<BGMController/>）を誤って置換しない', () => {
    const main = `import { AbsoluteFill } from 'remotion';
import { BGMController } from './BGMController';
import { SESequence } from './SoundEffects/SESequence';
export const MainVideo = () => (
  <AbsoluteFill>
    <BGMController />
    <SESequence />
  </AbsoluteFill>
);`;
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), main, 'utf8');
    installBgm(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('<BGMController />'); // 誤置換されず残る
    expect(mv).toContain('<BgmSequence />');   // SESequence 前のフォールバックで挿入
  });

  it('<BGM/> も <SESequence/> も無い MainVideo は </AbsoluteFill> 直前へ挿入する', () => {
    const noSe = `import { AbsoluteFill } from 'remotion';
import { CutPlayer } from './CutPlayer';

export const MainVideo: React.FC = () => {
  return (
    <AbsoluteFill>
      <CutPlayer />
    </AbsoluteFill>
  );
};
`;
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), noSe, 'utf8');
    installBgm(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    // </AbsoluteFill> の前に挿入されている
    expect(mv.indexOf('<BgmSequence')).toBeLessThan(mv.indexOf('</AbsoluteFill>'));
    expect(mv).toContain('<BgmSequence');
  });
});
