import type { ReactElement, RefObject } from 'react';
import { memo, useState } from 'react';
import {
  Banner,
  Button,
  InputGroup,
  InputGroupControl,
  LabeledField,
  Select,
  Stack,
  TextInput,
} from 'signalk-nearlcrews-ui';
import type { ModelOption, ModelsState, PanelConfig } from '../types.js';
import { IntegerInput } from './IntegerInput.js';

interface Props {
  cfg: PanelConfig;
  set: (patch: Partial<PanelConfig>) => void;
  models: ModelOption[];
  modelsState: ModelsState;
  loadModels: () => Promise<void>;
  apiKeyRef: RefObject<HTMLInputElement | null>;
}

export const OpenRouterSection = memo(function OpenRouterSection({
  cfg,
  set,
  models,
  modelsState,
  loadModels,
  apiKeyRef,
}: Props): ReactElement {
  const openRouter: NonNullable<PanelConfig['openrouter']> = cfg.openrouter ?? {};
  const [showKey, setShowKey] = useState(false);
  const noApiKey = !openRouter.apiKey?.trim();
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
        layout="inline"
        required
      >
        {(controlProps) => (
          <InputGroup>
            <InputGroupControl width="grow">
              <TextInput
                {...controlProps}
                ref={apiKeyRef}
                type={showKey ? 'text' : 'password'}
                autoComplete="new-password"
                spellCheck={false}
                value={openRouter.apiKey ?? ''}
                onChange={(event) =>
                  set({ openrouter: { ...openRouter, apiKey: event.target.value } })
                }
              />
            </InputGroupControl>
            <Button
              size="compact"
              aria-pressed={showKey}
              onClick={() => setShowKey((visible) => !visible)}
            >
              {showKey ? 'Hide' : 'Show'}
            </Button>
          </InputGroup>
        )}
      </LabeledField>

      <LabeledField label="Model" description={modelHint} layout="inline">
        <TextInput
          list="openrouter-models"
          spellCheck={false}
          value={openRouter.model ?? ''}
          placeholder="provider/model-name"
          onFocus={() => void loadModels()}
          onChange={(event) => set({ openrouter: { ...openRouter, model: event.target.value } })}
        />
      </LabeledField>
      <datalist id="openrouter-models">
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
          allowEmpty
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
