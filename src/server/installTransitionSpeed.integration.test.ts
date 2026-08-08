import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSpeed, isSpeedInstalled } from './installSpeed';
import { installTransition, isTransitionInstalled } from './installTransition';

// CutPlayer ベースのフィクスチャ（統合がフルに効く形）。cutData は src/cutData.ts に置き、
// 速度(cutDataImport)＝トランジション(IMPORT_CUT_DATA)＝'./cutData' で一致させる。
const MAIN_VIDEO = `import { AbsoluteFill } from 'remotion';
import { CutPlayer } from './CutPlayer';
export const MainVideo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: 'black' }}>
    <CutPlayer />
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

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sme-ts-integ-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'videoConfig.ts'), `export const VIDEO_FILE = 'main.mp4';`, 'utf8');
  writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO, 'utf8');
  writeFileSync(join(dir, 'src', 'Root.tsx'), ROOT, 'utf8');
  writeFileSync(join(dir, 'src', 'cutData.ts'), CUT, 'utf8'); // './cutData'
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 最終 MainVideo が統合形であることを検証する。 */
function expectUnified(mv: string): void {
  expect(mv).toContain(
    '<CutPlayerWithTransitions cutData={cutData} transitions={transitionData} mainSpeed={MAIN_SPEED} videoSrc={staticFile(VIDEO_FILE)} />',
  );
  expect(mv).toContain('<SceneOverlaySequence cutData={cutData} transitions={transitionData} />');
  expect(mv).not.toContain('<SpeedPlayer');
  expect(mv).not.toContain('<CutPlayer />');
  // MAIN_SPEED は必ず import される（速度→トランジション順では SEGMENT_SPEEDS も含む場合あり）
  expect(mv).toMatch(/import \{[^}]*\bMAIN_SPEED\b[^}]*\} from '\.\/speedData';/);
}

describe('install 統合 往復（両順序で同じ統合形）', () => {
  it('トランジション → 速度 の順', () => {
    installTransition(dir);
    installSpeed(dir);
    expect(isTransitionInstalled(dir)).toBe(true);
    expect(isSpeedInstalled(dir)).toBe(true);
    expectUnified(readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8'));
  });

  it('速度 → トランジション の順', () => {
    installSpeed(dir);
    installTransition(dir);
    expect(isTransitionInstalled(dir)).toBe(true);
    expect(isSpeedInstalled(dir)).toBe(true);
    expectUnified(readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8'));
  });

  it('両順序で再実行しても冪等（CPW・mainSpeed は各 1 つ）', () => {
    installTransition(dir);
    installSpeed(dir);
    installTransition(dir);
    installSpeed(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect((mv.match(/<CutPlayerWithTransitions/g) ?? []).length).toBe(1);
    expect((mv.match(/mainSpeed=\{MAIN_SPEED\}/g) ?? []).length).toBe(1);
  });
});

/** 生 <Video> ベースのプロジェクトテンプレート */
const MAIN_VIDEO_PLAIN = `import { AbsoluteFill, Video, staticFile } from 'remotion';
import { VIDEO_FILE } from './videoConfig';
export const MainVideo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: 'black' }}>
    <Video src={staticFile(VIDEO_FILE)} volume={1.0} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
  </AbsoluteFill>
);
`;

function mkProjectPlain(): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'sme-int-plain-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  writeFileSync(join(tempDir, 'src', 'videoConfig.ts'), `export const VIDEO_FILE='main.mp4';`, 'utf8');
  writeFileSync(join(tempDir, 'src', 'MainVideo.tsx'), MAIN_VIDEO_PLAIN, 'utf8');
  writeFileSync(join(tempDir, 'src', 'Root.tsx'), ROOT, 'utf8');
  writeFileSync(join(tempDir, 'cutData.ts'), CUT, 'utf8'); // 直下
  return tempDir;
}

describe('install 統合（生 <Video> ベース・両順序で統合形へ収束）', () => {
  let plainDir: string;
  afterEach(() => rmSync(plainDir, { recursive: true, force: true }));

  it('速度→トランジション: CutPlayerWithTransitions＋mainSpeed・cutData=../cutData', () => {
    plainDir = mkProjectPlain();
    installSpeed(plainDir);
    installTransition(plainDir);
    const mv = readFileSync(join(plainDir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('<CutPlayerWithTransitions');
    expect(mv).toContain('mainSpeed={MAIN_SPEED}');
    expect(mv).not.toMatch(/<Video\b/);
    expect(mv).not.toContain('<SpeedPlayer');
    expect(mv).toContain("import { cutData } from '../cutData';");
  });

  it('トランジション→速度: 同じ統合形へ収束（CutPlayerWithTransitions に mainSpeed 注入）', () => {
    plainDir = mkProjectPlain();
    installTransition(plainDir);
    installSpeed(plainDir);
    const mv = readFileSync(join(plainDir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('<CutPlayerWithTransitions');
    expect(mv).toContain('mainSpeed={MAIN_SPEED}');
    expect(mv).not.toMatch(/<Video\b/);
  });
});
