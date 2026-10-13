import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThumbnailAiRequest } from '../../shared/thumbnailAi';
import { ThumbnailAiRequestStore } from './aiRequests';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const project = () => { const directory = mkdtempSync(join(tmpdir(), 'thumb-ai-req-')); directories.push(directory); return directory; };
const request = (requestId: string): ThumbnailAiRequest => ({ requestId, route: 'direct', projectId: 'p', documentId: 'd', kind: 'new', targetPageId: null, targetPageName: null,
  targetFingerprint: null, cutout: 'auto', note: '', phase: 'working', frames: [], nextFrame: 1, previews: 0, apply: null, createdAt: 't', updatedAt: 't' });

describe('ThumbnailAiRequestStore', () => {
  it('置いた記録を ID で読め、最後に置いたものが latest。別の案件からは見えない', () => {
    const a = project(), b = project();
    new ThumbnailAiRequestStore(a).put(request('d-1'));
    new ThumbnailAiRequestStore(a).put(request('d-2'));
    expect(new ThumbnailAiRequestStore(a).get('d-1')?.requestId).toBe('d-1');
    expect(new ThumbnailAiRequestStore(a).latest()?.requestId).toBe('d-2');
    expect(new ThumbnailAiRequestStore(b).get('d-1')).toBeUndefined();
  });
  it('update は読み直してから変える。無い ID は例外', () => {
    const a = project(), store = new ThumbnailAiRequestStore(a);
    store.put(request('d-1'));
    expect(store.update('d-1', current => ({ ...current, phase: 'reviewing' })).phase).toBe('reviewing');
    expect(new ThumbnailAiRequestStore(a).get('d-1')?.phase).toBe('reviewing');
    expect(() => store.update('d-9', current => current)).toThrow('依頼の記録がありません');
  });
  it('100 件を超えたら古い順に捨てる', () => {
    const store = new ThumbnailAiRequestStore(project());
    for (let index = 0; index < 105; index += 1) store.put(request(`d-${index}`));
    expect(store.all()).toHaveLength(100);
    expect(store.get('d-0')).toBeUndefined();
  });
  it('壊れた記録は消さずに別名で残し、空から始める', () => {
    const a = project();
    mkdirSync(join(a, '.harness'), { recursive: true });
    writeFileSync(join(a, '.harness', 'thumbnail-ai.requests.v1.json'), '{壊れ');
    expect(new ThumbnailAiRequestStore(a).all()).toEqual([]);
    expect(readdirSync(join(a, '.harness')).some(name => name.startsWith('thumbnail-ai.requests.v1.json.broken-'))).toBe(true);
    expect(existsSync(join(a, '.harness', 'thumbnail-ai.requests.v1.json'))).toBe(false);
  });
});
