import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { thumbnailFixture } from '../../core/thumbnail/fixtures';
import { pageToSequence } from '../../core/thumbnail/pageToSequence';
import { ThumbnailRenderInputs } from './renderInputs';

describe('ThumbnailRenderInputs', () => {
  it('登録した文書を、解除するまで描画ページへ渡す', () => {
    const directory = mkdtempSync(join(tmpdir(), 'thumb-inputs-')), inputs = new ThumbnailRenderInputs(), document = pageToSequence(thumbnailFixture(), 'page-a');
    try {
      const release = inputs.register(directory, 'job-1', document);
      expect(inputs.get(directory, 'job-1')).toEqual(document);
      release();
      expect(() => inputs.get(directory, 'job-1')).toThrow('描画する入力が見つかりません');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
