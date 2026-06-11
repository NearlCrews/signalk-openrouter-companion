import type { ReactElement } from 'react';
import { S } from '../styles.js';

// The shared caret glyph for a disclosure toggle, deduped from the section
// header and the analyzer header. Fixed-width so the label does not shift when
// the glyph swaps between the collapsed and expanded states.
export function DisclosureCaret({ expanded }: { expanded: boolean }): ReactElement {
  return (
    <span style={S.sectionToggleChevron} aria-hidden="true">
      {expanded ? '▾' : '▸'}
    </span>
  );
}
