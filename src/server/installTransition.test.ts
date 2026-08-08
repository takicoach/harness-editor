import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTransition, isTransitionInstalled } from './installTransition';

let dir: string;
const MAIN_VIDEO = `import { AbsoluteFill } from 'remotion';
import { TelopPlayer } from './テロップテンプレート';
import { CutPlayer } from './CutPlayer';

export const MainVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <CutPlayer />
      <TelopPlayer />
    </AbsoluteFill>
  );
};
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sme-transition-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'videoConfig.ts'), `export const VIDEO_FILE = 'main.mp4';`, 'utf8');
  writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO, 'utf8');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('installTransition', () => {
  it('① 部品コピー＋marker: SceneOverlaySequence.tsx と transition.json が作られる', () => {
    const r = installTransition(dir);
    expect(r.installed).toBe(true);
    // 部品がコピーされている
    expect(existsSync(join(dir, 'src', 'Transition', 'SceneOverlaySequence.tsx'))).toBe(true);
    expect(existsSync(join(dir, 'src', 'Transition', 'SceneOverlay.tsx'))).toBe(true);
    // marker が作られている
    expect(existsSync(join(dir, 'src', 'Transition', 'transition.json'))).toBe(true);
    expect(existsSync(join(dir, 'src', 'MainVideo.original.bak.tsx'))).toBe(true);
    // 非出荷ファイル（テスト）はユーザープロジェクトへ同梱しない（H-1 回帰防止）。
    // 配布先は vitest 非依存のため shipped test が typecheck/build を壊す。
    const shipped = readdirSync(join(dir, 'src', 'Transition'));
    expect(shipped.some((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))).toBe(false);
  });

  it('② import と props 付き <SceneOverlaySequence> が1つだけ注入される（最上位＝最後の </AbsoluteFill> 直前）', () => {
    installTransition(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    // Transition import がある（CutPlayerWithTransitions/SceneOverlaySequence/transitionData をまとめた行）
    expect(mv).toContain("from './Transition'");
    // props 付き <SceneOverlaySequence> タグが存在する
    expect(mv).toContain('<SceneOverlaySequence cutData={cutData} transitions={transitionData} />');
    // TelopPlayer より後に挿入されている（最上位レイヤ）
    expect(mv.indexOf('<SceneOverlaySequence')).toBeGreaterThan(mv.indexOf('<TelopPlayer'));
    // 最後の </AbsoluteFill> より前にある
    const lastAbsClose = mv.lastIndexOf('</AbsoluteFill>');
    expect(mv.indexOf('<SceneOverlaySequence')).toBeLessThan(lastAbsClose);
  });

  it('③ 冪等: 2回呼んでも壊れない（import/JSX が重複しない）', () => {
    installTransition(dir);
    const once = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    installTransition(dir);
    const twice = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(twice).toBe(once);
    expect(isTransitionInstalled(dir)).toBe(true);
    // SceneOverlaySequence タグが1つだけ
    const tagCount = (twice.match(/<SceneOverlaySequence/g) ?? []).length;
    expect(tagCount).toBe(1);
    // CutPlayerWithTransitions タグが1つだけ
    const cpwCount = (twice.match(/<CutPlayerWithTransitions/g) ?? []).length;
    expect(cpwCount).toBe(1);
  });

  it('④ transitionData.ts 保持: 既存 transitionData.ts はスキップ（上書きしない）', () => {
    // transitionData.ts が先に存在する場合
    const destDir = join(dir, 'src', 'Transition');
    mkdirSync(destDir, { recursive: true });
    const userData = '// USER SAVED DATA\nexport const transitionData = [{ id: "t-1" }];\n';
    writeFileSync(join(destDir, 'transitionData.ts'), userData, 'utf8');

    const r = installTransition(dir);
    expect(r.installed).toBe(true);
    // 部品一式がコピーされている
    expect(existsSync(join(destDir, 'SceneOverlaySequence.tsx'))).toBe(true);
    expect(existsSync(join(destDir, 'SceneOverlay.tsx'))).toBe(true);
    expect(existsSync(join(destDir, 'index.ts'))).toBe(true);
    expect(existsSync(join(destDir, 'types.ts'))).toBe(true);
    // ユーザーの保存済み transitionData.ts は上書きされず保持される
    expect(readFileSync(join(destDir, 'transitionData.ts'), 'utf8')).toBe(userData);
    // 導入済みになり、MainVideo にも組み込まれている
    expect(isTransitionInstalled(dir)).toBe(true);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain("from './Transition'");
  });

  it('非プロジェクト（videoConfig 無し）は 400 で中断', () => {
    rmSync(join(dir, 'src', 'videoConfig.ts'));
    expect(() => installTransition(dir)).toThrow();
  });

  it('アンカーが無ければ中断（marker を書かない）', () => {
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), `export const MainVideo = () => null;`, 'utf8');
    expect(() => installTransition(dir)).toThrow();
    expect(isTransitionInstalled(dir)).toBe(false);
  });
});

describe('installTransition × CutPlayer 置換', () => {
  it('⑤ <CutPlayer /> を <CutPlayerWithTransitions /> へ置換し必要な import を足す', () => {
    installTransition(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    // CutPlayerWithTransitions に置換されている
    expect(mv).toContain(
      '<CutPlayerWithTransitions cutData={cutData} transitions={transitionData} videoSrc={staticFile(VIDEO_FILE)} />',
    );
    // 旧 <CutPlayer /> が残っていない（置換済み）
    expect(mv).not.toMatch(/<CutPlayer\s*\/>/);
    // Transition から CutPlayerWithTransitions 等が import されている
    expect(mv).toContain('CutPlayerWithTransitions');
    expect(mv).toContain('transitionData');
    // staticFile の import「行」がある（C-1 回帰防止: JSX 内の staticFile(VIDEO_FILE) 使用で
    // toContain('staticFile') が充足し import 欠落を見逃すため、import 行を正規表現で検証）。
    expect(mv).toMatch(/import\s*\{[^}]*\bstaticFile\b[^}]*\}\s*from\s*['"]remotion['"]/);
    // cutData の import がある
    expect(mv).toContain("from './cutData'");
    // VIDEO_FILE の import がある
    expect(mv).toContain("from './videoConfig'");
  });

  it('⑥ <CutPlayer /> なしの MainVideo でも SceneOverlaySequence は挿入される（fade のみ動作）', () => {
    const noCutPlayer = `import { AbsoluteFill } from 'remotion';
