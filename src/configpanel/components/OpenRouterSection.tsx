import type { ReactElement, RefObject } from 'react';
import { memo, useId } from 'react';
import {
  Banner,
  Button,
  LabeledField,
  LiveRegion,
  NumberField,
  Select,
  Stack,
  splitLabeledFieldControlProps,
  TextInput,
} from 'signalk-nearlcrews-ui';
import { SecretInput } from 'signalk-nearlcrews-ui/forms';
import type { ModelOption, ModelsState, PanelConfig } from '../types.js';
import { DEFAULT_MAX_CALLS_PER_DAY, MAX_CALLS_PER_DAY } from '../utils.js';

// Written once so the banner and its announcement cannot drift apart.
const MODELS_ERROR = 'Could not load the model list. Type a model slug manually, or retry.';

interface Props {
  cfg: PanelConfig;
  set: (patch: Partial<PanelConfig>) => void;
  models: ModelOption[];
  modelsState: ModelsState;
  loadModels: () => Promise<void>;
  apiKeyRef: RefObject<HTMLInputElement | null>;
  // True once a save attempt was blocked here, which is the only moment the
  // field is genuinely in error: a pristine first-run panel must not accuse
  // the operator of an empty field they have not reached yet.
  submitted: boolean;
}

export const OpenRouterSection = memo(function OpenRouterSection({
  cfg,
  set,
  models,
  modelsState,
  loadModels,
  apiKeyRef,
  submitted,
}: Props): ReactElement {
  const openRouter: NonNullable<PanelConfig['openrouter']> = cfg.openrouter ?? {};
  const noApiKey = !openRouter.apiKey?.trim();
  // Two panels mounted in one document must not share a datalist id.
  const modelListId = useId();
  const modelHint =
    modelsState === 'loading'
      ? 'Loading available models…'
      : modelsState === 'ready'
        ? `${models.length} models available`
        : 'OpenRouter model slug';

  return (
    <Stack gap={3}>
      <LabeledField
        label="API key"
        description="Required to call the LLM. The value remains in Signal K plugin configuration."
        error={submitted && noApiKey ? 'Enter an OpenRouter API key.' : undefined}
        layout="inline"
        required
      >
        {(controlContract) => (
          <SecretInput
            {...splitLabeledFieldControlProps(controlContract).controlProps}
            ref={apiKeyRef}
            value={openRouter.apiKey ?? ''}
            onChange={(event) => set({ openrouter: { ...openRouter, apiKey: event.target.value } })}
          />
        )}
      </LabeledField>

      <LabeledField label="Model" description={modelHint} layout="inline">
        <TextInput
          list={modelListId}
          spellCheck={false}
          value={openRouter.model ?? ''}
          placeholder="provider/model-name"
          onFocus={() => void loadModels()}
          onChange={(event) => set({ openrouter: { ...openRouter, model: event.target.value } })}
        />
      </LabeledField>
      <datalist id={modelListId}>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name ?? model.id}
          </option>
        ))}
      </datalist>

      {/*
       * The banner below is created together with its text, which a screen
       * reader may never observe, so the announcement rides on this region
       * instead: it is mounted from the section's first render and only its
       * message changes.
       */}
      <LiveRegion message={modelsState === 'error' ? MODELS_ERROR : ''} />
      {modelsState === 'error' ? (
        <Banner
          tone="danger"
          actions={
            <Button size="compact" onClick={() => void loadModels()}>
              Retry
            </Button>
          }
        >
          {MODELS_ERROR}
        </Banner>
      ) : null}

      <NumberField
        label="Maximum calls per day"
        description="UTC daily cap on analyzer OpenRouter calls, from 1 to 1000. The Test button is exempt."
        layout="inline"
        // Clamp mode with an empty field allowed: a cleared field means "use the
        // plugin default", anything unparsable or outside the range commits the
        // nearest bound, and fractions truncate. Both bounds match the runtime
        // clamp, so the panel cannot save a number the plugin would rewrite.
        allowEmpty
        integer
        min={1}
        max={MAX_CALLS_PER_DAY}
        fallback={1}
        inputProps={{ placeholder: String(DEFAULT_MAX_CALLS_PER_DAY) }}
        value={openRouter.maxCallsPerDay}
        onValueChange={(value) => set({ openrouter: { ...openRouter, maxCallsPerDay: value } })}
      />

      <LabeledField
        label="Provider data"
        description="Deny routes only to providers that do not retain request data."
        layout="inline"
      >
        <Select
          value={openRouter.provider?.dataCollection ?? 'allow'}
          onChange={(event) =>
            set({
              openrouter: {
                ...openRouter,
                provider: {
                  ...openRouter.provider,
                  dataCollection: event.target.value as 'allow' | 'deny',
                },
              },
            })
          }
        >
          <option value="allow">Allow (default)</option>
          <option value="deny">Deny (privacy)</option>
        </Select>
      </LabeledField>
    </Stack>
  );
});
