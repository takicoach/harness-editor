export type RGB = readonly [number, number, number];
export interface CubeLut {
  title: string;
  size: number;
  domainMin: RGB;
  domainMax: RGB;
  /** Red changes fastest, then green, then blue. Unclamped float RGB. */
  values: Float32Array<ArrayBuffer>;
}
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Strict IRIDAS/Adobe 3D .cube subset. Unsupported shapers are rejected explicitly. */
export function parseCube(text: string): CubeLut {
  if (text.length > 32 * 1024 * 1024) throw new Error('LUTファイルが大きすぎます（上限32MB）');
  const seen = new Set<string>();
  let title = '', size = 0, domainMin: RGB = [0, 0, 0], domainMax: RGB = [1, 1, 1];
  const values: number[] = [];
  let dataStarted = false;
  const triple = (tokens: string[], line: number): [number, number, number] => {
    if (tokens.length !== 3 || tokens.some(t => !NUMBER.test(t) || !Number.isFinite(Number(t)) || !Number.isFinite(Math.fround(Number(t))))) {
      throw new Error(`LUTの${line}行目に不正なRGB値があります`);
    }
    return tokens.map(Number) as [number, number, number];
  };
  for (const [index, raw] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    // A # inside a quoted title is part of the title.
    const line = raw.replace(/#(?=(?:[^"]*"[^"]*")*[^"]*$).*$/, '').trim();
    if (!line) continue;
    const tokens = line.split(/\s+/), keyword = tokens[0]!;
    if (NUMBER.test(keyword)) {
      if (!size) throw new Error('LUT_3D_SIZEをデータの前に指定してください');
      dataStarted = true;
      values.push(...triple(tokens, index + 1));
      if (values.length > size ** 3 * 3) throw new Error('LUTの格子数より多いRGBデータがあります');
      continue;
    }
    if (dataStarted) throw new Error(`LUTの${index + 1}行目にデータ後のヘッダーがあります`);
    if (seen.has(keyword)) throw new Error(`LUTの${keyword}が重複しています`);
    seen.add(keyword);
    switch (keyword) {
      case 'TITLE': {
        const match = /^TITLE\s+"([^"\r\n]*)"$/.exec(line);
        if (!match) throw new Error('LUTのタイトル形式が不正です');
        title = match[1]!; break;
      }
      case 'LUT_3D_SIZE':
        size = Number(tokens[1]);
        if (tokens.length !== 2 || !Number.isSafeInteger(size) || size < 2 || size > 65) throw new Error('LUTの格子サイズは2〜65に対応しています');
        break;
      case 'DOMAIN_MIN': domainMin = triple(tokens.slice(1), index + 1); break;
      case 'DOMAIN_MAX': domainMax = triple(tokens.slice(1), index + 1); break;
      default: throw new Error(`未対応のLUT形式です: ${keyword}（3D .cube形式を使用してください）`);
    }
  }
  if (!size || values.length !== size ** 3 * 3) throw new Error('LUTのRGBデータ数と格子サイズが一致しません');
  for (let i = 0; i < 3; i++) {
    if (Math.fround(domainMin[i]!) >= Math.fround(domainMax[i]!)
      || !Number.isFinite(Math.fround(Math.fround(domainMax[i]!) - Math.fround(domainMin[i]!)))) {
      throw new Error('LUTのDOMAIN範囲を32bit精度で表現できません。MAXはMINより大きい値が必要です');
    }
  }
  return { title, size, domainMin, domainMax, values: new Float32Array(values) };
}

/** CPU oracle for the identical trilinear GPU sampler. Input is straight sRGB, not premultiplied. */
export function sampleCube(lut: CubeLut, input: RGB): [number, number, number] {
  const coordinates = input.map((v, i) => clamp01((v - lut.domainMin[i]!) / (lut.domainMax[i]! - lut.domainMin[i]!)) * (lut.size - 1));
  const lower = coordinates.map(Math.floor), fractions = coordinates.map((v, i) => v - lower[i]!);
  const result: [number, number, number] = [0, 0, 0];
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) {
    const offset = (Math.min(lower[2]! + b, lut.size - 1) * lut.size ** 2
      + Math.min(lower[1]! + g, lut.size - 1) * lut.size + Math.min(lower[0]! + r, lut.size - 1)) * 3;
    const weight = (r ? fractions[0]! : 1 - fractions[0]!) * (g ? fractions[1]! : 1 - fractions[1]!) * (b ? fractions[2]! : 1 - fractions[2]!);
    for (let channel = 0; channel < 3; channel++) result[channel]! += lut.values[offset + channel]! * weight;
  }
  return result;
}
export function applyCube(lut: CubeLut, input: RGB, intensity: number): [number, number, number] {
  if (!Number.isFinite(intensity) || intensity < 0 || intensity > 1) throw new Error('LUTの強度は0〜1で指定してください');
  if (intensity === 0) return input.map(clamp01) as [number, number, number];
  const output = sampleCube(lut, input);
  return input.map((v, i) => clamp01(v * (1 - intensity) + output[i]! * intensity)) as [number, number, number];
}
