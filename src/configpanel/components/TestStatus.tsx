import type { CSSProperties, ReactElement, ReactNode, Ref } from 'react';
import { S } from '../styles.js';

interface Props {
  // true → success color, false or undefined → error color.
  ok?: boolean;
  // Extra style merged after the ok/err color (e.g. the save-bar right spacer).
  style?: CSSProperties;
  // Makes the span a programmatic focus target (the save bar moves focus here
  // when the Save button self-disables).
  tabIndex?: number;
  spanRef?: Ref<HTMLSpanElement>;
  children: ReactNode;
}

// The shared polite live-region span for every inline test or save result, so
// the role, aria-live, and success/error color convention live in one place
// (StatusBlock, QuestDBSection, and the save bar all render through it).
export function TestStatus({ ok, style, tabIndex, spanRef, children }: Props): ReactElement {
  const base = { ...S.testStatus, ...(ok ? S.testOk : S.testErr) };
  return (
    <span
      ref={spanRef}
      tabIndex={tabIndex}
      role="status"
      aria-live="polite"
      style={style ? { ...base, ...style } : base}
    >
      {children}
    </span>
  );
}
