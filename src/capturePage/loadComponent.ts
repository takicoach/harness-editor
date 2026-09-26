import { pickTelopExport, type TelopComponent } from '../preview/loadTelopComponent';
import { pickInsertImageExport, type InsertImageComponent } from '../preview/loadInsertImageComponent';

/** Capture components share the page's frame context and per-project staticFile resolver. */
async function loadCaptureComponent(projectId: string, kind: 'telop' | 'image'): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/capture-component?${new URLSearchParams({ id: projectId, kind })}`);
  const source = await response.text();
  if (!response.ok) {
    let message = '撮影用の部品を読み込めませんでした';
    try {
      const body: unknown = JSON.parse(source);
      if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' && body.error) message = body.error;
    } catch { /* Keep the readable fallback for non-JSON server responses. */ }
    throw new Error(message);
  }
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try { return await import(/* @vite-ignore */ url) as Record<string, unknown>; }
  finally { URL.revokeObjectURL(url); }
}

export async function loadCaptureTelop(projectId: string): Promise<TelopComponent> {
  return pickTelopExport(await loadCaptureComponent(projectId, 'telop'));
}

export async function loadCaptureImage(projectId: string): Promise<InsertImageComponent> {
  return pickInsertImageExport(await loadCaptureComponent(projectId, 'image'));
}
