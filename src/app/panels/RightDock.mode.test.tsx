// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RightDock } from './RightDock';

vi.mock('../layout/RightDockResizer', () => ({ RightDockResizer: () => <div data-testid="resizer" /> }));

function view(mode: 'review' | 'edit' | 'finish', activeTab: 'transcript' | 'settings' | 'ai' = 'settings') {
  return render(<RightDock
    workspaceMode={mode}
    activeTab={activeTab}
    onPickTab={() => {}}
    open
    onToggleOpen={() => {}}
    transcript={<p>本文編集</p>}
    settings={<p>映像と音声の調整</p>}
    ai={<p>AI</p>}
  />);
}

describe('RightDock workspace roles', () => {
  afterEach(cleanup);
  it.each(['review'] as const)('%sでは仕上げ調整を出さない', (mode) => {
    view(mode);
    expect(screen.queryByRole('button', { name: '調整' })).toBeNull();
    expect(screen.getByText('本文編集')).toBeTruthy();
  });

  it('編集では専用クリップ設定へのタブを出す', () => {
    view('edit');
    expect(screen.getByRole('button', { name: 'クリップ' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '調整' })).toBeNull();
    expect(screen.getByText('映像と音声の調整')).toBeTruthy();
  });

  it('仕上げでは調整タブと設定本文を出す', () => {
    view('finish');
    expect(screen.getByRole('button', { name: '調整' })).toBeTruthy();
    expect(screen.getByText('映像と音声の調整')).toBeTruthy();
  });
});
