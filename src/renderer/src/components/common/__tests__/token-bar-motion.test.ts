import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const css = fs.readFileSync(path.resolve(process.cwd(), 'src/renderer/src/main.css'), 'utf8');

describe('token bar motion CSS', () => {
  it('keeps the global motion kill switch scoped around token bars and Toastify', () => {
    expect(css).toMatch(/body\.disable-css-streaming-animations\s+\*:not\(\.Toastify\):not\(\.Toastify \*\):not\(\.token-footprint-motion\)/);
    expect(css).toMatch(/\.token-footprint-motion \{[\s\S]*?transition:\s*width 320ms ease-out;/);
    expect(css).not.toMatch(/body\.disable-css-streaming-animations[\s\S]*?\.token-footprint-motion \* /);
  });

  it('defines finite width motion and initial states for both layouts', () => {
    const motionBlock = css.match(/\.token-footprint-motion \{([\s\S]*?)\}/)?.[1] ?? '';
    expect(motionBlock).toMatch(/transition:\s*width 320ms ease-out;/);
    expect(motionBlock).not.toMatch(/infinite|iteration-count/);

    const startingStyle = css.match(/@starting-style\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(startingStyle).toMatch(/data-token-layout=["']column["']\]\s*>\s*\.token-footprint-fill/);
    expect(startingStyle).toMatch(/data-token-layout=["']intrinsic["']\]/);
    expect(startingStyle).toMatch(/width:\s*0\s*!important/);
  });

  it('disables token width transitions for reduced motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.token-footprint-motion[\s\S]*?transition:\s*none\s*!important/);
  });
});
