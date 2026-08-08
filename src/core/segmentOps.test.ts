import { describe, it, expect } from 'vitest';
import { splitSegment, mergeSegments, telopAtFrame, telopsAtFrame, splitTelopText } from './segmentOps';
import { clampSubtitleRange } from './telopEngine';
import type { EditorTelop, WordChip } from './types';

const base: EditorTelop = {
  id: 1,
  originalStart: 100,
  originalEnd: 400,
  text: '長いアイアン',
  style: 'normal',
  template: 2,
};

describe('splitSegment', () => {
  it('指定フレームで 2 つに割り、テキストを分配する', () => {
    const [a, b] = splitSegment(base, 250, '長い', 'アイアン', 99);
    expect(a).toMatchObject({ id: 1, originalStart: 100, originalEnd: 250, text: '長い' });
    expect(b).toMatchObject({ id: 99, originalStart: 250, originalEnd: 400, text: 'アイアン' });
  });

  it('スタイル等の属性は両方へ引き継ぐ', () => {
    const [a, b] = splitSegment(base, 250, '長い', 'アイアン', 99);
    expect(a.style).toBe('normal');
    expect(b.template).toBe(2);
  });

  it('分割位置が区間外なら throw する', () => {
    expect(() => splitSegment(base, 500, 'x', 'y', 99)).toThrow();
  });
});

describe('splitTelopText', () => {
  const chips: WordChip[] = [
    { text: '長い', originalStart: 100, originalEnd: 200 },
    { text: 'アイアン', originalStart: 200, originalEnd: 300 },
    { text: 'です', originalStart: 300, originalEnd: 400 },
  ];

  it('チップがあればチップ境界でテキストを分ける', () => {
    expect(splitTelopText('長いアイアンです', 100, 400, 250, chips)).toEqual([
      '長い',
      'アイアンです',
    ]);
    expect(splitTelopText('長いアイアンです', 100, 400, 350, chips)).toEqual([
      '長いアイアン',
      'です',
    ]);
  });

  it('編集済みでチップ連結と一致しないテキストは、チップ境界の文字数で近似分割する', () => {
    // チップ連結 '長いアイアンです'(8字) と異なる 9 字のテキスト。左チップ計 2 字 → 2 字で切る。
    expect(splitTelopText('短いアイアンですよ', 100, 400, 250, chips)).toEqual([
      '短い',
      'アイアンですよ',
    ]);
  });

  it('チップが無ければ時間比で分割する', () => {
    expect(splitTelopText('ABCD', 0, 400, 200, [])).toEqual(['AB', 'CD']);
    expect(splitTelopText('ABCD', 0, 400, 100, [])).toEqual(['A', 'BCD']);
  });

  it('片側が空になる位置でも両側 1 文字以上を保つ（時間比フォールバック）', () => {
    // 全チップの中点が atFrame 以降 → チップ分割不成立 → 時間比 (110-100)/300 ≒ 0 → 先頭 1 字
    expect(splitTelopText('長いアイアンです', 100, 400, 110, chips)).toEqual([
      '長',
      'いアイアンです',
    ]);
  });

  it('1 文字以下のテキストは分けられず左へ寄せる', () => {
    expect(splitTelopText('あ', 100, 400, 250, [])).toEqual(['あ', '']);
    expect(splitTelopText('', 100, 400, 250, [])).toEqual(['', '']);
  });
});

describe('mergeSegments', () => {
  it('2 つを 1 つに結合し区間を合算する', () => {
    const second: EditorTelop = { id: 2, originalStart: 400, originalEnd: 700, text: 'です' };
    const merged = mergeSegments(base, second, 50);
    expect(merged).toMatchObject({
      id: 50,
      originalStart: 100,
      originalEnd: 700,
      text: '長いアイアンです',
    });
  });

  it('先頭セグメントの属性を引き継ぐ', () => {
    const second: EditorTelop = { id: 2, originalStart: 400, originalEnd: 700, text: 'です' };
    expect(mergeSegments(base, second, 50).template).toBe(2);
  });
});

