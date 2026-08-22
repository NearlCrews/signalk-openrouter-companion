import type { ChangeEvent, KeyboardEvent, ReactElement, WheelEvent } from 'react';
import { useState } from 'react';
import { type FieldControlProps, NumberInput as UiNumberInput } from 'signalk-nearlcrews-ui';

interface Props extends FieldControlProps {
  value: number | undefined;
  min?: number;
  placeholder?: string;
  onValueChange: (next: number | undefined) => void;
}

// Integer input that holds a raw-text draft while the user edits, so the field
// can be cleared without snapping back on every keystroke. It keeps the shared
// UI input presentation while retaining this plugin's floor behavior, and it
// forwards the full labeled-field control contract so a disabled or named
// field reaches the underlying input.
export function IntegerInput({
  value,
  min = 0,
  placeholder,
  onValueChange,
  id,
  name,
  disabled,
  required,
  'aria-describedby': ariaDescribedBy,
  'aria-errormessage': ariaErrorMessage,
  'aria-invalid': ariaInvalid,
}: Props): ReactElement {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (raw: string): void => {
    if (raw.trim() === '') {
      onValueChange(undefined);
      return;
    }
    const number = Number(raw);
    onValueChange(Number.isFinite(number) ? Math.max(min, Math.trunc(number)) : min);
  };

  return (
    <UiNumberInput
      id={id}
      name={name}
      disabled={disabled}
      min={min}
      required={required}
      value={draft ?? (value === undefined ? '' : String(value))}
      placeholder={placeholder}
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
