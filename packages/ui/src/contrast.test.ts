import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio, meetsAA, AA_NORMAL_TEXT } from './contrast';

/**
 * ADR-0010 §2: "Enforced in CI, not asserted in a document."
 *
 * These read the real token values out of tokens.css, so a designer editing the
 * stylesheet cannot take the palette out of WCAG 2.2 AA conformance without the
 * build saying so.
 */

const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8');

function token(name: string): string {
  const direct = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(css);
  if (direct?.[1]) return direct[1];
  const alias = new RegExp(`--${name}:\\s*var\\(--([a-z0-9-]+)\\)`).exec(css);
  if (alias?.[1]) return token(alias[1]);
  throw new Error(`token --${name} not found in tokens.css`);
}

describe('the formula itself', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // The canonical AA boundary example: #767676 on white is exactly 4.54:1.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.55);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#2563eb', '#ffffff')).toBeCloseTo(
      contrastRatio('#ffffff', '#2563eb'),
      10,
    );
  });
});

describe('token palette conforms to WCAG 2.2 AA', () => {
  const pairs: ReadonlyArray<readonly [string, string, string, 'normal' | 'large' | 'non-text']> = [
    ['body text on the page', 'text-primary', 'surface-page', 'normal'],
    ['body text on a raised surface', 'text-primary', 'surface-raised', 'normal'],
    ['secondary text on the page', 'text-secondary', 'surface-page', 'normal'],
    ['secondary text on a raised surface', 'text-secondary', 'surface-raised', 'normal'],
    ['danger text on a raised surface', 'text-danger', 'surface-raised', 'normal'],
    ['success text on a raised surface', 'text-success', 'surface-raised', 'normal'],
    ['primary button label', 'action-primary-text', 'action-primary-bg', 'normal'],
    ['danger surface text', 'text-inverse', 'action-danger-bg', 'normal'],
    // ADR-0010 §3: the focus ring must reach 3:1 against its adjacent colour.
    ['focus ring against the page', 'focus-ring-color', 'surface-page', 'non-text'],
    ['focus ring against a raised surface', 'focus-ring-color', 'surface-raised', 'non-text'],
    ['strong border against the page', 'border-strong', 'surface-page', 'non-text'],
  ];

  for (const [label, fg, bg, kind] of pairs) {
    it(`${label} (${kind})`, () => {
      const ratio = contrastRatio(token(fg), token(bg));
      expect(
        meetsAA(token(fg), token(bg), kind),
        `--${fg} on --${bg} is ${ratio.toFixed(2)}:1`,
      ).toBe(true);
    });
  }
});

describe('tokens.css carries the WCAG 2.2 mechanics', () => {
  it('states a minimum target size (criterion 2.5.8)', () => {
    expect(css).toMatch(/--target-size-min:\s*24px/);
  });

  it('respects prefers-reduced-motion', () => {
    expect(css).toContain('prefers-reduced-motion');
  });

  it('lifts focused elements above sticky chrome (criterion 2.4.11)', () => {
    const focusRule = /:focus-visible\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(focusRule).toContain('outline');
    expect(focusRule).toContain('z-index');
  });

  it('never removes an outline without replacing it', () => {
    expect(css).not.toMatch(/outline:\s*(none|0)\s*;/);
  });
});
