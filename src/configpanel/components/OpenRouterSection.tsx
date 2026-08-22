import type { ReactElement, RefObject } from 'react';
import { memo, useId } from 'react';
import { Banner, Button, LabeledField, Select, Stack, TextInput } from 'signalk-nearlcrews-ui';
import { SecretInput } from 'signalk-nearlcrews-ui/forms';
import type { ModelOption, ModelsState, PanelConfig } from '../types.js';
import { IntegerInput } from './IntegerInput.js';

interface Props {
  cfg: PanelConfig;
  set: (patch: Partial<PanelConfig>) => void;
  models: ModelOption[];
  modelsState: ModelsState;
  loadModels: () => Promise<void>;
  apiKeyRef: RefObject<HTMLInputElement | null>;
  // True once a save attempt was blocked here, which is the only moment a field
  // error is newly relevant and worth announcing.
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
      ? 'Loading available models...'
      : modelsState === 'ready'
        ? `${models.length} models available`
        : 'OpenRouter model slug';

  return (
    <Stack gap={3}>
      <LabeledField
        label="API key"
        description="Required to call the LLM. The value remains in Signal K plugin configuration."
        error={noApiKey ? 'Enter an OpenRouter API key.' : undefined}
        errorLive={submitted ? 'polite' : 'off'}
        layout="inline"
        required
      >
        {(controlProps) => (
          <SecretInput
            id={controlProps.id}
            aria-describedby={controlProps['aria-describedby']}
            aria-errormessage={controlProps['aria-errormessage']}
            aria-invalid={controlProps['aria-invalid']}
            disabled={controlProps.disabled}
            name={controlProps.name}
            required={controlProps.required}
            ref={apiKeyRef}
            autoComplete="new-password"
            spellCheck={false}
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

      {modelsState === 'error' ? (
        <Banner
          tone="danger"
          live="polite"
          actions={
            <Button size="compact" onClick={() => void loadModels()}>
              Retry
            </Button>
          }
        >
          Could not load the model list. Type a model slug manually, or retry.
        </Banner>
      ) : null}

      <LabeledField
        label="Maximum calls per day"
        description="UTC daily hard cap on OpenRouter calls. The Test button is exempt."
        layout="inline"
      >
        <IntegerInput
          value={openRouter.maxCallsPerDay}
          min={1}
          placeholder="50"
          onValueChange={(value) => set({ openrouter: { ...openRouter, maxCallsPerDay: value } })}
        />
      </LabeledField>

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
