import { describe, expect, it } from 'vitest';
import {
  anchorVideoInserts,
  projectVideoInserts,
  clampVideoInserts,
  videoInsertInCutRegion,
} from './videoInsertEngine';
import type { CutRegion, EditorVideoInsert, VideoInsert } from './types';

const noCuts: CutRegion[] = [];

describe('anchorVideoInserts', () => {
  it('カット無しでは再生フレーム＝原本フレーム・sourceInFrame は不変', () => {
    const items: VideoInsert[] = [
      { id: 1, startFrame: 100, endFrame: 200, file: 'sub/cam2.mp4', sourceInFrame: 30 },
    ];
    expect(anchorVideoInserts(items, noCuts)).toEqual([
      { id: 1, originalStart: 100, originalEnd: 200, file: 'sub/cam2.mp4', sourceInFrame: 30 },
    ]);
  });

  it('先頭カット区間ぶん再生フレームが原本で後ろへずれる', () => {
    const cuts: CutRegion[] = [{ start: 0, end: 50 }];
    const items: VideoInsert[] = [
      { id: 1, startFrame: 0, endFrame: 10, file: 'sub/cam2.mp4', sourceInFrame: 5 },
    ];
    const r = anchorVideoInserts(items, cuts);
    expect(r[0]?.originalStart).toBe(50);
    expect(r[0]?.originalEnd).toBe(60);
    expect(r[0]?.sourceInFrame).toBe(5);
  });

  it('position / scale を保持する', () => {
    const items: VideoInsert[] = [
      { id: 2, startFrame: 0, endFrame: 10, file: 'a.mp4', sourceInFrame: 0, position: { x: 0.2, y: -0.3 }, scale: 0.5 },
    ];
    const r = anchorVideoInserts(items, noCuts);
    expect(r[0]?.position).toEqual({ x: 0.2, y: -0.3 });
    expect(r[0]?.scale).toBe(0.5);
  });
});

describe('projectVideoInserts', () => {
  it('anchor の逆変換で元の再生フレームへ戻る（往復）', () => {
    const cuts: CutRegion[] = [{ start: 0, end: 50 }];
    const editor: EditorVideoInsert[] = [
      { id: 1, originalStart: 50, originalEnd: 60, file: 'sub/cam2.mp4', sourceInFrame: 5 },
    ];
    expect(projectVideoInserts(editor, cuts)).toEqual([
      { id: 1, startFrame: 0, endFrame: 10, file: 'sub/cam2.mp4', sourceInFrame: 5 },
    ]);
  });
});

describe('clampVideoInserts', () => {
  it('カット区間にかかる start を区間外へ寄せる', () => {
    const cuts: CutRegion[] = [{ start: 100, end: 200 }];
    const editor: EditorVideoInsert[] = [
      { id: 1, originalStart: 150, originalEnd: 250, file: 'a.mp4', sourceInFrame: 0 },
    ];
    const r = clampVideoInserts(editor, cuts);
    expect(r.videoInserts[0]?.originalStart).toBe(200);
    expect(r.videoInserts[0]?.originalEnd).toBe(250);
    expect(r.flaggedIds).toEqual([]);
  });

  it('カット区間に完全に飲まれたクリップは flagged・原形保持', () => {
    const cuts: CutRegion[] = [{ start: 100, end: 300 }];
    const editor: EditorVideoInsert[] = [
      { id: 7, originalStart: 150, originalEnd: 250, file: 'a.mp4', sourceInFrame: 0 },
    ];
    const r = clampVideoInserts(editor, cuts);
    expect(r.flaggedIds).toEqual([7]);
    expect(r.videoInserts[0]?.originalStart).toBe(150);
  });

  it('別々の2カットが start と end を両方とも区間外へ寄せる', () => {
    // start は前カット[100,160)で160へ、end は後カット[200,300)で200へ寄る（flagged にならない）。
    const cuts: CutRegion[] = [{ start: 100, end: 160 }, { start: 200, end: 300 }];
    const editor: EditorVideoInsert[] = [
      { id: 1, originalStart: 150, originalEnd: 250, file: 'a.mp4', sourceInFrame: 0 },
    ];
    const r = clampVideoInserts(editor, cuts);
    expect(r.videoInserts[0]?.originalStart).toBe(160);
    expect(r.videoInserts[0]?.originalEnd).toBe(200);
    expect(r.flaggedIds).toEqual([]);
  });
});

// 保存経路の契約: serializeProject は必ず clamp → project の順で呼ぶ。
// カットに飲まれたクリップは clamp で flagged になり（原形保持）、project すると退化区間
// （startFrame === endFrame）へ落ちる。最終 render は playbackEnd > playbackStart で描画スキップ
// するため、「カットで消えたクリップは映さない」が正しく表現される（挿入画像と同じ確立パターン）。
describe('clamp→project 契約（カット飲み込みは退化区間として落ちる）', () => {
  it('飲まれたクリップは flagged、project で start===end の退化区間になる', () => {
    const cuts: CutRegion[] = [{ start: 100, end: 300 }];
    const editor: EditorVideoInsert[] = [
      { id: 7, originalStart: 150, originalEnd: 250, file: 'a.mp4', sourceInFrame: 9 },
    ];
    const { videoInserts: clamped, flaggedIds } = clampVideoInserts(editor, cuts);
    expect(flaggedIds).toEqual([7]);
    const projected = projectVideoInserts(clamped, cuts);
    // 退化（start===end）＝最終 render の playbackEnd>playbackStart フィルタで描かれない。
    expect(projected[0]?.startFrame).toBe(projected[0]?.endFrame);
    // sourceInFrame は退化区間でも carry-through される。
    expect(projected[0]?.sourceInFrame).toBe(9);
  });
});

describe('videoInsertInCutRegion', () => {
  it('両端がカット区間内なら true', () => {
    const cuts: CutRegion[] = [{ start: 100, end: 300 }];
    expect(videoInsertInCutRegion(150, 250, cuts)).toBe(true);
  });
  it('区間外を含むなら false', () => {
    const cuts: CutRegion[] = [{ start: 100, end: 300 }];
    expect(videoInsertInCutRegion(50, 250, cuts)).toBe(false);
  });
});
