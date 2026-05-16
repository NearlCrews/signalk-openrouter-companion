import { btn, S } from '../styles.js';
import { T } from '../tokens.js';

export function PromptDrawer({ analyzerId, ui, value, onChange, onReset, onClose }) {
  if (!ui.promptLoaded)
    return (
      <div style={S.drawer}>
        <div style={S.empty}>Loading prompt...</div>
      </div>
    );
  const isOverride = value !== ui.promptDefault;
  return (
    <div style={S.drawer}>
      <div style={{ marginBottom: T.space.md }}>
        <div
          style={{
            fontSize: T.fontSize.sm,
            fontWeight: T.fontWeight.semibold,
            marginBottom: T.space.xs,
          }}
        >
          System prompt
        </div>
        <div style={S.hint}>
          The prompt the LLM receives. Save the panel to apply changes.
          {isOverride ? ' (custom override active)' : ' (using built-in default)'}
        </div>
      </div>
      <textarea
        style={S.textarea}
        value={value}
        onChange={(e) => onChange(analyzerId, e.target.value)}
      />
      <div style={S.inlineRow}>
        <button type="button" style={btn(S.btnSecondary)} onClick={() => onReset(analyzerId)}>
          Reset to default
        </button>
        <button type="button" style={btn(S.btnSecondary)} onClick={onClose}>
          Close
        </button>
        {ui.promptError && <span style={{ ...S.testStatus, ...S.testErr }}>{ui.promptError}</span>}
      </div>
    </div>
  );
}
