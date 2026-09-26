// src/app/captureEngineStatus.test.ts
/**
 * /api/capture-engine/status の応答パース（M2d T2 修正 M-1）。
 * 形が違う応答（HTML エラーページ・型崩れ）を「ok:false＝未導入」と誤読しないことを固定する。
 */
import { describe, it, expect } from 'vitest';
import { parseCaptureEngineStatus } from './captureEngineStatus';

describe('parseCaptureEngineStatus', () => {
  it('ok:true / source を受け取る', () => {
    expect(parseCaptureEngineStatus({ ok: true, source: 'tools' })).toEqual({ ok: true, source: 'tools' });
  });

  it('ok:false / kind / message を受け取る', () => {
    expect(parseCaptureEngineStatus({ ok: false, kind: 'env-path-missing', message: 'x' })).toEqual({
      ok: false,
      kind: 'env-path-missing',
      message: 'x',
    });
  });

  it('ok が boolean でなければ null（未取得扱い＝従来表示のまま）', () => {
    expect(parseCaptureEngineStatus({ ok: 'false' })).toBeNull();
    expect(parseCaptureEngineStatus({})).toBeNull();
    expect(parseCaptureEngineStatus(null)).toBeNull();
    expect(parseCaptureEngineStatus('<!doctype html>')).toBeNull();
  });

  it('未知の kind は落とす（型崩れを UI へ持ち込まない）', () => {
    expect(parseCaptureEngineStatus({ ok: false, kind: 'とつぜんの値' })).toEqual({ ok: false });
  });
});
