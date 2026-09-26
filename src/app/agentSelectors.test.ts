/**
 * AI エージェント（コンピュータユース）向けの安定セレクタの在処を、
 * 実ソースの文字列として固定する。
 *
 * ベースライン計測では編集画面の <button> 174 個のうち data-testid / aria-label を
 * 持つものが 6 個しかなく、エージェントは CSS クラスと並び順に頼るしかなかった。
 * ここが赤くなったら「名前で指名できる操作が減った」ということ。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(APP_DIR, rel), 'utf8');

describe('主要操作の data-testid', () => {
  it('ツールバー: 保存・書き出し・undo・redo・警告バッジ', () => {
    const src = read('panels/Toolbar.tsx');
    for (const id of [
      'toolbar-save',
      'toolbar-export',
      'toolbar-undo',
      'toolbar-redo',
      'toolbar-warn-badge',
      'render-status',
    ]) {
      expect(src, id).toContain(`data-testid="${id}"`);
    }
  });

  it('タイムライン: ＋追加・カット・ヘッドで分割・吸着・ズーム±', () => {
    const src = read('panels/Timeline.tsx');
    for (const id of [
      'timeline-add',
      'timeline-cut',
      'timeline-split',
      'timeline-snap',
      'timeline-cuts-bypass',
      'timeline-zoom-in',
      'timeline-zoom-out',
    ]) {
      expect(src, id).toContain(`data-testid="${id}"`);
    }
  });

  it('タイムラインのクリップは clip-<種別>-<id> で指名できる', () => {
    const tracks: [string, string][] = [
      ['timeline/TelopTrack.tsx', 'clip-telop-'],
      ['timeline/SeTrack.tsx', 'clip-se-'],
      ['timeline/ImageTrack.tsx', 'clip-image-'],
      ['timeline/BgmTrack.tsx', 'clip-bgm-'],
      ['timeline/VideoInsertTrack.tsx', 'clip-video-'],
      ['timeline/ShapeTrack.tsx', 'clip-shape-'],
      ['timeline/CutTrack.tsx', 'clip-cut-'],
      ['timeline/CutTrack.tsx', 'clip-segment-'],
    ];
    for (const [rel, prefix] of tracks) {
      expect(read(rel), `${rel} ${prefix}`).toContain(`data-testid={\`${prefix}`);
    }
  });

  it('インスペクタ: 位置・大きさ・文字の入力欄', () => {
    const fields = read('panels/inspector/TelopPositionFields.tsx');
    for (const key of ['pos-x', 'pos-y', 'scale']) {
      expect(fields, key).toContain(`data-testid={\`\${idPrefix}-${key}\`}`);
    }
    expect(read('panels/inspector/SettingsTab.tsx')).toContain('data-testid="ins-telop-text"');
  });

  it('ホーム: 案件カードは project-card-<id>', () => {
    expect(read('panels/HomeDashboard.tsx')).toContain('data-testid={`project-card-${p.id}`}');
  });

  it('位置プリセット 9 個は座標ではなく言葉で押せる', () => {
    expect(read('panels/inspector/TelopPositionFields.tsx')).toContain('aria-label={positionPresetLabel(');
  });
});
