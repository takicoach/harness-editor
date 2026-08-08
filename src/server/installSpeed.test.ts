import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSpeed, isSpeedInstalled } from './installSpeed';

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
// sample 系（stock CutPlayer・staticFile/VIDEO_FILE import 無し）
const MAIN_VIDEO_CUT_PLAYER = `import { AbsoluteFill } from 'remotion';
import { CutPlayer } from './CutPlayer';
import { cutData } from '../cutData';
export const MainVideo: React.FC = () => (
  <AbsoluteFill>
    <CutPlayer />
  </AbsoluteFill>
);
`;

// MainVideo（トランジション導入済み＝CutPlayerWithTransitions ベース）
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

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sme-speed-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'videoConfig.ts'), `export const VIDEO_FILE='main.mp4';`, 'utf8');
  writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO, 'utf8');
  writeFileSync(join(dir, 'src', 'Root.tsx'), ROOT, 'utf8');
  writeFileSync(join(dir, 'cutData.ts'), CUT, 'utf8'); // ルート直下（golf-drills 形）
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('installSpeed', () => {
  it('① 部品コピー＋marker＋speedData 確保', () => {
    const r = installSpeed(dir);
    expect(r.installed).toBe(true);
    expect(existsSync(join(dir, 'src', 'Speed', 'SpeedPlayer.tsx'))).toBe(true);
    expect(existsSync(join(dir, 'src', 'Speed', 'speed.json'))).toBe(true);
    expect(existsSync(join(dir, 'src', 'speedData.ts'))).toBe(true);
    expect(readFileSync(join(dir, 'src', 'speedData.ts'), 'utf8')).toContain('MAIN_SPEED');
    const shipped = readdirSync(join(dir, 'src', 'Speed'));
    expect(shipped.some((f) => f.includes('.test.'))).toBe(false);
  });
  it('② MainVideo: SpeedPlayer に segmentSpeeds 注入＋SEGMENT_SPEEDS import', () => {
    installSpeed(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('<SpeedPlayer cutData={cutData} videoSrc={staticFile(VIDEO_FILE)} mainSpeed={MAIN_SPEED} segmentSpeeds={SEGMENT_SPEEDS} />');
    expect(mv).not.toMatch(/<OffthreadVideo\b/);
    expect(mv).toContain("import { SpeedPlayer } from './Speed';");
    expect(mv).toContain("import { cutData } from '../cutData';"); // ルート直下
    expect(mv).toContain("import { MAIN_SPEED, SEGMENT_SPEEDS } from './speedData';");
    expect(existsSync(join(dir, 'src', 'MainVideo.original.bak.tsx'))).toBe(true);
  });
  it('③ Root: durationInFrames を speedCompositionDuration へ＋import', () => {
    installSpeed(dir);
    const root = readFileSync(join(dir, 'src', 'Root.tsx'), 'utf8');
    expect(root).toContain('durationInFrames={speedCompositionDuration(cutData, CUT_DURATION_FRAMES, MAIN_SPEED, SEGMENT_SPEEDS)}');
    expect(root).toContain("import { speedCompositionDuration } from './Speed';");
    expect(root).toContain("import { cutData, CUT_DURATION_FRAMES } from '../cutData';");
    expect(root).toContain("import { MAIN_SPEED, SEGMENT_SPEEDS } from './speedData';");
  });
  it('④ 冪等: 2 回呼んでも 1 つだけ・本文不変', () => {
    installSpeed(dir);
    const once = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    const rootOnce = readFileSync(join(dir, 'src', 'Root.tsx'), 'utf8');
    installSpeed(dir);
    const twice = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(twice).toBe(once);
    expect(readFileSync(join(dir, 'src', 'Root.tsx'), 'utf8')).toBe(rootOnce); // Root も不変
    expect((twice.match(/<SpeedPlayer/g) ?? []).length).toBe(1);
  });
  it('⑦ src/cutData.ts 形なら ./cutData で import', () => {
    rmSync(join(dir, 'cutData.ts'));
    writeFileSync(join(dir, 'src', 'cutData.ts'), CUT, 'utf8');
    installSpeed(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain("import { cutData } from './cutData';");
  });
  it('⑧ CutPlayer ベース(sample 系): CutPlayer→SpeedPlayer 差替＋staticFile/VIDEO_FILE import 追加・cutData 重複なし', () => {
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO_CUT_PLAYER, 'utf8');
    installSpeed(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('<SpeedPlayer cutData={cutData} videoSrc={staticFile(VIDEO_FILE)} mainSpeed={MAIN_SPEED} segmentSpeeds={SEGMENT_SPEEDS} />');
    expect(mv).not.toContain('<CutPlayer />');
    expect(mv).toContain("import { SpeedPlayer } from './Speed';");
    expect(mv).toContain("import { staticFile } from 'remotion';"); // 元に無い→追加
    expect(mv).toContain("import { VIDEO_FILE } from './videoConfig';"); // 元に無い→追加
    expect((mv.match(/import \{ cutData \}/g) ?? []).length).toBe(1); // 既存温存・二重追加なし
  });
  it('⑨ src/テロップテンプレート/cutData.ts 形なら ./テロップテンプレート/cutData で import（MainVideo・Root 両方）', () => {
    rmSync(join(dir, 'cutData.ts'));
    mkdirSync(join(dir, 'src', 'テロップテンプレート'), { recursive: true });
    writeFileSync(join(dir, 'src', 'テロップテンプレート', 'cutData.ts'), CUT, 'utf8');
    installSpeed(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain("import { cutData } from './テロップテンプレート/cutData';");
    const root = readFileSync(join(dir, 'src', 'Root.tsx'), 'utf8');
    expect(root).toContain("import { cutData, CUT_DURATION_FRAMES } from './テロップテンプレート/cutData';");
  });
  it('⑩ 既存 speedData.ts (0.5) を保持して導入（値が消えない）', () => {
    writeFileSync(join(dir, 'src', 'speedData.ts'), 'export const MAIN_SPEED = 0.5;\n', 'utf8');
    installSpeed(dir);
    expect(readFileSync(join(dir, 'src', 'speedData.ts'), 'utf8')).toContain('MAIN_SPEED = 0.5');
  });
  it('⑪ cutData.ts 不在ならブロック（ゼロ副作用）', () => {
    rmSync(join(dir, 'cutData.ts'));
    expect(() => installSpeed(dir)).toThrow(/カットデータ|cutData/);
    expect(isSpeedInstalled(dir)).toBe(false);
    expect(existsSync(join(dir, 'src', 'Speed'))).toBe(false);
  });
  it('⑫ 生 <Video ...VIDEO_FILE...> ベース: Video→SpeedPlayer 差替＋import（直下 cutData=../cutData）', () => {
    const MAIN_VIDEO_PLAIN = `import { AbsoluteFill, Video, staticFile } from 'remotion';
import { VIDEO_FILE } from './videoConfig';
export const MainVideo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: 'black' }}>
    <Video
      src={staticFile(VIDEO_FILE)}
      volume={1.0}
      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
    />
  </AbsoluteFill>
);
`;
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO_PLAIN, 'utf8');
    installSpeed(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('<SpeedPlayer cutData={cutData} videoSrc={staticFile(VIDEO_FILE)} mainSpeed={MAIN_SPEED} segmentSpeeds={SEGMENT_SPEEDS} />');
    expect(mv).not.toMatch(/<Video\b/); // 生 Video は差し替えられた
    expect(mv).toContain("import { SpeedPlayer } from './Speed';");
    expect(mv).toContain("import { cutData } from '../cutData';"); // 直下 cutData
  });
  // 追記: 導入時に既存 segmentSpeeds を保全（消さない）
  it('⑧ 既存 speedData.ts の SEGMENT_SPEEDS を導入時に保全', () => {
    writeFileSync(join(dir, 'src', 'speedData.ts'),
      'export const MAIN_SPEED = 0.5;\nexport const SEGMENT_SPEEDS: Record<number, number> = { 1: 2 };\n', 'utf8');
    installSpeed(dir);
    const sd = readFileSync(join(dir, 'src', 'speedData.ts'), 'utf8');
    expect(sd).toContain('MAIN_SPEED = 0.5');
    expect(sd).toContain('1: 2');
  });
  // 追記: 導入時 speedData 不在なら MAIN_SPEED=1 + SEGMENT_SPEEDS={} を生成
  it('⑨ speedData 不在: MAIN_SPEED=1 と空 SEGMENT_SPEEDS を生成', () => {
    installSpeed(dir);
    const sd = readFileSync(join(dir, 'src', 'speedData.ts'), 'utf8');
    expect(sd).toContain('MAIN_SPEED = 1');
    expect(sd).toContain('SEGMENT_SPEEDS');
  });
});

describe('installSpeed × トランジション導入済み（統合）', () => {
  beforeEach(() => {
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO_CPW, 'utf8');
    mkdirSync(join(dir, 'src', 'Transition'), { recursive: true });
    writeFileSync(join(dir, 'src', 'Transition', 'transition.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'src', 'Transition', 'transitionData.ts'), 'export const transitionData = [];', 'utf8');
  });

  it('ブロックされず導入成功・CPW に mainSpeed プロップを注入', () => {
    const r = installSpeed(dir);
    expect(r.installed).toBe(true);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain(
      '<CutPlayerWithTransitions cutData={cutData} transitions={transitionData} mainSpeed={MAIN_SPEED} videoSrc={staticFile(VIDEO_FILE)} />',
    );
    expect(mv).toContain("import { MAIN_SPEED } from './speedData';");
    expect(mv).not.toContain('<SpeedPlayer');
  });

  it('Root も速度対応へ＋speed marker 生成', () => {
    installSpeed(dir);
    expect(readFileSync(join(dir, 'src', 'Root.tsx'), 'utf8')).toContain(
      'durationInFrames={Math.round(CUT_DURATION_FRAMES / MAIN_SPEED)}',
    );
    expect(isSpeedInstalled(dir)).toBe(true);
  });

  it('冪等: 2 回で mainSpeed は 1 つ・本文不変', () => {
    installSpeed(dir);
    const once = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    installSpeed(dir);
    expect(readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8')).toBe(once);
    expect((once.match(/mainSpeed=\{MAIN_SPEED\}/g) ?? []).length).toBe(1);
  });
});
