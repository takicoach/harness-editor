import { describe, it, expect } from 'vitest';
import { subtractRegions, computeCutDelta, labelWords, summarizeForRules, buildLearningRecord, isTranscriptDrifted, mergeWordCounts, aggregateRecords } from './cutLearning';
import type { Transcript } from './types';
import type { WordLabel, CutLearningRecord } from './cutLearning';

describe('subtractRegions', () => {
  it('被減数から減数の重なり部分を削る', () => {
    expect(subtractRegions([{ start: 0, end: 100 }], [{ start: 20, end: 40 }])).toEqual([
      { start: 0, end: 20 }, { start: 40, end: 100 },
    ]);
  });
  it('重ならなければそのまま', () => {
    expect(subtractRegions([{ start: 0, end: 10 }], [{ start: 20, end: 30 }])).toEqual([{ start: 0, end: 10 }]);
  });
  it('完全に覆われたら空', () => {
    expect(subtractRegions([{ start: 10, end: 20 }], [{ start: 0, end: 100 }])).toEqual([]);
  });
  it('複数の減数を順に適用する', () => {
    expect(subtractRegions([{ start: 0, end: 100 }], [{ start: 10, end: 20 }, { start: 30, end: 40 }])).toEqual([
      { start: 0, end: 10 }, { start: 20, end: 30 }, { start: 40, end: 100 },
    ]);
  });
  it('空配列を正しく扱う', () => {
    expect(subtractRegions([], [{ start: 0, end: 10 }])).toEqual([]);
    expect(subtractRegions([{ start: 0, end: 10 }], [])).toEqual([{ start: 0, end: 10 }]);
  });
});

describe('computeCutDelta', () => {
  it('addedRegions=人が切り足した / restoredRegions=人が戻した', () => {
    const delta = computeCutDelta([{ start: 100, end: 200 }], [{ start: 150, end: 260 }]);
    expect(delta.addedRegions).toEqual([{ start: 200, end: 260 }]);
    expect(delta.restoredRegions).toEqual([{ start: 100, end: 150 }]);
  });
  it('差分なしなら両方空', () => {
    const same = [{ start: 0, end: 30 }];
    const delta = computeCutDelta(same, same);
    expect(delta.addedRegions).toEqual([]);
    expect(delta.restoredRegions).toEqual([]);
  });
});

describe('labelWords', () => {
  const fps = 30;
  const transcript: Transcript = {
    durationMs: 3000,
    words: [
      { text: 'あー', start: 0, end: 1000 },
      { text: 'ナイス', start: 1000, end: 2000 },
      { text: 'ショット', start: 2000, end: 3000 },
    ],
    segments: [],
  };
  it('auto/final それぞれの包含でラベルを付ける', () => {
    const labels = labelWords(transcript, fps, [{ start: 60, end: 90 }], [{ start: 0, end: 30 }]);
    expect(labels).toEqual([
      { text: 'あー', startFrame: 0, endFrame: 30, autoCut: false, finalCut: true },
      { text: 'ナイス', startFrame: 30, endFrame: 60, autoCut: false, finalCut: false },
      { text: 'ショット', startFrame: 60, endFrame: 90, autoCut: true, finalCut: false },
    ]);
  });
  it('カット境界をまたぐ単語は完全包含でないため未カット扱い', () => {
    const straddle: Transcript = {
      durationMs: 2000,
      words: [{ text: 'スイング', start: 833, end: 1166 }],
      segments: [],
    };
    const labels = labelWords(straddle, 30, [{ start: 20, end: 30 }], []);
    expect(labels[0]?.autoCut).toBe(false);
    expect(labels[0]?.finalCut).toBe(false);
  });
});

describe('summarizeForRules', () => {
  it('自動が残し人が切った語/自動が切り人が残した語を件数集計し降順', () => {
    const words: WordLabel[] = [
      { text: 'えー', startFrame: 0, endFrame: 5, autoCut: false, finalCut: true },
      { text: 'えー', startFrame: 50, endFrame: 55, autoCut: false, finalCut: true },
      { text: 'あの', startFrame: 100, endFrame: 105, autoCut: false, finalCut: true },
      { text: '素振り', startFrame: 200, endFrame: 230, autoCut: true, finalCut: false },
      { text: 'ナイス', startFrame: 300, endFrame: 330, autoCut: false, finalCut: false },
    ];
    const s = summarizeForRules(words);
    expect(s.keptByAutoCutByHuman).toEqual([{ text: 'えー', count: 2 }, { text: 'あの', count: 1 }]);
    expect(s.cutByAutoKeptByHuman).toEqual([{ text: '素振り', count: 1 }]);
  });
});

