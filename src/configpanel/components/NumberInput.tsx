import type { CSSProperties, KeyboardEvent, ReactElement, WheelEvent } from 'react';
import { useState } from 'react';
import { S } from '../styles.js';
import { clamp } from '../utils.js';

interface BaseProps {
  value: number | undefined;
  min?: number;
  max?: number;
  placeholder?: string;
  ariaLabel: string;
  // Associates a sibling <label htmlFor> with the field.
  id?: string;
  // Merged over S.input so callers can size the field (e.g. the small variant).
  style?: CSSProperties;
}

// `allowEmpty` widens `onChange` to emit `undefined` for a cleared field.
// Without it a cleared field commits `min`, so `onChange` only ever sees a
// number.
type Props = BaseProps &
  (
    | { allowEmpty?: false; onChange: (next: number) => void }
    | { allowEmpty: true; onChange: (next: number | undefined) => void }
  );

// Integer input that holds a raw-text draft while the user edits, so the field
// can be cleared mid-edit instead of snapping back to a number on every
// keystroke. Commits a clamped, truncated integer (or `undefined`). Blurs on
// wheel so a scroll gesture cannot silently spin the value.
export function NumberInput(props: Props): ReactElement {
  const { value, min = 0, max, placeholder, ariaLabel, id, style } = props;
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (raw: string): void => {
    if (raw.trim() === '') {
      if (props.allowEmpty) props.onChange(undefined);
      else props.onChange(min);
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      props.onChange(min);
      return;
    }
    props.onChange(clamp(Math.trunc(n), min, max ?? Number.POSITIVE_INFINITY));
  };

  return (
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      style={style ? { ...S.input, ...style } : S.input}
      value={draft ?? (value === undefined ? '' : String(value))}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => {
        setDraft(e.target.value);
        commit(e.target.value);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        // Enter commits and normalizes the display by dropping focus, which
        // clears the draft so the field re-renders the clamped value.
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      onWheel={(e: WheelEvent<HTMLInputElement>) => {
        // A scroll gesture over a focused number field silently spins the
        // value. Dropping focus before the spin applies makes scrolling past
        // the field safe; an unfocused number input never spins.
        if (document.activeElement === e.currentTarget) e.currentTarget.blur();
      }}
    />
  );
}
