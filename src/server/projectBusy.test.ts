// src/server/projectBusy.test.ts
import { describe, it, expect } from 'vitest';
import { findBusyJobs, type BusyRegistries } from './projectBusy';

function registries(phases: Partial<Record<keyof BusyRegistries, string>>): BusyRegistries {
  const make = (phase: string | undefined) => ({
    get: (projectId: string) =>
      phase === undefined || projectId !== 'proj' ? undefined : { phase },
  });
  return {
    render: make(phases.render),
    transcribe: make(phases.transcribe),
    denoise: make(phases.denoise),
    normalize: make(phases.normalize),
    previewProxy: make(phases.previewProxy),
  };
}

describe('findBusyJobs', () => {
  it('ジョブが1つも無ければ空配列', () => {
    expect(findBusyJobs('proj', registries({}))).toEqual([]);
  });

  it('実行中のジョブ種別を返す（レンダー中）', () => {
    expect(findBusyJobs('proj', registries({ render: 'rendering' }))).toEqual(['render']);
  });

  it('終了済み（done / failed / cancelled / completed）は busy に数えない', () => {
    expect(findBusyJobs('proj', registries({ render: 'done' }))).toEqual([]);
    expect(findBusyJobs('proj', registries({ render: 'failed' }))).toEqual([]);
    expect(findBusyJobs('proj', registries({ render: 'cancelled' }))).toEqual([]);
    expect(findBusyJobs('proj', registries({ transcribe: 'completed' }))).toEqual([]);
  });

  it('複数種別が動いていれば全部返す', () => {
    const r = registries({ transcribe: 'analyzing', denoise: 'denoising', normalize: 'done' });
    expect(findBusyJobs('proj', r)).toEqual(['transcribe', 'denoise']);
  });

  it('別プロジェクトのジョブは対象外', () => {
    expect(findBusyJobs('other', registries({ render: 'rendering' }))).toEqual([]);
  });

  it('プレビュープロキシ生成中も busy', () => {
    expect(findBusyJobs('proj', registries({ previewProxy: 'converting' }))).toEqual([
      'previewProxy',
    ]);
  });
});