describe('buildLearningRecord', () => {
  it('auto/final/delta/words/ruleSummary/video/savedAt を組み立てる', () => {
    const transcript: Transcript = { durationMs: 1000, words: [{ text: 'えー', start: 0, end: 1000 }], segments: [] };
    const record = buildLearningRecord({
      auto: [], final: [{ start: 0, end: 30 }], transcript,
      video: { file: 'video.mp4', fps: 30, durationFrames: 30 }, savedAt: '2026-05-29T11:30:00.000Z',
    });
    expect(record.schemaVersion).toBe(1);
    expect(record.savedAt).toBe('2026-05-29T11:30:00.000Z');
    expect(record.video).toEqual({ file: 'video.mp4', fps: 30, durationFrames: 30 });
    expect(record.autoCutRegions).toEqual([]);
    expect(record.finalCutRegions).toEqual([{ start: 0, end: 30 }]);
    expect(record.delta.addedRegions).toEqual([{ start: 0, end: 30 }]);
    expect(record.delta.restoredRegions).toEqual([]);
    expect(record.words).toEqual([{ text: 'えー', startFrame: 0, endFrame: 30, autoCut: false, finalCut: true }]);
    expect(record.ruleSummary.keptByAutoCutByHuman).toEqual([{ text: 'えー', count: 1 }]);
  });
});

describe('labelWords sourceOffsetMs', () => {
  const fps = 30;
  // "あー" = [1000,2000]ms。offset 0 なら frame[30,60]。
  const transcript: Transcript = {
    durationMs: 2000,
    words: [{ text: 'あー', start: 1000, end: 2000 }],
    segments: [],
  };

  it('既定 0 では従来どおりのフレームになる', () => {
    const labels = labelWords(transcript, fps, [], []);
    expect(labels[0]!.startFrame).toBe(30);
    expect(labels[0]!.endFrame).toBe(60);
  });

  it('sourceOffsetMs ぶん transcript 時刻をずらす（buildWordChips と同式）', () => {
    // offset 1000 → (1000-1000)/1000*30=0, (2000-1000)/1000*30=30 → frame[0,30]
    const labels = labelWords(transcript, fps, [{ start: 0, end: 30 }], [], 1000);
    expect(labels[0]!.startFrame).toBe(0);
    expect(labels[0]!.endFrame).toBe(30);
    expect(labels[0]!.autoCut).toBe(true); // [0,30] が auto [0,30] に完全包含
  });
});

describe('buildLearningRecord sourceOffsetMs', () => {
  it('sourceOffsetMs を labelWords へ素通しする', () => {
    const transcript: Transcript = {
      durationMs: 2000,
      words: [{ text: 'あー', start: 1000, end: 2000 }],
      segments: [],
    };
    const rec = buildLearningRecord({
      auto: [],
      final: [],
      transcript,
      video: { file: 'v.mp4', fps: 30, durationFrames: 60 },
      savedAt: '2026-05-30T00:00:00.000Z',
      sourceOffsetMs: 1000,
    });
    expect(rec.words[0]).toMatchObject({ startFrame: 0, endFrame: 30 });
  });
});

describe('isTranscriptDrifted', () => {
  it('一致なら false', () => {
    expect(isTranscriptDrifted({ durationMs: 100000, wordCount: 800 }, { durationMs: 100000, wordCount: 800 })).toBe(false);
  });
  it('durationMs が 10% 超ズレたら true', () => {
    // 100000 vs 120000 → 20000/120000 = 0.167 > 0.1
    expect(isTranscriptDrifted({ durationMs: 100000, wordCount: 800 }, { durationMs: 120000, wordCount: 800 })).toBe(true);
  });
  it('wordCount が 10% 超ズレたら true', () => {
    // 800 vs 1000 → 200/1000 = 0.2 > 0.1
    expect(isTranscriptDrifted({ durationMs: 100000, wordCount: 800 }, { durationMs: 100000, wordCount: 1000 })).toBe(true);
  });
  it('ちょうど 10% は許容（false）', () => {
    // 90000 vs 100000 → 10000/100000 = 0.1（> ではない）
    expect(isTranscriptDrifted({ durationMs: 90000, wordCount: 800 }, { durationMs: 100000, wordCount: 800 })).toBe(false);
  });
  it('両方 0 は false（ゼロ除算回避）', () => {
    expect(isTranscriptDrifted({ durationMs: 0, wordCount: 0 }, { durationMs: 0, wordCount: 0 })).toBe(false);
  });
});

