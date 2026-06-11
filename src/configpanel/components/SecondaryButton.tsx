import type { ButtonHTMLAttributes, CSSProperties, ReactElement, Ref } from 'react';
import { btn, btnClass, S } from '../styles.js';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  // Merged after S.btnSecondary, e.g. the disabled treatment on a reset button.
  extraStyle?: CSSProperties;
  // Explicit ref to the button, for callers that restore focus to it (the
  // reports and prompt toggles do, when their drawer closes).
  btnRef?: Ref<HTMLButtonElement>;
}

// The slate secondary button, deduping the repeated
// `className={btnClass(true)} style={btn(S.btnSecondary, ...)}` incantation.
// Every other button attribute (disabled, title, onClick, aria-*) passes
// through.
export function SecondaryButton({ extraStyle, btnRef, children, ...rest }: Props): ReactElement {
  return (
    <button
      type="button"
      ref={btnRef}
      className={btnClass(true)}
      style={btn(S.btnSecondary, extraStyle)}
      {...rest}
    >
      {children}
    </button>
  );
}
