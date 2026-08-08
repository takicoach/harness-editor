import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installMainLayout, isMainLayoutInstalled } from './installMainLayout';
import { installSpeed } from './installSpeed';

// 生 OffthreadVideo（golf-drills 系・未 install）
const MAIN_VIDEO = `import { AbsoluteFill, OffthreadVideo, staticFile } from 'remotion';
import { VIDEO_FILE } from './videoConfig';
export const MainVideo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: 'black' }}>
    <OffthreadVideo
      src={staticFile(VIDEO_FILE)}
      volume={1.0}
      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
    />
  </AbsoluteFill>
);
`;
const ROOT = `import { Composition } from 'remotion';
import { MainVideo } from './MainVideo';
import { FPS, DURATION_FRAMES, RESOLUTION } from './videoConfig';
export const RemotionRoot = () => (
  <Composition id="MainVideo" component={MainVideo} durationInFrames={DURATION_FRAMES} fps={FPS} width={RESOLUTION.width} height={RESOLUTION.height} />
);
`;
const CUT = `export interface CutSegment { id:number; originalStart:number; originalEnd:number; playbackStart:number; playbackEnd:number }
export const cutData: CutSegment[] = [ { id:1, originalStart:0, originalEnd:100, playbackStart:0, playbackEnd:100 } ];
export const ORIGINAL_DURATION_FRAMES = 200;
export const CUT_DURATION_FRAMES = 100;
`;
// sample 系（stock CutPlayer）
const MAIN_VIDEO_CUT_PLAYER = `import { AbsoluteFill } from 'remotion';
import { CutPlayer } from './CutPlayer';
export const MainVideo: React.FC = () => (
  <AbsoluteFill>
    <CutPlayer />
  </AbsoluteFill>
);
`;
// transition 導入済み（CutPlayerWithTransitions ベース）
const MAIN_VIDEO_CPW = `import { AbsoluteFill, staticFile } from 'remotion';
import { CutPlayerWithTransitions, SceneOverlaySequence, transitionData } from './Transition';
import { cutData } from '../cutData';
import { VIDEO_FILE } from './videoConfig';
export const MainVideo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: 'black' }}>
    <CutPlayerWithTransitions cutData={cutData} transitions={transitionData} videoSrc={staticFile(VIDEO_FILE)} />
    <SceneOverlaySequence cutData={cutData} transitions={transitionData} />
  </AbsoluteFill>
);
`;
// SpeedPlayer ベース（速度導入済み）
const MAIN_VIDEO_SPEED = `import { AbsoluteFill, staticFile } from 'remotion';
import { SpeedPlayer } from './Speed';
import { cutData } from '../cutData';
import { MAIN_SPEED, SEGMENT_SPEEDS } from './speedData';
import { VIDEO_FILE } from './videoConfig';
export const MainVideo: React.FC = () => (
  <AbsoluteFill>
    <SpeedPlayer cutData={cutData} videoSrc={staticFile(VIDEO_FILE)} mainSpeed={MAIN_SPEED} segmentSpeeds={SEGMENT_SPEEDS} />
  </AbsoluteFill>
);
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sme-mainlayout-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'videoConfig.ts'), `export const VIDEO_FILE='main.mp4';`, 'utf8');
  writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO, 'utf8');
  writeFileSync(join(dir, 'src', 'Root.tsx'), ROOT, 'utf8');
  writeFileSync(join(dir, 'cutData.ts'), CUT, 'utf8');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('installMainLayout', () => {
  it('① 部品コピー＋marker＋mainLayoutData 確保（恒等でも MAIN_LAYOUT 出力）', () => {
    const r = installMainLayout(dir);
    expect(r.installed).toBe(true);
    expect(existsSync(join(dir, 'src', 'MainLayout', 'MainLayout.tsx'))).toBe(true);
    expect(existsSync(join(dir, 'src', 'MainLayout', 'main-layout.json'))).toBe(true);
    expect(existsSync(join(dir, 'src', 'mainLayoutData.ts'))).toBe(true);
    expect(readFileSync(join(dir, 'src', 'mainLayoutData.ts'), 'utf8')).toContain('MAIN_LAYOUT');
    expect(readdirSync(join(dir, 'src', 'MainLayout')).some((f) => f.includes('.test.'))).toBe(false);
  });

  it('② 生 OffthreadVideo を <MainLayout> でラップ＋import 追加・バックアップ', () => {
    installMainLayout(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('<MainLayout layout={MAIN_LAYOUT}>');
    expect(mv).toContain('</MainLayout>');
    expect(mv).toContain('<OffthreadVideo'); // 差し替えでなく包む＝中身は残る
    expect(mv).toContain("import { MainLayout } from './MainLayout';");
    expect(mv).toContain("import { MAIN_LAYOUT } from './mainLayoutData';");
    expect(existsSync(join(dir, 'src', 'MainVideo.original.bak.tsx'))).toBe(true);
  });

  it('③ Root.tsx は変更しない（尺不変）', () => {
    const before = readFileSync(join(dir, 'src', 'Root.tsx'), 'utf8');
    installMainLayout(dir);
    expect(readFileSync(join(dir, 'src', 'Root.tsx'), 'utf8')).toBe(before);
  });

  it('④ 冪等: 2 回で <MainLayout> は 1 つ・本文不変', () => {
    installMainLayout(dir);
    const once = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    installMainLayout(dir);
    const twice = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(twice).toBe(once);
    expect((twice.match(/<MainLayout /g) ?? []).length).toBe(1);
  });

  it('⑤ CutPlayer ベース(sample 系)を包む（Plan 2: frame 対応・cutData.ts あり）', () => {
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO_CUT_PLAYER, 'utf8');
    installMainLayout(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    // beforeEach が dir/cutData.ts を用意しているため CutPlayer ベースは frame 対応で包まれる。
    expect(mv).toContain(
      '<MainLayout layout={MAIN_LAYOUT} segmentLayouts={SEGMENT_LAYOUTS} cutData={cutData} mainSpeed={MAIN_SPEED} segmentSpeeds={SEGMENT_SPEEDS} layoutKeyframes={LAYOUT_KEYFRAMES}>',
    );
    expect(mv).toContain('<CutPlayer />'); // 中身は残る
    expect((mv.match(/<CutPlayer /g) ?? []).length).toBe(1);
  });

  it('⑥ CutPlayerWithTransitions ベース(transition 済み)を包む', () => {
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO_CPW, 'utf8');
    installMainLayout(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('<MainLayout layout={MAIN_LAYOUT}>');
    expect(mv).toContain('<CutPlayerWithTransitions'); // 中身は残る
    // SceneOverlaySequence は包まない（メイン動画だけ変形）
    expect(mv).toMatch(/<\/MainLayout>[\s\S]*<SceneOverlaySequence/);
  });

  it('⑦ 既存 mainLayoutData.ts の値を保全して導入', () => {
    writeFileSync(
      join(dir, 'src', 'mainLayoutData.ts'),
      'export const MAIN_LAYOUT = { position: { x: 0.5, y: 0 }, scale: 2, background: "#ffffff" };\n',
      'utf8',
    );
    installMainLayout(dir);
    const md = readFileSync(join(dir, 'src', 'mainLayoutData.ts'), 'utf8');
    expect(md).toContain('scale: 2');
    expect(md).toContain('#ffffff');
  });

  it('⑦-2 既存 LAYOUT_KEYFRAMES（大域配列）を保全して導入', () => {
    writeFileSync(
      join(dir, 'src', 'mainLayoutData.ts'),
      'export const MAIN_LAYOUT = { position: { x: 0, y: 0 }, scale: 1, background: "#000000" };\n' +
        'export const SEGMENT_LAYOUTS: Record<number, unknown> = { 1: { position: { x: 0, y: 0 }, scale: 1 } };\n' +
        'export const LAYOUT_KEYFRAMES: unknown = [{ originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 }, { originalFrame: 30, x: 0.4, y: 0, scale: 2, rotation: 0 }];\n',
      'utf8',
    );
    installMainLayout(dir);
    const md = readFileSync(join(dir, 'src', 'mainLayoutData.ts'), 'utf8');
    expect(md).toContain('LAYOUT_KEYFRAMES');
    expect(md).toContain('scale: 2');
  });

  it('⑦-3 旧 Record 形式の LAYOUT_KEYFRAMES は配列でないため安全に破棄される', () => {
    writeFileSync(
      join(dir, 'src', 'mainLayoutData.ts'),
      'export const MAIN_LAYOUT = { position: { x: 0, y: 0 }, scale: 1, background: "#000000" };\n' +
        'export const LAYOUT_KEYFRAMES: Record<number, unknown> = { 1: [{ x: 0, y: 0, scale: 1, rotation: 0 }, { x: 0.4, y: 0, scale: 2, rotation: 0 }] };\n',
      'utf8',
    );
    installMainLayout(dir);
    const md = readFileSync(join(dir, 'src', 'mainLayoutData.ts'), 'utf8');
    expect(md).toContain('export const LAYOUT_KEYFRAMES');
    expect(md).not.toContain('scale: 2');
  });

  it('⑧ videoConfig 不在ならブロック（ゼロ副作用）', () => {
    rmSync(join(dir, 'src', 'videoConfig.ts'));
    expect(() => installMainLayout(dir)).toThrow(/ハーネス形式のプロジェクトではない/);
    expect(isMainLayoutInstalled(dir)).toBe(false);
    expect(existsSync(join(dir, 'src', 'MainLayout'))).toBe(false);
  });
});

describe('installMainLayout × speed（順不同共存）', () => {
  it('speed → mainLayout: SpeedPlayer を包む（Plan 2: frame 対応・cutData.ts あり）', () => {
    installSpeed(dir); // 先に速度導入（<SpeedPlayer …/> になる）
    installMainLayout(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    // beforeEach の dir/cutData.ts があるため SpeedPlayer ベースは frame 対応で包まれる。
    expect(mv).toContain(
      '<MainLayout layout={MAIN_LAYOUT} segmentLayouts={SEGMENT_LAYOUTS} cutData={cutData} mainSpeed={MAIN_SPEED} segmentSpeeds={SEGMENT_SPEEDS} layoutKeyframes={LAYOUT_KEYFRAMES}>',
    );
    expect(mv).toContain('<SpeedPlayer'); // 中身に残る
    expect(mv).toContain("import { MainLayout } from './MainLayout';");
  });

  it('mainLayout → speed: ラップ内の生 Video を SpeedPlayer へ差し替え・両立', () => {
    installMainLayout(dir); // 先にレイアウト導入（<MainLayout><OffthreadVideo…/></MainLayout>）
    installSpeed(dir); // speed は VIDEO_FILE の OffthreadVideo を SpeedPlayer に差し替える
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('<MainLayout layout={MAIN_LAYOUT}>');
    expect(mv).toContain('<SpeedPlayer');
    expect(mv).not.toMatch(/<OffthreadVideo\b/); // speed が差し替えた
    // レイアウトのラップは 1 つのまま
    expect((mv.match(/<MainLayout /g) ?? []).length).toBe(1);
  });
});

describe('installMainLayout frame 対応（Plan 2）', () => {
  it('CutPlayer ベース: frame 対応 props＋import＋speedData 常設（速度未導入でも作る）', () => {
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO_CUT_PLAYER, 'utf8');
    // speedData.ts は無い（速度未導入）。
    expect(existsSync(join(dir, 'src', 'speedData.ts'))).toBe(false);
    installMainLayout(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('<MainLayout layout={MAIN_LAYOUT} segmentLayouts={SEGMENT_LAYOUTS} cutData={cutData} mainSpeed={MAIN_SPEED} segmentSpeeds={SEGMENT_SPEEDS} layoutKeyframes={LAYOUT_KEYFRAMES}>');
    expect(mv).toContain("import { SEGMENT_LAYOUTS, LAYOUT_KEYFRAMES } from './mainLayoutData';");
    expect(mv).toContain("import { MAIN_SPEED, SEGMENT_SPEEDS } from './speedData';");
    expect(mv).toContain("import { cutData } from '../cutData';");
    expect(mv).toContain('<CutPlayer />'); // 差し替えでなく包む
    expect(existsSync(join(dir, 'src', 'speedData.ts'))).toBe(true); // install が常設
  });
  it('SpeedPlayer ベース: frame 対応 props（既存 import を重複させない）', () => {
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO_SPEED, 'utf8');
    writeFileSync(join(dir, 'src', 'speedData.ts'), `export const MAIN_SPEED = 1;\nexport const SEGMENT_SPEEDS: Record<number, number> = {  };\n`, 'utf8');
    installMainLayout(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('segmentLayouts={SEGMENT_LAYOUTS}');
    expect(mv).toContain('<SpeedPlayer');
    // MAIN_SPEED, SEGMENT_SPEEDS の import は 1 つだけ（重複追加しない）。
    expect(mv.match(/import \{ MAIN_SPEED, SEGMENT_SPEEDS \} from '\.\/speedData';/g)?.length).toBe(1);
  });
  it('CutPlayerWithTransitions ベース: base-only（frame props 無し・Plan 3）', () => {
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO_CPW, 'utf8');
    installMainLayout(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('<MainLayout layout={MAIN_LAYOUT}>');
    expect(mv).not.toContain('segmentLayouts=');
  });
  it('生 Video ベース: base-only（区間無し）', () => {
    // 既定 scaffold（生 OffthreadVideo）のまま。
    installMainLayout(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('<MainLayout layout={MAIN_LAYOUT}>');
    expect(mv).not.toContain('segmentLayouts=');
  });
  it('冪等: CutPlayer で 2 回 install → <MainLayout> は 1 つ・本文不変', () => {
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO_CUT_PLAYER, 'utf8');
    installMainLayout(dir);
    const first = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    installMainLayout(dir);
    const second = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(second).toBe(first);
    expect((second.match(/<MainLayout /g) ?? []).length).toBe(1);
  });
  it('格上げ: base-only で包まれた既存導入を frame 対応へ（不足 props/import 追記）', () => {
    // Plan 1 相当の base-only wrapper（CutPlayer を base-only で包んだ状態）を手で作る。
    const baseOnly = `import { AbsoluteFill } from 'remotion';
import { CutPlayer } from './CutPlayer';
import { MainLayout } from './MainLayout';
import { MAIN_LAYOUT } from './mainLayoutData';
export const MainVideo: React.FC = () => (
  <AbsoluteFill>
    <MainLayout layout={MAIN_LAYOUT}>
        <CutPlayer />
      </MainLayout>
  </AbsoluteFill>
);
`;
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), baseOnly, 'utf8');
    mkdirSync(join(dir, 'src', 'MainLayout'), { recursive: true });
    writeFileSync(join(dir, 'src', 'MainLayout', 'main-layout.json'), '{"feature":"mainLayout"}', 'utf8');
    installMainLayout(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('segmentLayouts={SEGMENT_LAYOUTS}');
    expect((mv.match(/<MainLayout /g) ?? []).length).toBe(1);
  });
});
