import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { getRelativeTokenWidth, RelativeTokenBar } from '../RelativeTokenBar';

import { render } from '@/__tests__/render';

describe('getRelativeTokenWidth', () => {
  it('returns the token share as a percentage', () => {
    expect(getRelativeTokenWidth(100, 100)).toBe(100);
    expect(getRelativeTokenWidth(25, 100)).toBe(25);
  });

  it.each([
    [0, 100],
    [null, 100],
    [undefined, 100],
    [Number.NaN, 100],
    [Number.POSITIVE_INFINITY, 100],
    [-1, 100],
    [25, 0],
    [25, null],
    [25, Number.NaN],
    [25, Number.POSITIVE_INFINITY],
    [25, -1],
  ])('returns zero for invalid or non-positive tokens (%s, %s)', (tokens, maxTokens) => {
    expect(getRelativeTokenWidth(tokens as number | null | undefined, maxTokens as number)).toBe(0);
  });

  it('caps oversized values at 100 percent', () => {
    expect(getRelativeTokenWidth(150, 100)).toBe(100);
  });
});

describe('RelativeTokenBar', () => {
  afterEach(() => cleanup());

  it('renders coloured fills with percentage widths', () => {
    render(
      <>
        <RelativeTokenBar tokens={25} maxTokens={100} color="red" data-testid="red-bar" />
        <RelativeTokenBar tokens={75} maxTokens={100} color="blue" data-testid="blue-bar" />
      </>,
    );

    expect(screen.getByTestId('red-bar')).toHaveAttribute('data-token-bar-fill', '25');
    expect((screen.getByTestId('red-bar').firstElementChild as HTMLElement).style.width).toBe('25%');
    expect((screen.getByTestId('red-bar').firstElementChild as HTMLElement).style.backgroundColor).toBe('red');
    expect(screen.getByTestId('blue-bar')).toHaveAttribute('data-token-bar-fill', '75');
    expect((screen.getByTestId('blue-bar').firstElementChild as HTMLElement).style.width).toBe('75%');
    expect((screen.getByTestId('blue-bar').firstElementChild as HTMLElement).style.backgroundColor).toBe('blue');
  });

  it('renders an empty fill for unknown tokens while preserving the column', () => {
    render(<RelativeTokenBar tokens={undefined} maxTokens={100} color="green" data-testid="unknown-bar" />);

    const bar = screen.getByTestId('unknown-bar');
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(bar).toHaveAttribute('data-token-bar-fill', '0');
    expect(bar).toHaveClass('w-[2.2rem]');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('0%');
    expect((bar.firstElementChild as HTMLElement).style.backgroundColor).toBe('green');
  });

  it('renders the default column layout with finite-motion classes', () => {
    render(<RelativeTokenBar tokens={25} maxTokens={100} color="red" data-testid="column-bar" />);

    const bar = screen.getByTestId('column-bar');
    const fill = bar.firstElementChild as HTMLElement;
    expect(bar).toHaveAttribute('data-token-layout', 'column');
    expect(bar).toHaveClass('justify-end', 'w-[2.2rem]', 'min-w-[2em]', 'token-footprint-motion');
    expect(fill).toHaveClass('token-footprint-motion');
    expect(fill.style.width).toBe('25%');
    expect(fill.style.backgroundColor).toBe('red');
    expect(bar).not.toHaveClass('animate-pulse', 'animate-spin');
    expect(fill).not.toHaveClass('animate-pulse', 'animate-spin');
  });

  it('retargets a column fill without changing its reserved footprint', () => {
    const view = render(<RelativeTokenBar tokens={undefined} maxTokens={100} color="red" data-testid="retarget-bar" />);
    const bar = screen.getByTestId('retarget-bar');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('0%');
    view.rerender(<RelativeTokenBar tokens={25} maxTokens={100} color="red" data-testid="retarget-bar" />);
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('25%');
    view.rerender(<RelativeTokenBar tokens={75} maxTokens={100} color="red" data-testid="retarget-bar" />);
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('75%');
    expect(bar).toHaveClass('w-[2.2rem]', 'min-w-[2em]');
    expect(bar).toHaveAttribute('data-token-bar-fill', '75');
  });

  it('sizes intrinsic bars to their token ratio without reserving a column', () => {
    const view = render(<RelativeTokenBar tokens={25} maxTokens={100} color="purple" layout="intrinsic" data-testid="intrinsic-bar" />);
    const bar = screen.getByTestId('intrinsic-bar');
    const fill = bar.firstElementChild as HTMLElement;
    expect(bar).toHaveAttribute('data-token-layout', 'intrinsic');
    expect(bar.style.getPropertyValue('width').replace(/\s/g, '')).toBe('calc(max(2.2rem,2em)*0.25)');
    expect(bar).not.toHaveClass('w-[2.2rem]', 'min-w-[2em]');
    expect(bar).toHaveClass('justify-end', 'token-footprint-motion');
    expect(fill.style.width).toBe('100%');
    expect(fill.style.backgroundColor).toBe('purple');
    view.rerender(<RelativeTokenBar tokens={50} maxTokens={100} color="purple" layout="intrinsic" data-testid="intrinsic-bar" />);
    expect(bar.style.getPropertyValue('width').replace(/\s/g, '')).toBe('calc(max(2.2rem,2em)*0.5)');
    view.rerender(<RelativeTokenBar tokens={undefined} maxTokens={100} color="purple" layout="intrinsic" data-testid="intrinsic-bar" />);
    expect(bar.style.getPropertyValue('width').replace(/\s/g, '')).toBe('calc(max(2.2rem,2em)*0)');
    expect(bar).not.toHaveClass('w-[2.2rem]', 'min-w-[2em]');
    view.rerender(<RelativeTokenBar tokens={0} maxTokens={100} color="purple" layout="intrinsic" data-testid="intrinsic-bar" />);
    expect(bar.style.getPropertyValue('width').replace(/\s/g, '')).toBe('calc(max(2.2rem,2em)*0)');
  });
});
