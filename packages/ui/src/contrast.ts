/**
 * WCAG relative luminance and contrast ratio.
 *
 * Here rather than in a test file because ADR-0010 §3 makes contrast a property of
 * the design system, and a rule that only exists in a test is a rule people
 * discover by breaking it. Exported so a future theme editor can check a colour
 * before it ships rather than after.
 *
 * Formula: WCAG 2.2, Understanding Success Criterion 1.4.3.
 */

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export function parseHex(hex: string): Rgb {
  const value = hex.trim().replace(/^#/, '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(colour: Rgb | string): number {
  const { r, g, b } = typeof colour === 'string' ? parseHex(colour) : colour;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG 2.2 AA thresholds. */
export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;
export const AA_NON_TEXT = 3; // UI component boundaries and focus indicators

export function meetsAA(
  foreground: string,
  background: string,
  kind: 'normal' | 'large' | 'non-text' = 'normal',
): boolean {
  const threshold =
    kind === 'normal' ? AA_NORMAL_TEXT : kind === 'large' ? AA_LARGE_TEXT : AA_NON_TEXT;
  return contrastRatio(foreground, background) >= threshold;
}
