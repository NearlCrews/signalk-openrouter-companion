import { useState } from 'react';
import { btn, btnClass, S } from '../styles.js';

const MODELS_HINT = {
  loading: 'Loading model list...',
  error: 'Could not load models; type slug manually',
};

export function OpenRouterSection({ cfg, set, models, modelsState, loadModels }) {
  const o = cfg.openrouter ?? {};
  const [showKey, setShowKey] = useState(false);
  const hint = MODELS_HINT[modelsState] ?? `${models.length} models available (autocomplete)`;
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
        <button
          type="button"
          className={btnClass(true)}
          style={btn(S.btnSecondary)}
          onClick={() => setShowKey((v) => !v)}
          aria-pressed={showKey}
        >
          {showKey ? 'Hide' : 'Show'}
        </button>
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
        <span style={S.hint}>{hint}</span>
      </div>
      <div style={S.fieldRow}>
        <label htmlFor="orc-max-calls" style={S.fieldLabel}>
          Max calls per day
        </label>
        <input
          id="orc-max-calls"
          type="number"
          min="0"
          style={{ ...S.input, ...S.inputSmall }}
          value={o.maxCallsPerDay ?? 0}
          onChange={(e) => set({ openrouter: { ...o, maxCallsPerDay: Number(e.target.value) } })}
        />
        <span style={S.hint}>UTC daily hard cap on OpenRouter calls</span>
      </div>
    </>
  );
}
