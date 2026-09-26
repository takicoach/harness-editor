/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_TUTORIAL_DONE_KEY, NATIVE_TUTORIAL_RESUME_KEY } from '../tutorial/nativeTutorialStorage';
import { NativeHome } from './NativeApp';

const api = vi.hoisted(() => ({ create: undefined as unknown as ReturnType<typeof vi.fn> }));
vi.mock('../panels/HomeDashboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../panels/HomeDashboard')>();
  return { ...actual, HomeDashboardWithAgentBoard: actual.HomeDashboard };
});
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  createNativeProject: (...args: unknown[]) => api.create(...args),
}));
vi.mock('./useNativeFileReference', () => ({ useNativeFileReference: () => ({
  resolve: async () => ({ path: '/videos/take1.mp4', expectedFingerprint: 'fp' }), picker: null, cancel: () => {},
}) }));
vi.mock('./NativeWorkspace', () => ({ NativeWorkspace: () => null }));
vi.mock('../useProjectsWatch', () => ({ useProjectsWatch: () => {} }));
vi.mock('../layout/useTheme', () => ({ useTheme: () => ({ theme: 'dark', toggle: () => {} }) }));

function stubFetch(tutorialEnabled: boolean, projects: unknown[] = []): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, json: async () => (String(url).startsWith('/api/config') ? { tutorialEnabled } : { projects }),
  })));
}
const CARD = { id: 'p-card', name: 'p-card', orientation: 'v', durationLabel: '1:00', sizeLabel: '1 MB', videoFile: null, status: 'telop',
  steps: { transcribe: true, cut: true, telop: 'empty', audio: false, rendered: false } };
function openCreateModal(): void {
  const input = screen.getByTestId('home-create-file') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new File(['x'], 'take1.mp4', { type: 'video/mp4' })], configurable: true });
  fireEvent.change(input);
}
const stepId = (): string | null => document.querySelector('.tut')?.getAttribute('data-step') ?? null;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  api.create = vi.fn(async () => ({ id: 'new-project' }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('ホームの「？」', () => {
  it('テーマ切替の隣にあり、押すとヘルプの「もう一度最初から見る」で welcome から始まる', async () => {
    stubFetch(false);
    render(<NativeHome navigate={vi.fn()} />);
    const help = screen.getByRole('button', { name: '使い方（ヘルプ）' });
    expect(help.getAttribute('data-tutorial')).toBe('help');
    expect(help.nextElementSibling).toBe(screen.getByRole('button', { name: 'テーマ切替' }));
    fireEvent.click(help);
    fireEvent.click(await screen.findByRole('button', { name: /もう一度最初から見る/ }));
    await waitFor(() => expect(stepId()).toBe('welcome'));
    expect(document.querySelector('[data-testid="help-dialog"]')).toBeNull();
  });
});

describe('ホームの初回自動', () => {
  it('設定が有効で空の記録なら welcome が出る', async () => {
    stubFetch(true);
    render(<NativeHome navigate={vi.fn()} />);
    await waitFor(() => expect(stepId()).toBe('welcome'));
  });
  it('完了済み（新キー）なら出ない', async () => {
    stubFetch(true);
    localStorage.setItem(NATIVE_TUTORIAL_DONE_KEY, 'x');
    render(<NativeHome navigate={vi.fn()} />);
    await screen.findByText('まだプロジェクトがありません');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(stepId()).toBeNull();
  });
});

describe('作成手順', () => {
  async function toCreate() {
    stubFetch(false);
    const navigate = vi.fn();
    render(<NativeHome navigate={navigate} />);
    await screen.findByText('まだプロジェクトがありません');
    fireEvent.click(screen.getByRole('button', { name: '使い方（ヘルプ）' }));
    fireEvent.click(await screen.findByRole('button', { name: /もう一度最初から見る/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'はじめる' })); // → home-intro
    fireEvent.click(await screen.findByRole('button', { name: '次へ' })); // → create（作品0件なので board は出ない）
    await waitFor(() => expect(stepId()).toBe('create'));
    return navigate;
  }
  it('作成に成功したら、遷移の直前に再開情報を保存してから編集画面へ移る', async () => {
    const navigate = await toCreate();
    let saved: string | null = null;
    navigate.mockImplementation(() => { saved = sessionStorage.getItem(NATIVE_TUTORIAL_RESUME_KEY); });
    openCreateModal();
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('new-project'));
    expect(api.create).toHaveBeenCalled();
    expect(JSON.parse(saved ?? 'null')).toEqual({ projectId: 'new-project', stepId: 'modes' });
  });
  it('作成に失敗したら遷移せず作成手順に留まる。ダイアログの表示中は案内帯だけを出す', async () => {
    const navigate = await toCreate();
    api.create = vi.fn(async () => { throw new Error('空き容量が足りません'); });
    openCreateModal();
    await waitFor(() => expect(document.querySelector('.tut-band[data-step="create"]')).not.toBeNull());
    expect(document.querySelector('.tut-bubble')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '作成' }));
    expect(await screen.findByText('空き容量が足りません')).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(NATIVE_TUTORIAL_RESUME_KEY)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    await waitFor(() => expect(stepId()).toBe('create'));
  });
});

describe('作品カードで編集画面へ移る', () => {
  async function renderWithCard() {
    stubFetch(false, [CARD]);
    let saved: string | null = null;
    const navigate = vi.fn(() => { saved = sessionStorage.getItem(NATIVE_TUTORIAL_RESUME_KEY); });
    render(<NativeHome navigate={navigate} />);
    const card = (await screen.findByText('p-card')).closest('.home-card') as HTMLElement;
    return { navigate, card, saved: () => saved };
  }
  it('案内の表示中なら、遷移の直前に最初の編集画面の手順を残す', async () => {
    const { navigate, card, saved } = await renderWithCard();
    fireEvent.click(screen.getByRole('button', { name: '使い方（ヘルプ）' }));
    fireEvent.click(await screen.findByRole('button', { name: /もう一度最初から見る/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'はじめる' }));
    await waitFor(() => expect(stepId()).toBe('home-intro'));
    fireEvent.click(card);
    expect(navigate).toHaveBeenCalledWith('p-card');
    expect(JSON.parse(saved() ?? 'null')).toEqual({ projectId: 'p-card', stepId: 'modes' });
  });
  it('案内を出していなければ何も残さない', async () => {
    const { navigate, card, saved } = await renderWithCard();
    fireEvent.click(card);
    expect(navigate).toHaveBeenCalledWith('p-card');
    expect(saved()).toBeNull();
  });
});