import { TelopPlayer } from './テロップテンプレート';

export const MainVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <TelopPlayer />
    </AbsoluteFill>
  );
};
`;
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), noCutPlayer, 'utf8');
    installTransition(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    // SceneOverlaySequence は挿入される
    expect(mv).toContain('<SceneOverlaySequence');
    // CutPlayerWithTransitions は挿入されない（元が無いのでスキップ）
    expect(mv).not.toContain('CutPlayerWithTransitions');
  });

  it('⑦ 冪等: 2回呼んでも <CutPlayerWithTransitions> は1つ・import 重複なし', () => {
    installTransition(dir);
    installTransition(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    const cpwCount = (mv.match(/<CutPlayerWithTransitions/g) ?? []).length;
    expect(cpwCount).toBe(1);
    // staticFile import の重複なし
    const sfCount = (mv.match(/staticFile/g) ?? []).length;
    // import 行 + JSX 使用の2箇所のみ（3重以上にならない）
    expect(sfCount).toBeLessThanOrEqual(3);
  });

  it('⑧ M-1: 既に frame 対応 MainLayout が導入済みなら transitions={transitionData} を結線（overlap 系で書き出し=プレビュー一致）', () => {
    const withFrameAwareLayout = `import { AbsoluteFill } from 'remotion';
import { TelopPlayer } from './テロップテンプレート';
import { CutPlayer } from './CutPlayer';
import { MainLayout } from './MainLayout';
import { MAIN_LAYOUT, SEGMENT_LAYOUTS, LAYOUT_KEYFRAMES } from './mainLayoutData';
import { cutData } from './cutData';
import { MAIN_SPEED, SEGMENT_SPEEDS } from './speedData';

export const MainVideo: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      <MainLayout layout={MAIN_LAYOUT} segmentLayouts={SEGMENT_LAYOUTS} cutData={cutData} mainSpeed={MAIN_SPEED} segmentSpeeds={SEGMENT_SPEEDS} layoutKeyframes={LAYOUT_KEYFRAMES}>
        <CutPlayer />
      </MainLayout>
      <TelopPlayer />
    </AbsoluteFill>
  );
};
`;
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), withFrameAwareLayout, 'utf8');
    installTransition(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    // MainLayout ラッパーへ transitions={transitionData} が結線されている
    expect(mv).toContain('layoutKeyframes={LAYOUT_KEYFRAMES} transitions={transitionData}>');
    // CutPlayer は CPW へ置換されている（ラッパー内側）
    expect(mv).toContain('<CutPlayerWithTransitions');
    expect(mv).not.toMatch(/<CutPlayer\s*\/>/);
    // 冪等: 2回目でも MainLayout への transitions 結線は1つだけ（CPW タグの transitions とは別カウント）
    installTransition(dir);
    const mv2 = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect((mv2.match(/layoutKeyframes=\{LAYOUT_KEYFRAMES\} transitions=\{transitionData\}/g) ?? []).length).toBe(1);
  });

  it('⑧ .test.ts を導入先へコピーしない（出荷ガード）', () => {
    installTransition(dir);
    const shipped = readdirSync(join(dir, 'src', 'Transition'));
    expect(shipped.some((f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx'))).toBe(false);
  });

  it('⑨ package.json に @remotion/transitions がなければ追記し needsInstall=true を返す', () => {
    const pkg = { name: 'test-project', dependencies: { remotion: '^4.0.0' } };
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
    const r = installTransition(dir);
    expect(r.installed).toBe(true);
    expect(r.needsInstall).toBe(true);
    const updated = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(updated.dependencies['@remotion/transitions']).toBeDefined();
  });

  it('⑩ @remotion/transitions が既にあれば needsInstall=false', () => {
    const pkg = {
      name: 'test-project',
      dependencies: { remotion: '^4.0.0', '@remotion/transitions': '^4.0.0' },
    };
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
    const r = installTransition(dir);
    expect(r.needsInstall).toBe(false);
  });

  it('⑪ package.json がなくても導入は成功する（needsInstall=false）', () => {
    // package.json 無しの場合はスキップして needsInstall=false
    const r = installTransition(dir);
    expect(r.installed).toBe(true);
    expect(r.needsInstall).toBe(false);
  });

  it('⑫ 直下 cutData.ts のとき cutData import は ../cutData（src/cutData ハードコードでない）', () => {
    writeFileSync(join(dir, 'cutData.ts'), 'export const cutData=[]; export const CUT_DURATION_FRAMES=100;', 'utf8');
    // 既定 MAIN_VIDEO は <CutPlayer /> ベース
    installTransition(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain("import { cutData } from '../cutData';");
    expect(mv).not.toContain("import { cutData } from './cutData';");
  });
  it('⑬ src/cutData.ts のとき cutData import は ./cutData', () => {
    writeFileSync(join(dir, 'src', 'cutData.ts'), 'export const cutData=[]; export const CUT_DURATION_FRAMES=100;', 'utf8');
    installTransition(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain("import { cutData } from './cutData';");
  });

  it('⑭ 生 <Video ...VIDEO_FILE...> ベース → CutPlayerWithTransitions へ swap（フェードのみでない）', () => {
    const MAIN_VIDEO_PLAIN = `import { AbsoluteFill, Video, staticFile } from 'remotion';
