import type { ReactElement, ReactNode } from 'react';
import { S } from '../styles.js';
import { DisclosureCaret } from './DisclosureCaret.js';

interface Props {
  // Stable id; the body is `${id}-body` and the header button's aria-controls
  // points at it.
  id: string;
  title: string;
  open: boolean;
  // Called with the section id so the panel can drive every section from one
  // stable callback and one open-state map.
  onToggle: (id: string) => void;
  children: ReactNode;
}

// A section header rendered as a full-width disclosure button that toggles its
// body, wrapped in an h2 so the panel exposes a real heading outline. The
// OpenRouter and QuestDB sections use it so the panel opens focused on the
// analyzer list rather than the rarely-changed connection settings.
//
// The body element stays mounted (hidden when collapsed) so the header's
// aria-controls target always resolves, while the expensive children mount only
// while open.
export function CollapsibleSection({ id, title, open, onToggle, children }: Props): ReactElement {
  const bodyId = `${id}-body`;
  return (
    <>
      <h2 style={S.headingReset}>
        <button
          type="button"
          style={S.sectionToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => onToggle(id)}
        >
          <DisclosureCaret expanded={open} />
          {title}
        </button>
      </h2>
      <div id={bodyId} hidden={!open}>
        {open ? children : null}
      </div>
    </>
  );
}
