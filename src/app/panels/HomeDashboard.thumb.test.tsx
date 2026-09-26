/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ProjectSummary } from '../../shared/types';
import { HomeDashboard } from './HomeDashboard';

afterEach(() => { cleanup(); localStorage.clear(); });
const base: ProjectSummary = { id: 'p', name: 'p', orientation: 'h', durationLabel: '12:34', sizeLabel: '1 MB', videoFile: null, status: 'telop' as ProjectSummary['status'],
  steps: { transcribe: false, cut: true, telop: 'empty', audio: false, rendered: false } };
function card(project: ProjectSummary): Element {
  const { container } = render(<HomeDashboard projects={[project]} error={null} onPick={vi.fn()} onSetStage={vi.fn()} onCreate={vi.fn()} onProjectsChanged={vi.fn()} now={Date.parse('2026-09-26T00:00:00Z')} />);
  return container.querySelector('.home-card-thumb')!;
}

describe('ホームのカードのサムネイル（設計 M6c）', () => {
  it('画像の作品は先頭の画像を出す', () => {
    const img = card({ ...base, id: 'album', imageAssetId: 'image-abc' }).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/sequence/asset?id=album&asset=image-abc');
  });
  it('音声の作品はアイコンと長さを出し、空欄にしない', () => {
    const thumb = card({ ...base, audioOnly: true });
    expect(screen.getByRole('img', { name: '音声の作品（12:34）' })).toBeTruthy();
    expect(thumb.textContent).toContain('音声 12:34');
    expect(thumb.querySelector('.home-card-thumb-empty')).toBeNull();
  });
  it('どちらでもなければ従来どおり空の背景', () => {
    expect(card(base).querySelector('.home-card-thumb-empty')).not.toBeNull();
  });
});
