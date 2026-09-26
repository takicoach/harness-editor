import { expect, it } from 'vitest';
import { DEFAULT_COLOR_GRADE, applyColorGrade8, normalizeColorWheels, normalizeColorWheel, isIdentityColorGrade, colorWheelTransfers } from './colorGrade';
import * as payload from '../server/mainLayoutPayload/colorGrade';
import { formatColorGradeExport, parseMainLayoutFile } from './mainLayoutData';
import { nativeUnsupportedReasons, type CutsOnlyInput } from '../shared/cutsOnly';

it('legacy grades keep identical serialized bytes and no extra filter', () => {
  expect(formatColorGradeExport(DEFAULT_COLOR_GRADE)).toBe('export const COLOR_GRADE = { brightness: 0, contrast: 0, saturation: 0, temperature: 0 };\n');
  expect(formatColorGradeExport({ ...DEFAULT_COLOR_GRADE, wheels: normalizeColorWheels({}) })).toBe(formatColorGradeExport(DEFAULT_COLOR_GRADE));
  expect(isIdentityColorGrade(DEFAULT_COLOR_GRADE)).toBe(true);
});
it('normalizes malformed and out-of-disc wheel data without NaN', () => {
  expect(normalizeColorWheel({ x: NaN, y: Infinity, level: '20' })).toEqual({ x: 0, y: 0, level: 0 });
  const w = normalizeColorWheel({ x: 100, y: 100, level: 200 });
  expect(Math.hypot(w.x, w.y)).toBeCloseTo(100); expect(w.level).toBe(100);
});
it('round trips wheel-only grades, retains basics and resets to legacy identity', () => {
  const grade = { ...DEFAULT_COLOR_GRADE, wheels: normalizeColorWheels({ gamma: { x: 24, y: -12, level: 30 } }) };
  expect(parseMainLayoutFile(formatColorGradeExport(grade)).colorGrade).toEqual(grade);
  expect(isIdentityColorGrade(grade)).toBe(false);
  const input: CutsOnlyInput = { telops: [], se: [], images: [], titles: [], mainSpeed: 1, segmentSpeeds: {}, bgmDucking: false, colorGrade: grade };
  expect(nativeUnsupportedReasons(input)).toEqual(['color']);
  expect(nativeUnsupportedReasons({ ...input, colorGrade: DEFAULT_COLOR_GRADE })).toEqual([]);
});
it('lift affects black, gamma preserves endpoints, gain affects white', () => {
  const g = (name: string) => ({ ...DEFAULT_COLOR_GRADE, wheels: normalizeColorWheels({ [name]: { x: 0, y: 0, level: 100 } }) });
  expect(applyColorGrade8(g('lift'), [0, 0, 0])).toEqual([64, 64, 64]);
  expect(applyColorGrade8(g('lift'), [255, 255, 255])).toEqual([255, 255, 255]);
  expect(applyColorGrade8(g('gamma'), [0, 128, 255])).toEqual([0, 181, 255]);
  expect(applyColorGrade8(g('gain'), [0, 64, 128])).toEqual([0, 128, 255]);
});
it('all three channels and bounded extreme values agree with the standalone payload', () => {
  for (const name of ['lift', 'gamma', 'gain']) for (const x of [-100, -20, 0, 45, 100]) for (const y of [-100, 0, 100]) for (const level of [-100, 0, 100]) {
    const grade = { ...DEFAULT_COLOR_GRADE, temperature: 12, wheels: normalizeColorWheels({ [name]: { x, y, level } }) };
    expect(payload.colorWheelTransfers(grade)).toEqual(colorWheelTransfers(grade));
    expect(payload.applyColorGrade8(grade, [12, 125, 243])).toEqual(applyColorGrade8(grade, [12, 125, 243]));
  }
});
