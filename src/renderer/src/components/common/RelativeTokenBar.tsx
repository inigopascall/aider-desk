import { clsx } from 'clsx';

type Props = {
  tokens: number | null | undefined;
  maxTokens: number;
  color: string;
  className?: string;
  /** Column reserves the aligned maximum; intrinsic occupies its calculated width. */
  layout?: 'column' | 'intrinsic';
  'data-testid'?: string;
};

export const getRelativeTokenWidth = (tokens: number | null | undefined, maxTokens: number): number => {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (tokens / maxTokens) * 100));
};

export const RelativeTokenBar = ({ tokens, maxTokens, color, className, layout = 'column', 'data-testid': testId }: Props) => {
  const percent = getRelativeTokenWidth(tokens, maxTokens);
  const knownTokens = typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : undefined;
  const isIntrinsic = layout === 'intrinsic';
  return (
    <span
      className={clsx(
        'token-footprint-bar token-footprint-motion inline-flex items-center justify-end shrink-0 h-4',
        !isIntrinsic && 'w-[2.2rem] min-w-[2em]',
        className,
      )}
      style={isIntrinsic ? { width: `calc(max(2.2rem, 2em) * ${percent / 100})` } : undefined}
      aria-hidden="true"
      data-testid={testId}
      data-token-layout={layout}
      data-token-bar-fill={percent}
      data-token-count={knownTokens}
      data-max-tokens={maxTokens}
    >
      <span
        className="token-footprint-fill token-footprint-motion block h-[0.4em] rounded-sm shrink-0"
        style={{ width: isIntrinsic ? '100%' : `${percent}%`, backgroundColor: color, opacity: 0.85 }}
      />
    </span>
  );
};