import { TelopPlayer } from './テロップテンプレート';
import { VIDEO_FILE } from './videoConfig';
export const MainVideo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: 'black' }}>
    <Video src={staticFile(VIDEO_FILE)} volume={1.0} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
    <TelopPlayer />
  </AbsoluteFill>
);
`;
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO_PLAIN, 'utf8');
    writeFileSync(join(dir, 'cutData.ts'), 'export const cutData=[]; export const CUT_DURATION_FRAMES=100;', 'utf8');
    installTransition(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain('<CutPlayerWithTransitions cutData={cutData} transitions={transitionData} videoSrc={staticFile(VIDEO_FILE)} />');
    expect(mv).not.toMatch(/<Video\b/); // 生 Video は差し替えられた
    expect(mv).toContain("import { CutPlayerWithTransitions, SceneOverlaySequence, transitionData } from './Transition';");
    expect(mv).toContain("import { cutData } from '../cutData';"); // 直下 cutData
    expect(mv).toContain('<SceneOverlaySequence cutData={cutData} transitions={transitionData} />');
  });
});

// MainVideo（速度導入済み＝SpeedPlayer ベース）
const MAIN_VIDEO_SPEED = `import { AbsoluteFill, staticFile } from 'remotion';
import { SpeedPlayer } from './Speed';
import { cutData } from '../cutData';
import { MAIN_SPEED } from './speedData';
import { VIDEO_FILE } from './videoConfig';
export const MainVideo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: 'black' }}>
    <SpeedPlayer cutData={cutData} videoSrc={staticFile(VIDEO_FILE)} mainSpeed={MAIN_SPEED} />
  </AbsoluteFill>
);
`;

describe('installTransition × 速度導入済み（統合 swap）', () => {
  beforeEach(() => {
    writeFileSync(join(dir, 'src', 'MainVideo.tsx'), MAIN_VIDEO_SPEED, 'utf8');
    mkdirSync(join(dir, 'src', 'Speed'), { recursive: true });
    writeFileSync(join(dir, 'src', 'Speed', 'speed.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'src', 'speedData.ts'), 'export const MAIN_SPEED = 0.5;', 'utf8');
  });

  it('SpeedPlayer→CutPlayerWithTransitions へ swap・mainSpeed 引継ぎ・SpeedPlayer import 除去', () => {
    installTransition(dir);
    const mv = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    expect(mv).toContain(
      '<CutPlayerWithTransitions cutData={cutData} transitions={transitionData} mainSpeed={MAIN_SPEED} videoSrc={staticFile(VIDEO_FILE)} />',
    );
    expect(mv).not.toContain('<SpeedPlayer');
    expect(mv).not.toContain("import { SpeedPlayer } from './Speed';");
    expect(mv).toContain('CutPlayerWithTransitions, SceneOverlaySequence, transitionData');
    expect(mv).toContain('<SceneOverlaySequence cutData={cutData} transitions={transitionData} />');
    expect(mv).toContain("import { MAIN_SPEED } from './speedData';"); // 速度 import 維持
  });

  it('冪等: 2 回で CPW は 1 つ', () => {
    installTransition(dir);
    const once = readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8');
    installTransition(dir);
    expect(readFileSync(join(dir, 'src', 'MainVideo.tsx'), 'utf8')).toBe(once);
    expect((once.match(/<CutPlayerWithTransitions/g) ?? []).length).toBe(1);
  });
});
