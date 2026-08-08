import { describe, expect, it } from 'vitest';
import { LARGE_UPLOAD_NOTICE_BYTES, largeUploadNotice } from './uploadNotice';

describe('largeUploadNotice', () => {
  it('しきい値以下は案内なし', () => {
    expect(largeUploadNotice(0)).toBeNull();
    expect(largeUploadNotice(LARGE_UPLOAD_NOTICE_BYTES)).toBeNull();
  });

  it('しきい値超は GB/MB 表記つきの案内文を返す', () => {
    expect(largeUploadNotice(700 * 1024 * 1024)).toContain('700MB');
    expect(largeUploadNotice(4.5 * 1024 * 1024 * 1024)).toContain('4.5GB');
    expect(largeUploadNotice(LARGE_UPLOAD_NOTICE_BYTES + 1)).toContain('軽量化');
  });
});
