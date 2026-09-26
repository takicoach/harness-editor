/**
 * 差分レビューの学習まわり文言の回帰（2026-08-08 の UX 欠陥3点）。
 *
 * ① 完了表示が「ルールを 0 件昇格しました」だけで、記録はされたのに何も起きなかった
 *    ように読めた。昇格閾値は distinct videoId で 2（TELOP_RULE_PROMOTION_THRESHOLD）
 *    なので、1 本目では 0 件昇格が正常。
 * ② 蒸留の案内が `/video-harness:learn` という実在しないコマンドを指していた。
 * ③ テロップ学習の対象がテキスト変更のみ（telopLearning.ts の仕様）と書かれていなかった。
 */

import { describe, it, expect } from 'vitest';
import {
  learningDoneSummary,
  learningPromotionNote,
  distillHintText,
  TELOP_LEARNING_SCOPE_NOTE,
} from './DiffReviewPanel';

describe('learningDoneSummary', () => {
  it('記録件数と昇格件数の両方を出す（記録されたことが読み取れる）', () => {
    const s = learningDoneSummary(5, 2, 0);
    expect(s).toContain('5');
    expect(s).toContain('2');
    expect(s).toContain('記録');
    expect(s).toContain('昇格');
  });

  it('昇格 0 件でも「記録した」ことを先に言う（何も起きなかったと読ませない）', () => {
    const s = learningDoneSummary(3, 0, 0);
    expect(s).toContain('3');
    expect(s.indexOf('記録')).toBeLessThan(s.indexOf('昇格'));
  });

  it('競合があれば件数を添える・無ければ書かない', () => {
    expect(learningDoneSummary(4, 1, 2)).toContain('競合');
    expect(learningDoneSummary(4, 1, 0)).not.toContain('競合');
  });
});

describe('learningPromotionNote', () => {
  it('昇格には別の動画でのもう1回の観測が要ることを書く（閾値 2 の説明）', () => {
    const note = learningPromotionNote();
    expect(note).toContain('別の動画');
    expect(note).toContain('昇格');
  });
});

describe('distillHintText', () => {
  it('件数を含み、実在する /video-harness:learn スキルを案内する', () => {
    const t = distillHintText(42);
    expect(t).toContain('42');
    expect(t).toContain('/video-harness:learn');
  });

  it('旧スキル名（distill 系）は案内しない', () => {
    expect(distillHintText(42)).not.toContain('distill');
  });
});

describe('TELOP_LEARNING_SCOPE_NOTE', () => {
  it('テキスト変更のみが対象で、タイミング・スタイル・配置は対象外だと書く', () => {
    expect(TELOP_LEARNING_SCOPE_NOTE).toContain('テキスト');
    expect(TELOP_LEARNING_SCOPE_NOTE).toContain('タイミング');
    expect(TELOP_LEARNING_SCOPE_NOTE).toContain('スタイル');
    expect(TELOP_LEARNING_SCOPE_NOTE).toContain('配置');
    expect(TELOP_LEARNING_SCOPE_NOTE).toContain('対象外');
  });
});

describe('learningDoneSummary（新画面・設計書 D9）', () => {
  it('記録済みまたは重複で弾いた分があれば「（うち K 件は記録済みまたは重複のため数えていません）」を同じ文に足す', () => {
    expect(learningDoneSummary(0, 0, 0, 3)).toBe('修正 0 件を記録しました（ルール昇格 0 件）（うち 3 件は記録済みまたは重複のため数えていません）。');
  });
  it('弾いた分が無ければ OSS と同じ文のまま', () => {
    expect(learningDoneSummary(2, 1, 1)).toBe('修正 2 件を記録しました（ルール昇格 1 件・競合 1 件はスキップ）。');
    expect(learningDoneSummary(2, 1, 0, 0)).toBe('修正 2 件を記録しました（ルール昇格 1 件）。');
  });
});
