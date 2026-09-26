/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { SequenceDocument } from '../../core/sequence/model';
import { rational as r } from '../../core/sequence/time';
import { speedUnavailableMessage } from './speedSettings';
import { NativeGlobalSpeedSettings } from './NativeSpeedSettings';
import { NATIVE_TUTORIAL_STEPS, tutorialTarget } from '../tutorial/nativeTutorialSteps';
import { HELP_TOPICS } from '../help/helpTopics';

afterEach(cleanup);
const settings = { gainDb: 0, muted: false, fadeInFrames: 0, fadeOutFrames: 0 };
function audioWork(): SequenceDocument {
  return { schemaVersion: 2, id: 'doc', name: '音声', revision: 0, fps: r(30), resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 60, background: '#000000',
    assets: [{ id: 'media-a', kind: 'media', name: 'talk.wav', file: '.harness/assets/a.wav', fingerprint: 'a'.repeat(64), streams: [{ index: 0, kind: 'audio', codec: 'pcm_s16le', duration: r(2), sampleRate: 48000, channels: 1 }] }],
    tracks: [{ id: 'a-main', name: '原音1', kind: 'audio', enabled: true }],
    clips: [{ id: 'speech', name: 'talk.wav', trackId: 'a-main', startFrame: 0, durationFrames: 60, clock: { offset: r(0), rate: r(1), duration: r(60) },
      content: { kind: 'audio', assetId: 'media-a', streamIndex: 0, sourceIn: r(0), rate: r(1), role: 'speech', loop: false, endBehavior: 'silence', settings } }],
    transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
}

describe('音声作品で使えない機能の案内（設計 M2b）', () => {
  it('全体の速度: 音声だけの作品では「映像を追加」ではなく「音声だけの作品では使えません」', () => {
    expect(speedUnavailableMessage(audioWork())).toContain('音声だけの作品では使えません');
    render(<NativeGlobalSpeedSettings document={audioWork()} selected={[]} disabled={false} onEdit={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getByText(/音声だけの作品では使えません/)).toBeTruthy();
    expect(screen.queryByText(/映像素材を追加してください/)).toBeNull();
  });
  it('音声の無い作品（画像だけなど）は従来どおり映像の追加を案内する', () => {
    const images = { ...audioWork(), clips: [], tracks: [] };
    expect(speedUnavailableMessage(images)).toBe('登録できる映像がありません。映像素材を追加してください。');
  });
});

describe('画面の文言（設計 M6）', () => {
  const PHRASE = '音声（ポッドキャスト）や画像からも作れます';
  it('チュートリアルの welcome と作成の手順に足し、目印は変えない', () => {
    const step = (id: string) => NATIVE_TUTORIAL_STEPS.find((s) => s.id === id)!;
    expect(String(step('welcome').text)).toContain(PHRASE);
    expect(String(step('create').text)).toContain(PHRASE);
    expect(step('create').target).toBe(tutorialTarget('home-create'));
  });
  it('ヘルプの「動画を作成する」に足す', () => {
    const topic = HELP_TOPICS.find((item) => item.id === 'create')!;
    expect(topic.title).toBe('動画を作成する');
    expect(topic.description).toContain(PHRASE);
  });
});
