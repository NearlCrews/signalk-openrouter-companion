import type { ReactElement } from 'react';
import { memo, useState } from 'react';
import { S } from '../styles.js';
import type { ModelOption, ModelsState, PanelConfig } from '../types.js';
import { NumberInput } from './NumberInput.js';
import { SecondaryButton } from './SecondaryButton.js';

interface Props {
  cfg: PanelConfig;
  set: (patch: Partial<PanelConfig>) => void;
  models: ModelOption[];
  modelsState: ModelsState;
  loadModels: () => void;
}

// Memoized: a status poll re-render must not touch this section, and a keystroke
// in another section leaves cfg's identity changed but this section's fields
// equal, so the leaf still re-renders only on its own edits.
export const OpenRouterSection = memo(function OpenRouterSection({
  cfg,
  set,
  models,
  modelsState,
  loadModels,
}: Props): ReactElement {
  const o: NonNullable<PanelConfig['openrouter']> = cfg.openrouter ?? {};
  const [showKey, setShowKey] = useState(false);
  const modelsFailed = modelsState === 'error';
  const hint =
    modelsState === 'loading'
      ? 'Loading model list...'
      : modelsFailed
        ? ''
        : `${models.length} models available (autocomplete)`;
  return (
    <>
      <div style={S.fieldRow}>
        <label htmlFor="orc-api-key" style={S.fieldLabel}>
          API key
        </label>
        <input
          id="orc-api-key"
          type={showKey ? 'text' : 'password'}
          autoComplete="new-password"
          spellCheck={false}
          placeholder="sk-or-v1-..."
          style={S.input}
          value={o.apiKey ?? ''}
          onChange={(e) => set({ openrouter: { ...o, apiKey: e.target.value } })}
        />
        <SecondaryButton onClick={() => setShowKey((v) => !v)} aria-pressed={showKey}>
          {showKey ? 'Hide' : 'Show'}
        </SecondaryButton>
        <span style={S.hint}>Required to call the LLM</span>
      </div>
      <div style={S.fieldRow}>
        <label htmlFor="orc-model" style={S.fieldLabel}>
          Model
        </label>
        <input
          id="orc-model"
          type="text"
          list="openrouter-models"
          spellCheck={false}
          style={S.input}
          value={o.model ?? ''}
          onFocus={() => modelsState === 'idle' && loadModels()}
          onChange={(e) => set({ openrouter: { ...o, model: e.target.value } })}
        />
        <datalist id="openrouter-models">
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name || m.id}
            </option>
          ))}
        </datalist>
        {hint && <span style={S.hint}>{hint}</span>}
      </div>
      {modelsFailed && (
        <div style={S.errorBanner} role="alert">
          <span>Could not load the model list. Type a model slug manually, or retry.</span>
          <SecondaryButton onClick={loadModels}>Retry</SecondaryButton>
        </div>
      )}
      <div style={S.fieldRow}>
        <label htmlFor="orc-max-calls" style={S.fieldLabel}>
          Max calls per day
        </label>
        <NumberInput
          id="orc-max-calls"
          ariaLabel="Max OpenRouter calls per day"
          value={o.maxCallsPerDay}
          min={1}
          placeholder="e.g. 50"
          style={S.inputSmall}
          onChange={(n) => set({ openrouter: { ...o, maxCallsPerDay: n } })}
        />
        <span style={S.hint}>UTC daily hard cap on OpenRouter calls (Test button is exempt)</span>
      </div>
      <div style={S.fieldRow}>
        <label htmlFor="orc-data-collection" style={S.fieldLabel}>
          Provider data
        </label>
        <select
          id="orc-data-collection"
          style={S.inputSmall}
          value={o.provider?.dataCollection ?? 'allow'}
          onChange={(e) =>
            set({
              openrouter: {
                ...o,
                provider: { ...o.provider, dataCollection: e.target.value as 'allow' | 'deny' },
              },
            })
          }
        >
          <option value="allow">Allow (default)</option>
          <option value="deny">Deny (privacy)</option>
        </select>
        <span style={S.hint}>Deny routes only to providers that do not retain request data</span>
      </div>
    </>
  );
});
