import { describe, expect, it } from 'vitest';
import { EDITOR_BRIEF, EDITOR_REQUEST_WORKFLOW, SLIDES_REQUEST_WORKFLOW, THUMBNAIL_REQUEST_WORKFLOW, editorGuide, firstPrompt, slidesRequestText, withRequestNumber } from './agentPrompts';

describe('AI タブの説明書', () => {
  it('短い説明書は 700 字以内で、毎回の editor_context・手順・断られた時・依頼番号の返し方を含む', () => {
    expect(EDITOR_BRIEF.length).toBeLessThanOrEqual(700);
    for (const word of ['editor_context', 'editor_guide', 'switchedSinceRequest', 'TARGET_NOT_REQUESTED', 'report_instruction_status', '（依頼 #', '推測で案件を決めず'])
      expect(EDITOR_BRIEF).toContain(word);
  });
  it('モード別の手順: スライドは移したスライドの手順、動画は既存の編集手順、サムネはサムネの手順', () => {
    expect(editorGuide('slides')).toContain(SLIDES_REQUEST_WORKFLOW);
    expect(editorGuide('video')).toContain(EDITOR_REQUEST_WORKFLOW);
    expect(editorGuide('video')).toContain('editorSessionId');
    expect(editorGuide('thumbnail')).toContain(THUMBNAIL_REQUEST_WORKFLOW);
    expect(editorGuide('thumbnail')).toContain('thumbnail_apply');
  });
  it('最初の依頼: 説明書・今の状況・日本語 1 行のあいさつ・まだ編集しない', () => {
    const prompt = firstPrompt({ projectName: '10月の講義', mode: 'thumbnail' });
    expect(prompt.startsWith(EDITOR_BRIEF)).toBe(true);
    expect(prompt).toContain('「10月の講義（サムネ）を見ています。何をしましょう？」');
    expect(prompt).toContain('まだ何も編集しない');
    expect(prompt).not.toContain('\n');
    expect(firstPrompt(null)).toContain('「ホームにいます。直したい案件を開いてから頼んでください。」');
  });
});

describe('ボタンの依頼文（短い 1 行）', () => {
  it('スライドの依頼は「スライド:」で始まり、手順は付けない。番号は末尾に付ける', () => {
    expect(slidesRequestText('outline')).toBe('スライド: 構成案を作って');
    expect(slidesRequestText('pages', ['s3', 's4'])).toBe('スライド: ページ s3・s4 の本文を作って');
    expect(slidesRequestText('pages')).toBe('スライド: 本文がまだのページを全部作って');
    expect(slidesRequestText('regenerate', ['s2'])).toBe('スライド: ページ s2 を作り直して');
    expect(slidesRequestText('shorten', ['s2'])).toBe('スライド: ページ s2 の文字を短くして作り直して');
    expect(withRequestNumber('スライド: 構成案を作って', 'inst-12')).toBe('スライド: 構成案を作って（依頼 #12）');
  });
});
