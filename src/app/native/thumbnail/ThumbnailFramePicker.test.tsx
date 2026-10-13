// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { VIDEO_ASSET } from '../../../core/thumbnail/fixtures';
import { ThumbnailFramePicker } from './ThumbnailFramePicker';
import type { ThumbnailEditor } from './useThumbnailEditor';

function setup() {
  const addLayer = vi.fn(async () => true), onClose = vi.fn();
  const editor = { projectId: 'p', disabled: false, addLayer, newLayerId: () => 'l-1' } as unknown as ThumbnailEditor;
  const view = render(<ThumbnailFramePicker editor={editor} asset={VIDEO_ASSET} ensure={async () => true} onClose={onClose} />);
  return { ...view, addLayer, video: () => view.container.querySelector('video')! };
}
afterEach(cleanup);

describe('コマ選びの見本', () => {
  it('原本を再生できなければ、動画側と同じ軽量版（preview=1）に切り替えて見せる。選んだ時刻は原本の秒のまま', async () => {
    const { video, container, addLayer } = setup();
    expect(video().getAttribute('src')).toBe('/api/sequence/asset?id=p&asset=vid-1');
    fireEvent.error(video());
    expect(video().getAttribute('src')).toBe('/api/sequence/asset?id=p&asset=vid-1&preview=1');
    expect(container.textContent).toContain('軽量版で表示しています');
    fireEvent.change(container.querySelector('input[type=range]')!, { target: { value: '2' } });
    await act(async () => { fireEvent.click([...container.querySelectorAll('button')].find(button => button.textContent === 'このコマを背景にする')!); });
    expect(addLayer).toHaveBeenCalledTimes(1);
    const layer = (addLayer.mock.calls[0] as unknown as [{ content: { assetId: string; sourceTime: { num: number; den: number } } }])[0];
    expect(layer.content.assetId).toBe('vid-1');
    expect(layer.content.sourceTime).toEqual({ num: 1, den: 12 });
  });
  it('軽量版も再生できなければ、動画の編集画面で軽量版を作るよう案内する', () => {
    const { video, container } = setup();
    fireEvent.error(video());
    fireEvent.error(video());
    const status = container.querySelector('[role=status]');
    expect(status?.textContent).toContain('この動画はここでは再生できません');
    expect(status?.textContent).toContain('動画の編集画面');
    expect(status?.textContent).toContain('軽量化する');
    // 見えないまま選ばせない。
    const place = [...container.querySelectorAll('button')].find(button => button.textContent === 'このコマを背景にする') as HTMLButtonElement;
    expect(place.disabled).toBe(true);
  });
});
