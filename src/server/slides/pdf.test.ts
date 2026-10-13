import { describe, expect, it } from 'vitest';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import { renderSlidesPdf, slidesPdfHtml, withDeadline } from './pdf';

const chromiumReady = resolveNativeChromiumBin().ok;
if (!chromiumReady && process.env.HARNESS_REQUIRE_CAPTURE_E2E === '1') throw new Error('PDF の取消の検証に Chromium が必要です');

describe('PDF の HTML', () => {
  it('表示用は 1920×1080 の紙にページの画像を 1 枚ずつ（メモなし）', () => {
    const html = slidesPdfHtml(3, null);
    expect(html.match(/<img /g)).toHaveLength(3);
    expect(html).toContain('@page{size:1920px 1080px;margin:0}');
    expect(html).not.toContain('<p>');
  });
  it('メモ付きは A4 にページ番号・画像・メモ。メモは HTML として解釈しない', () => {
    const html = slidesPdfHtml(2, ['<b>強調</b> & 次へ', '']);
    expect(html).toContain('@page{size:A4;margin:14mm}');
    expect(html).toContain('<h2>1 / 2</h2>');
    expect(html).toContain('&lt;b&gt;強調&lt;/b&gt; &amp; 次へ');
    expect(html.match(/<section>/g)).toHaveLength(2);
  });
});

describe('PDF の期限と取消', () => {
  it('期限（page.pdf に付ける）を過ぎたら理由付きで失敗し、間に合えばそのまま返す', async () => {
    await expect(withDeadline(new Promise<never>(() => undefined), 20, 'PDF の作成が時間内に終わりませんでした')).rejects.toThrow('PDF の作成が時間内に終わりませんでした');
    await expect(withDeadline(Promise.resolve('ok'), 1_000, '期限切れ')).resolves.toBe('ok');
  });
  it.skipIf(!chromiumReady)('Chromium の起動中に取り消したら、起動の直後に取消で止まる（ページを開きに行かない）', async () => {
    const controller = new AbortController();
    // 開けない起点を渡す。取消を確かめずに進むと、取消ではなく接続の失敗になる。
    const pending = renderSlidesPdf({ origin: 'http://127.0.0.1:1', signal: controller.signal, images: [], notes: null });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  }, 60_000);
});
