import type { ReactElement, Ref } from 'react';
import { S } from '../styles.js';

interface Props<V extends string> {
  // Visually hidden <legend> naming the control for screen readers.
  legend: string;
  choices: ReadonlyArray<{ value: V; label: string }>;
  value: V;
  onChange: (next: V) => void;
  // Optional ref to the <fieldset>, for callers that need the DOM node
  // (ThemeToggle finds the nearest `.orc-config-panel` ancestor through it).
  fieldsetRef?: Ref<HTMLFieldSetElement>;
}

// Compact segmented control: a bordered fieldset of aria-pressed buttons with
// the active segment filled by the accent. Each segment is a 36px touch
// target for marine use.
export function SegmentedControl<V extends string>({
  legend,
  choices,
  value,
  onChange,
  fieldsetRef,
}: Props<V>): ReactElement {
  return (
    <fieldset ref={fieldsetRef} style={S.segmented}>
      <legend style={S.visuallyHidden}>{legend}</legend>
      {choices.map((c) => (
        <button
          key={c.value}
          type="button"
          aria-pressed={value === c.value}
          style={
            value === c.value ? { ...S.segmentedBtn, ...S.segmentedBtnActive } : S.segmentedBtn
          }
          onClick={() => onChange(c.value)}
        >
          {c.label}
        </button>
      ))}
    </fieldset>
  );
}
