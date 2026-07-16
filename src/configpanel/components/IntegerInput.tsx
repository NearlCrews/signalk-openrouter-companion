import type { ChangeEvent, KeyboardEvent, ReactElement, WheelEvent } from 'react';
import { useState } from 'react';
import { type FieldControlProps, NumberInput as UiNumberInput } from 'signalk-nearlcrews-ui';
import { clamp } from '../utils.js';

interface BaseProps extends FieldControlProps {
  value: number | undefined;
  min?: number;
  max?: number;
  placeholder?: string;
  'aria-label'?: string;
}

type Props = BaseProps &
  (
    | { allowEmpty?: false; onValueChange: (next: number) => void }
    | { allowEmpty: true; onValueChange: (next: number | undefined) => void }
  );

// Integer input that holds a raw-text draft while the user edits, so the field
// can be cleared without snapping back on every keystroke. It keeps the shared
// UI input presentation while retaining this plugin's clamping behavior.
export function IntegerInput(props: Props): ReactElement {
  const {
    value,
    min = 0,
    max,
    placeholder,
    id,
    required,
    'aria-label': ariaLabel,
    'aria-describedby': ariaDescribedBy,
    'aria-errormessage': ariaErrorMessage,
    'aria-invalid': ariaInvalid,
  } = props;
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (raw: string): void => {
    if (raw.trim() === '') {
      if (props.allowEmpty) props.onValueChange(undefined);
      else props.onValueChange(min);
      return;
    }
    const number = Number(raw);
    if (!Number.isFinite(number)) {
      props.onValueChange(min);
      return;
    }
    props.onValueChange(clamp(Math.trunc(number), min, max ?? Number.POSITIVE_INFINITY));
  };

  return (
    <UiNumberInput
      id={id}
      min={min}
      max={max}
      required={required}
      value={draft ?? (value === undefined ? '' : String(value))}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-errormessage={ariaErrorMessage}
      aria-invalid={ariaInvalid}
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        setDraft(event.target.value);
        commit(event.target.value);
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
      onWheel={(event: WheelEvent<HTMLInputElement>) => {
        if (document.activeElement === event.currentTarget) event.currentTarget.blur();
      }}
    />
  );
}
