import { S } from '../styles.js';

const MODELS_HINT = {
  loading: 'Loading model list...',
  error: 'Could not load models; type slug manually',
};

export function OpenRouterSection({ cfg, set, models, modelsState, loadModels }) {
  const o = cfg.openrouter ?? {};
  const hint = MODELS_HINT[modelsState] ?? `${models.length} models available (autocomplete)`;
  return (
    <>
      <div style={S.sectionTitle}>OpenRouter</div>
      <div style={S.fieldRow}>
        <span style={S.fieldLabel}>API key</span>
        <input
          type="password"
          autoComplete="new-password"
          style={S.input}
          value={o.apiKey ?? ''}
          onChange={(e) => set({ openrouter: { ...o, apiKey: e.target.value } })}
        />
        <span style={S.hint}>Required to call the LLM</span>
      </div>
      <div style={S.fieldRow}>
        <span style={S.fieldLabel}>Model</span>
        <input
          type="text"
          list="openrouter-models"
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
        <span style={S.fieldLabel}>Max calls per day</span>
        <input
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