describe('telopAtFrame', () => {
  const telops: EditorTelop[] = [
    { id: 1, originalStart: 30, originalEnd: 150, text: 'a' },
    { id: 2, originalStart: 200, originalEnd: 320, text: 'b' },
  ];

  it('区間内のフレームはそのテロップを返す', () => {
    expect(telopAtFrame(telops, 90)?.id).toBe(1);
    expect(telopAtFrame(telops, 250)?.id).toBe(2);
  });

  it('開始フレーム（含む）は該当テロップ、終了フレーム（排他）は該当しない', () => {
    expect(telopAtFrame(telops, 30)?.id).toBe(1);
    expect(telopAtFrame(telops, 150)).toBeUndefined();
  });

  it('どのテロップにも無いフレームは undefined', () => {
    expect(telopAtFrame(telops, 0)).toBeUndefined();
    expect(telopAtFrame(telops, 175)).toBeUndefined();
  });

  it('空配列は undefined', () => {
    expect(telopAtFrame([], 90)).toBeUndefined();
  });

  it('テロップが重なる場合は配列順で最初にマッチしたものを返す', () => {
    const overlapping: EditorTelop[] = [
      { id: 1, originalStart: 30, originalEnd: 200, text: 'a' },
      { id: 2, originalStart: 100, originalEnd: 320, text: 'b' },
    ];
    expect(telopAtFrame(overlapping, 150)?.id).toBe(1);
  });
});

describe('telopsAtFrame', () => {
  const telops = [
    { id: 1, originalStart: 0, originalEnd: 100, text: 'a' },
    { id: 2, originalStart: 50, originalEnd: 200, text: 'b' },
    { id: 3, originalStart: 300, originalEnd: 400, text: 'c' },
  ] as any;
  it('指定フレームで重なる全テロップを入力順で返す', () => {
    expect(telopsAtFrame(telops, 60).map((t) => t.id)).toEqual([1, 2]);
  });
  it('該当なしは空配列', () => {
    expect(telopsAtFrame(telops, 250)).toEqual([]);
  });
  it('endFrame は排他（境界は含まない）', () => {
    expect(telopsAtFrame(telops, 100).map((t) => t.id)).toEqual([2]);
  });

  it('装飾テロップ（manual）は字幕と重なっても両方返す（全期間表示）', () => {
    const withDecoration = [
      { id: 1, originalStart: 0, originalEnd: 400, text: '装飾', manual: true },
      { id: 2, originalStart: 50, originalEnd: 200, text: '字幕' },
    ] as any;
    expect(telopsAtFrame(withDecoration, 60).map((t) => t.id)).toEqual([1, 2]);
  });
});

describe('clampSubtitleRange × splitSegment（分割後の重なり・不正区間の回帰確認）', () => {
  it('分割で生成した左右セグメントは隣接し合うのみで重ならない（clampSubtitleRange を通しても不変）', () => {
    const [left, right] = splitSegment(base, 250, '長い', 'アイアン', 99);
    const telops = [left, right];
    const clampedLeft = clampSubtitleRange(telops, left.id, left.originalStart, left.originalEnd);
    const clampedRight = clampSubtitleRange(telops, right.id, right.originalStart, right.originalEnd);
    expect(clampedLeft).toEqual({ originalStart: left.originalStart, originalEnd: left.originalEnd });
    expect(clampedRight).toEqual({ originalStart: right.originalStart, originalEnd: right.originalEnd });
  });

  it('隣の字幕へ食い込む不正区間はクランプされ、装飾（manual）は素通しになる', () => {
    const telops: EditorTelop[] = [
      { id: 1, originalStart: 100, originalEnd: 400, text: 'a' },
      { id: 2, originalStart: 400, originalEnd: 700, text: 'b' },
    ];
    // id:1 を後方へ伸ばして id:2 の区間へ食い込ませた不正入力
    expect(clampSubtitleRange(telops, 1, 100, 500)).toEqual({ originalStart: 100, originalEnd: 400 });

    const withDecoration: EditorTelop[] = [
      ...telops,
      { id: 3, originalStart: 0, originalEnd: 1000, text: '装飾', manual: true },
    ];
    // manual テロップは他の字幕と重なっても素通し（クランプしない）
    expect(clampSubtitleRange(withDecoration, 3, 0, 1000)).toEqual({ originalStart: 0, originalEnd: 1000 });
  });
});

