import { describe, expect, it } from 'vitest';
import { AI_MODES, aiFocusBeatSchema, aiScreenLabel, aiScreenSchema, type AiScreen } from './aiFocus';

const screen = (over: Partial<AiScreen> = {}): AiScreen => ({ projectId: 'lesson', projectName: '講義', mode: 'video',
  target: { kind: 'video', editorSessionId: 'window-1' }, playheadSec: 12.5, selection: ['clip-1'], materials: '素材 2 件', ...over });

describe('画面の状況の型', () => {
  it('3 つのモードと、それぞれの書き込み先を受け付ける', () => {
    expect(AI_MODES).toEqual(['video', 'slides', 'thumbnail']);
    expect(aiScreenSchema.parse(screen())).toEqual(screen());
    expect(aiScreenSchema.parse(screen({ mode: 'slides', target: { kind: 'slides', documentId: 'd', sessionId: 's', revision: 3 } })).mode).toBe('slides');
    expect(aiScreenSchema.parse(screen({ mode: 'thumbnail', target: { kind: 'thumbnail', documentId: 'd', sessionId: 's', revision: 0, pageId: null } })).mode).toBe('thumbnail');
  });
  it('知らないモード・余分な項目・空の名前は断る', () => {
    expect(aiScreenSchema.safeParse({ ...screen(), mode: 'audio' }).success).toBe(false);
    expect(aiScreenSchema.safeParse({ ...screen(), secret: 'x' }).success).toBe(false);
    expect(aiScreenSchema.safeParse(screen({ projectName: '' })).success).toBe(false);
  });
  it('定期報告は pageId・連番・状況（ホームなら null）', () => {
    expect(aiFocusBeatSchema.parse({ pageId: 'page-0001', seq: 1, screen: null })).toEqual({ pageId: 'page-0001', seq: 1, screen: null });
    expect(aiFocusBeatSchema.safeParse({ pageId: 'p', seq: 1, screen: null }).success).toBe(false);
  });
  it('表記は「名前（モード）」、無ければ「ホーム」', () => {
    expect(aiScreenLabel({ projectName: '講義', mode: 'thumbnail' })).toBe('講義（サムネ）');
    expect(aiScreenLabel(null)).toBe('ホーム');
    expect(aiScreenLabel({ projectName: null, mode: null })).toBe('ホーム');
  });
});
