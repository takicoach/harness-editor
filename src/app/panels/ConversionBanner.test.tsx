/**
 * @vitest-environment jsdom
 *
 * 監査 data-safety-8 の回帰テスト。
 * 変換は成功後にプロジェクトを開き直すため、未保存のまま押せると編集が消える。
 * install 系（BgmInstallBanner）と同じく、未保存の間はボタンを押せなくする。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import { ConversionBanner } from './ConversionBanner';

afterEach(() => cleanup());

describe('ConversionBanner', () => {
  it('未保存の編集があるあいだは変換ボタンを押せない', () => {
    const onConvert = vi.fn();
    render(<ConversionBanner converting={false} error={null} dirty onConvert={onConvert} />);
    const btn = screen.getByRole('button', { name: '非破壊モデルへ変換' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(btn);
    expect(onConvert).not.toHaveBeenCalled();
    expect(screen.getByText('変換前に編集を保存してください。')).toBeTruthy();
  });

  it('保存済みなら従来どおり変換できる', () => {
    const onConvert = vi.fn();
    render(
      <ConversionBanner converting={false} error={null} dirty={false} onConvert={onConvert} />,
    );
    const btn = screen.getByRole('button', { name: '非破壊モデルへ変換' });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(onConvert).toHaveBeenCalledTimes(1);
  });

  it('変換中もボタンは押せない（既存の挙動）', () => {
    render(<ConversionBanner converting error={null} dirty={false} onConvert={vi.fn()} />);
    expect((screen.getByRole("button", { name: "変換中…" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
