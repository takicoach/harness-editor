// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scriptAdoptionFixture } from '../../core/__fixtures__/scriptAdoption';
import { ScriptModificationEditor } from './ScriptModificationEditor';

afterEach(cleanup);
describe('human script correction fields', () => {
  it('explains rejection when corrected captions would restore the original input', () => {
    const onChange = vi.fn();
    render(<ScriptModificationEditor artifact={scriptAdoptionFixture()} disabled={false} onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox', { name: '修正する字幕 1' }), { target: { value: 'ハイ' } });
    expect(screen.getByRole('status').textContent).toContain('却下');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
  it('roundtrips source frames and rejects negative, empty, reversed and removed ranges', () => {
    const onChange = vi.fn();
    render(<ScriptModificationEditor artifact={scriptAdoptionFixture('structure')} disabled={false} onChange={onChange} />);
    const start = screen.getByLabelText('区間 1 の開始（秒）');
    for (const value of ['-0.001', '', '1.6']) {
      fireEvent.change(start, { target: { value } });
      expect(onChange).toHaveBeenLastCalledWith(null);
    }
    fireEvent.change(start, { target: { value: String(16 / 30) } });
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'structure', cutOrder: [{ originalStart: 16, originalEnd: 45 }] });
    fireEvent.click(screen.getByRole('button', { name: '区間 1 を外す' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole('status').textContent).toContain('1件以上');
  });
});
