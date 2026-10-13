import { describe, expect, it } from 'vitest';
import { thumbnailAiButtonSchema, thumbnailAiRequestText, thumbnailAiStatus, type ThumbnailAiRequest } from './thumbnailAi';

const base: ThumbnailAiRequest = { requestId: 'inst-14', route: 'button', projectId: 'p', documentId: 'd', kind: 'new', targetPageId: null, targetPageName: null,
  targetFingerprint: null, cutout: 'auto', note: '', phase: 'working', frames: [], nextFrame: 1, previews: 0, apply: null, createdAt: 't', updatedAt: 't' };

describe('thumbnailAiRequestText', () => {
  it('新しい案（入れ替えあり）は入れ替える案と切り抜きの選択を括弧に入れ、ひとことを後ろに付ける', () => {
    expect(thumbnailAiRequestText({ kind: 'new', targetName: '案C', cutout: 'auto', note: '飛距離の回' })).toBe('サムネ: 新しい案を作って（案C と入れ替え・切り抜き: AI に任せる）飛距離の回');
  });
  it('直すは対象の案の名前を出す。ひとことの改行は空白にする', () => {
    expect(thumbnailAiRequestText({ kind: 'edit', targetName: '案B', cutout: 'no', note: '文字を\n大きく' })).toBe('サムネ: 案B を直して（切り抜き: なし）文字を 大きく');
  });
});
describe('thumbnailAiStatus', () => {
  it('送信待ち → 作業中 → 確認中 → 完了の順に決まる', () => {
    expect(thumbnailAiStatus(base, { status: 'pending', reply: null }).status).toBe('pending');
    expect(thumbnailAiStatus(base, { status: 'processing', reply: null }).status).toBe('working');
    expect(thumbnailAiStatus({ ...base, phase: 'reviewing' }, { status: 'processing', reply: null }).status).toBe('reviewing');
    const saved = { ...base, apply: { operationId: 'o', requestHash: 'h', status: 'saved' as const, pageId: 'p', appliedRevision: 2, savedRevision: 2, message: null, evacuatedFile: null, at: 't' } };
    expect(thumbnailAiStatus(saved, { status: 'processing', reply: null }).status).toBe('done');
  });
  it('保存の失敗・AI の失敗の報告は失敗で、理由を添える', () => {
    const failed = { ...base, apply: { operationId: 'o', requestHash: 'h', status: 'save-failed' as const, pageId: 'p', appliedRevision: 2, savedRevision: null, message: '保存できませんでした', evacuatedFile: null, at: 't' } };
    expect(thumbnailAiStatus(failed, null)).toEqual({ status: 'failed', message: '保存できませんでした' });
    expect(thumbnailAiStatus(base, { status: 'failed', reply: '送られませんでした' })).toEqual({ status: 'failed', message: '送られませんでした' });
  });
  it('端末から直接の依頼（受け箱の記録なし）は phase で決まる', () => {
    expect(thumbnailAiStatus({ ...base, route: 'direct' }, null).status).toBe('working');
  });
});
describe('thumbnailAiButtonSchema', () => {
  it('ひとことは 1 行 100 文字まで、requestId は 16 文字以上の英数字とハイフン', () => {
    const ok = { projectId: 'p', kind: 'new', pageId: null, cutout: 'auto', note: 'a', requestId: 'a'.repeat(16), requestCreatedAt: 1 };
    expect(thumbnailAiButtonSchema.safeParse(ok).success).toBe(true);
    expect(thumbnailAiButtonSchema.safeParse({ ...ok, note: 'a'.repeat(101) }).success).toBe(false);
    expect(thumbnailAiButtonSchema.safeParse({ ...ok, requestId: 'short' }).success).toBe(false);
  });
});