describe('buildLearningRecord transcriptDrifted', () => {
  const transcript: Transcript = {
    durationMs: 100000,
    words: Array.from({ length: 800 }, (_, i) => ({ text: 'x', start: i, end: i + 1 })),
    segments: [],
  };
  const base = {
    auto: [] as { start: number; end: number }[],
    final: [] as { start: number; end: number }[],
    transcript,
    video: { file: 'v.mp4', fps: 30, durationFrames: 60 },
    savedAt: '2026-05-30T00:00:00.000Z',
  };
  it('transcriptDigest 未指定なら false', () => {
    expect(buildLearningRecord(base).transcriptDrifted).toBe(false);
  });
  it('digest が現 transcript と乖離なら true', () => {
    expect(buildLearningRecord({ ...base, transcriptDigest: { durationMs: 1, wordCount: 1 } }).transcriptDrifted).toBe(true);
  });
  it('digest が現 transcript と一致なら false', () => {
    expect(buildLearningRecord({ ...base, transcriptDigest: { durationMs: 100000, wordCount: 800 } }).transcriptDrifted).toBe(false);
  });
});

describe('mergeWordCounts', () => {
  it('テキストごとに合算し件数降順・同数はテキスト昇順', () => {
    const merged = mergeWordCounts([
      [{ text: 'えー', count: 3 }, { text: 'あの', count: 1 }],
      [{ text: 'えー', count: 2 }, { text: 'まあ', count: 5 }],
    ]);
    // えー=5, まあ=5, あの=1。5 が同数 → text 昇順（え < ま）。
    expect(merged).toEqual([
      { text: 'えー', count: 5 },
      { text: 'まあ', count: 5 },
      { text: 'あの', count: 1 },
    ]);
  });
  it('空入力は空配列', () => {
    expect(mergeWordCounts([])).toEqual([]);
  });
});

describe('aggregateRecords', () => {
  function rec(over: Partial<CutLearningRecord>): CutLearningRecord {
    return {
      schemaVersion: 1,
      savedAt: '2026-05-30T00:00:00.000Z',
      video: { file: 'v.mp4', fps: 30, durationFrames: 60 },
      autoCutRegions: [],
      finalCutRegions: [],
      delta: { addedRegions: [], restoredRegions: [] },
      words: [],
      ruleSummary: { keptByAutoCutByHuman: [], cutByAutoKeptByHuman: [] },
      transcriptDrifted: false,
      ...over,
    };
  }

  it('複数レコードの ruleSummary を横断合算し projects/records を含める', () => {
    const items = [
      { path: '/a/cutLearning.json', record: rec({ ruleSummary: { keptByAutoCutByHuman: [{ text: 'えー', count: 2 }], cutByAutoKeptByHuman: [] } }) },
      { path: '/b/cutLearning.json', record: rec({ ruleSummary: { keptByAutoCutByHuman: [{ text: 'えー', count: 3 }], cutByAutoKeptByHuman: [{ text: '素振り', count: 1 }] } }) },
    ];
    const agg = aggregateRecords(items);
    expect(agg.schemaVersion).toBe(1);
    expect(agg.projectCount).toBe(2);
    expect(agg.ruleSummary.keptByAutoCutByHuman).toEqual([{ text: 'えー', count: 5 }]);
    expect(agg.ruleSummary.cutByAutoKeptByHuman).toEqual([{ text: '素振り', count: 1 }]);
    expect(agg.projects).toEqual([
      { path: '/a/cutLearning.json', video: { file: 'v.mp4', fps: 30, durationFrames: 60 }, savedAt: '2026-05-30T00:00:00.000Z', transcriptDrifted: false },
      { path: '/b/cutLearning.json', video: { file: 'v.mp4', fps: 30, durationFrames: 60 }, savedAt: '2026-05-30T00:00:00.000Z', transcriptDrifted: false },
    ]);
    expect(agg.records).toHaveLength(2);
  });

  it('transcriptDrifted 欠落の古いレコードは false 扱い（projects と records 両方）', () => {
    const legacy = rec({});
    delete (legacy as Partial<CutLearningRecord>).transcriptDrifted;
    const agg = aggregateRecords([{ path: '/c/cutLearning.json', record: legacy }]);
    expect(agg.projects[0]!.transcriptDrifted).toBe(false);
    // 出力 records[] も CutLearningRecord 契約を満たすよう false で補完される。
    expect(agg.records[0]!.transcriptDrifted).toBe(false);
  });
});
