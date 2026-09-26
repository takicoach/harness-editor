/** Serializable across the preview iframe. Do not depend on cross-realm instanceof. */
export interface NativePreviewFailure {
  kind: 'context-unavailable' | 'resource' | 'render';
  message: string;
  status?: number;
  resource?: 'asset' | 'component' | 'pcm';
}

export class PreviewResourceError extends Error {
  readonly kind: NativePreviewFailure['kind'];
  constructor(message: string, readonly status: number, readonly resource: NonNullable<NativePreviewFailure['resource']>, legacy: boolean) {
    super(message);
    this.kind = legacy && status === 404 ? 'context-unavailable' : 'resource';
  }
}

export function previewResourceError(message: string, status: number, resource: NonNullable<NativePreviewFailure['resource']>, url: string): PreviewResourceError {
  return new PreviewResourceError(message, status, resource, new URL(url, 'http://preview.local').pathname.startsWith('/api/legacy-preview/'));
}

export function previewFailure(error: unknown): NativePreviewFailure {
  if (error && typeof error === 'object') {
    const value = error as Partial<NativePreviewFailure>;
    if (typeof value.message === 'string') {
      const resource = value.resource === 'asset' || value.resource === 'component' || value.resource === 'pcm' ? value.resource : undefined;
      const status = typeof value.status === 'number' ? value.status : undefined;
      const kind = value.kind === 'context-unavailable' && status === 404 && resource ? value.kind : value.kind === 'resource' && resource ? value.kind : 'render';
      return { kind, message: value.message, ...(status !== undefined ? { status } : {}), ...(resource ? { resource } : {}) };
    }
  }
  return { kind: 'render', message: String(error) };
}
