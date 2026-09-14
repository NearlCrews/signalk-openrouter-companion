import type { ReactElement, ReactNode } from 'react';
import { useId } from 'react';
import { Text } from 'signalk-nearlcrews-ui';

export interface ControlHint {
  // Put on the control the hint describes, as `aria-describedby`.
  hintId: string;
  // Render near that control. It is a paragraph, so it sits outside the
  // control's own row rather than inside its label.
  hint: ReactElement;
}

// A line of prose that describes a control, wired to it by id.
//
// Three controls need one: the Fire button states what a run costs and, while
// the analyzer is disabled, why it is inert; the Test button states that its
// call is billed outside the daily cap; and the prompt drawer's Reset button
// states that there is nothing to reset. Each is `aria-disabled` rather than
// `disabled` so it keeps its place in the tab order, which is the whole reason
// the reason is prose: a `title` renders on pointer hover only, so a keyboard
// or touch user never sees one.
//
// The id, the paragraph, and its tone and size are one unit here so a fourth
// inert control cannot pair them differently. The shared UI ships no
// equivalent: `LabeledField`'s description belongs to a form control, and these
// are buttons.
export function useControlHint(text: ReactNode): ControlHint {
  const hintId = useId();
  return {
    hintId,
    hint: (
      <Text id={hintId} as="p" tone="muted" size="sm">
        {text}
      </Text>
    ),
  };
}
