import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SLIDE_IMAGE_ASSET, slidesFixture } from '../../core/slides/fixtures';
import { slidePageToSequence } from '../../core/slides/pageView';
import { SlidesRenderInputs } from './renderInputs';

describe('SlidesRenderInputs', () => {
  it('撮影の間だけ、ページ番号で 1 コマの文書を渡す。解放した後・範囲外は 404', () => {
    const directory = mkdtempSync(join(tmpdir(), 'slides-inputs-')), inputs = new SlidesRenderInputs(), document = slidesFixture();
    document.assets.push(SLIDE_IMAGE_ASSET);
    try {
      const release = inputs.register(directory, 'job-1', document.pages.map(page => slidePageToSequence(document, page.id)));
      expect(inputs.get(directory, 'job-1', 1).id).toBe('thumbnail.page-2');
      expect(inputs.asset(directory, 'job-1', 'img-1').name).toBe('photo.png');
      expect(() => inputs.get(directory, 'job-1', 2)).toThrow('そのページの入力がありません');
      release();
      expect(() => inputs.get(directory, 'job-1', 0)).toThrow('描画する入力が見つかりません');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
