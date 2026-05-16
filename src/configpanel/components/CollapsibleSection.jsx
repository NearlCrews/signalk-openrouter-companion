import { S } from '../styles.js';

// A section header rendered as a full-width button that toggles its body.
// The OpenRouter and QuestDB sections use it so the panel opens focused on
// the analyzer list rather than the rarely-changed connection settings.
export function CollapsibleSection({ title, open, onToggle, children }) {
  return (
    <>
      <button type="button" style={S.sectionToggle} aria-expanded={open} onClick={onToggle}>
        <span style={S.sectionToggleChevron} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        {title}
      </button>
      {open && children}
    </>
  );
}
