import type { ReactElement } from 'react';
import { btn, btnClass, S } from '../styles.js';

interface Props {
  label: string;
  busyLabel: string;
  // True while a probe is in flight: shows busyLabel.
  busy: boolean;
  // True when the action cannot run (in flight, or a precondition unmet); also
  // applies the disabled styling.
  disabled: boolean;
  title?: string;
  onClick: () => void;
}

// The primary "Test ..." button shared by the OpenRouter and QuestDB sections:
// a busy label while a probe is in flight plus the standard disabled treatment.
export function TestButton({
  label,
  busyLabel,
  busy,
  disabled,
  title,
  onClick,
}: Props): ReactElement {
  return (
    <button
      type="button"
      className={btnClass(false)}
      style={btn(disabled && S.btnDisabled)}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {busy ? busyLabel : label}
    </button>
  );
}
