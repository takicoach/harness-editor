import { afterEach, expect, it, vi } from 'vitest';
import { loadCaptureImage, loadCaptureTelop } from './loadComponent';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('uses the capture API and preserves the server component error before creating a Blob', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Telop.tsx: unsupported frame API' }), { status: 500 }));
  vi.stubGlobal('fetch', fetchMock);
  const blob = vi.spyOn(URL, 'createObjectURL');
  await expect(loadCaptureTelop('A & B')).rejects.toThrow('Telop.tsx: unsupported frame API');
  expect(fetchMock).toHaveBeenCalledWith('/api/capture-component?id=A+%26+B&kind=telop');
  expect(blob).not.toHaveBeenCalled();
});

it('uses the image capture kind and a readable fallback for non-JSON failure', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(loadCaptureImage('A')).rejects.toThrow('撮影用の部品を読み込めませんでした');
  expect(fetchMock).toHaveBeenCalledWith('/api/capture-component?id=A&kind=image');
});
