/** template 番号を 1..count の整数へ正規化する（範囲外/未定義/非整数は 1）。 */
export function resolveTemplate(template: number | undefined, count: number): number {
  if (typeof template !== 'number' || !Number.isInteger(template) || template < 1 || template > count) {
    return 1;
  }
  return template;
}
