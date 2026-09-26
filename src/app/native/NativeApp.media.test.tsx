/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_TUTORIAL_RESUME_KEY } from '../tutorial/nativeTutorialStorage';
import { NativeHome } from './NativeApp';

const api = vi.hoisted(() => ({ create: undefined as unknown as ReturnType<typeof vi.fn>, createImages: undefined as unknown as ReturnType<typeof vi.fn> }));
vi.mock('../panels/HomeDashboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../panels/HomeDashboard')>();
  return { ...actual, HomeDashboardWithAgentBoard: actual.HomeDashboard };
});
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  createNativeProject: (...args: unknown[]) => api.create(...args),
  createNativeImageProject: (...args: unknown[]) => api.createImages(...args),
}));
vi.mock('./useNativeFileReference', () => ({ useNativeFileReference: () => ({
  resolve: async (file: File) => ({ path: `/ssd/${file.name}`, expectedFingerprint: 'fp' }), picker: null, cancel: () => {},
}) }));
vi.mock('./NativeWorkspace', () => ({ NativeWorkspace: () => null }));
vi.mock('../useProjectsWatch', () => ({ useProjectsWatch: () => {} }));
vi.mock('../layout/useTheme', () => ({ useTheme: () => ({ theme: 'dark', toggle: () => {} }) }));

const stepId = (): string | null => document.querySelector('.tut')?.getAttribute('data-step') ?? null;
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => (String(url).startsWith('/api/config') ? { tutorialEnabled: false } : { projects: [] }) })));
  api.create = vi.fn(async () => ({ id: 'new-audio' }));
  api.createImages = vi.fn(async () => ({ id: 'new-images' }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function toCreateStep() {
  const navigate = vi.fn();
  let saved: string | null = null;
  navigate.mockImplementation(() => { saved = sessionStorage.getItem(NATIVE_TUTORIAL_RESUME_KEY); });
  render(<NativeHome navigate={navigate} />);
  await screen.findByText('まだプロジェクトがありません');
  fireEvent.click(screen.getByRole('button', { name: '使い方（ヘルプ）' }));
  fireEvent.click(await screen.findByRole('button', { name: /もう一度最初から見る/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'はじめる' }));
  fireEvent.click(await screen.findByRole('button', { name: '次へ' }));
  await waitFor(() => expect(stepId()).toBe('create'));
  return { navigate, saved: () => saved };
}
function select(files: File[]): void {
  const input = screen.getByTestId('home-create-file') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

describe('音声・複数画像でも、作成に成功したら案内の続きを残して編集画面へ移る（設計 M6b）', () => {
  it('音声1件（参照を優先）', async () => {
    const { navigate, saved } = await toCreateStep();
    select([new File(['x'], 'talk.mp3')]);
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('new-audio'));
    expect(api.create).toHaveBeenCalledWith(expect.any(String), '/ssd/talk.mp3', expect.any(Function), 'fp');
    expect(JSON.parse(saved() ?? 'null')).toEqual({ projectId: 'new-audio', stepId: 'modes' });
  });
  it('画像3枚（コピー）', async () => {
    const { navigate, saved } = await toCreateStep();
    const files = [new File(['1'], '1.png'), new File(['2'], '2.png'), new File(['3'], '3.png')];
    select(files);
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('new-images'));
    expect(api.createImages).toHaveBeenCalledWith(expect.any(String), files, expect.any(Function));
    expect(api.create).not.toHaveBeenCalled();
    expect(JSON.parse(saved() ?? 'null')).toEqual({ projectId: 'new-images', stepId: 'modes' });
  });
});
