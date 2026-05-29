import { btn, btnClass, S } from '../styles.js';
import { T } from '../tokens.js';

export function PromptDrawer({ analyzerId, ui, value, onChange, onReset, onClose }) {
  if (!ui.promptLoaded)
    return (
      <div style={S.drawer}>
        <div style={S.empty} role="status" aria-live="polite">
          Loading prompt...
        </div>
      </div>
    );
  // A failed fetch leaves promptDefault undefined. Show the error and suppress
  // the textarea: editing an empty one would write a bogus customSystemPrompt
  // over the real saved prompt.
  if (ui.promptError)
    return (
      <div style={S.drawer}>
        <div style={{ ...S.testStatus, ...S.testErr }} role="status" aria-live="polite">
          Failed to load prompt: {ui.promptError}
        </div>
        <div style={S.inlineRow}>
          <button
            type="button"
            className={btnClass(true)}
            style={btn(S.btnSecondary)}
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    );
  const textareaId = `orc-prompt-${analyzerId}`;
  const isOverride = value !== ui.promptDefault;
  return (
    <div style={S.drawer}>
      <div style={{ marginBottom: T.space.md }}>
        <label
          htmlFor={textareaId}
          style={{
            display: 'block',
            fontSize: T.fontSize.sm,
            fontWeight: T.fontWeight.semibold,
            marginBottom: T.space.xs,
          }}
        >
          System prompt
        </label>
        <div style={S.hint}>
          The prompt the LLM receives. Save the panel to apply changes.
          {isOverride ? ' (custom override active)' : ' (using built-in default)'}
        </div>
      </div>
      <textarea
        id={textareaId}
        style={S.textarea}
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(analyzerId, e.target.value)}
      />
      <div style={S.inlineRow}>
        <button
          type="button"
          className={btnClass(true)}
          style={btn(S.btnSecondary, !isOverride && S.btnDisabled)}
          disabled={!isOverride}
          title={isOverride ? undefined : 'Already using the built-in default'}
          onClick={() => onReset(analyzerId)}
        >
          Reset to default
        </button>
        <button
          type="button"
          className={btnClass(true)}
          style={btn(S.btnSecondary)}
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}