describe('newlineSplitPlan（改行位置での分割計画）', () => {
  // 「動画編集者の方から\n営業のDMを」実バグ再現: 分割は改行位置で割るべき
  const chips = [
    { text: '動画編集者の方から', originalStart: 100, originalEnd: 200 },
    { text: '営業の', originalStart: 200, originalEnd: 260 },
    { text: 'DMを', originalStart: 260, originalEnd: 300 },
  ];

  it('改行があれば改行位置のチップ境界フレームと左右テキストを返す', async () => {
    const { newlineSplitPlan } = await import('./segmentOps');
    const plan = newlineSplitPlan('動画編集者の方から\n営業のDMを', chips, 100, 300);
    expect(plan).not.toBeNull();
    expect(plan!.leftText).toBe('動画編集者の方から');
    expect(plan!.rightText).toBe('営業のDMを');
    // チップ境界 = 「から」end(200) と「営業の」start(200) の中点 = 200
    expect(plan!.atFrame).toBe(200);
  });

  it('改行が無ければ null（従来の時間中央分割に委ねる）', async () => {
    const { newlineSplitPlan } = await import('./segmentOps');
    expect(newlineSplitPlan('動画編集者の方から営業のDMを', chips, 100, 300)).toBeNull();
  });

  it('先頭/末尾の改行は分割位置にならない（null）', async () => {
    const { newlineSplitPlan } = await import('./segmentOps');
    expect(newlineSplitPlan('\n営業のDMを', chips, 100, 300)).toBeNull();
    expect(newlineSplitPlan('営業のDMを\n', chips, 100, 300)).toBeNull();
  });

  it('チップとテキストが照合できない場合は文字比率でフレームを出す', async () => {
    const { newlineSplitPlan } = await import('./segmentOps');
    // 誤字修正済みでチップと不一致（12文字中6文字目に改行）
    const plan = newlineSplitPlan('あいうえおか\nきくけこさし', chips, 100, 300);
    expect(plan).not.toBeNull();
    expect(plan!.leftText).toBe('あいうえおか');
    expect(plan!.rightText).toBe('きくけこさし');
    // 比率 6/12 = 0.5 → 100 + 200*0.5 = 200
    expect(plan!.atFrame).toBe(200);
  });

  it('atFrame は区間内へクランプされる', async () => {
    const { newlineSplitPlan } = await import('./segmentOps');
    // 改行がほぼ先頭 → チップ境界が区間端に寄っても originalStart+1 以上
    const plan = newlineSplitPlan('動\n画編集者の方から営業のDMを', chips, 100, 300);
    expect(plan).not.toBeNull();
    expect(plan!.atFrame).toBeGreaterThan(100);
    expect(plan!.atFrame).toBeLessThan(300);
  });
});

describe('splitTelopText × 改行入りテキスト（照合ズレ修正）', () => {
  const chips = [
    { text: '動画編集者の方から', originalStart: 100, originalEnd: 200 },
    { text: '営業の', originalStart: 200, originalEnd: 260 },
    { text: 'DMを', originalStart: 260, originalEnd: 300 },
  ];
  it('改行入りでもチップ照合が成立し、チップ境界どおりに分配される', () => {
    // atFrame=230 → 営業の の中点(230)ちょうど…中点<atFrame判定なので 営業の は右
    const [left, right] = splitTelopText('動画編集者の方から\n営業のDMを', 100, 300, 205, chips);
    expect(left).toBe('動画編集者の方から');
    expect(right).toBe('営業のDMを');
  });
});
