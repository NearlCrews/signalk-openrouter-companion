import { useCallback, useRef, useState } from 'react';
import { fetchJson } from '../api.js';
import type { ModelOption, ModelsState } from '../types.js';

export interface UseOpenRouterModels {
  models: ModelOption[];
  modelsState: ModelsState;
  loadModels: () => Promise<void>;
}

// Lazily fetches the OpenRouter model ids for the Model field's autocomplete.
// The caller triggers loadModels on first focus of the field so an install that
// never opens the OpenRouter section makes no request. A load already in flight
// is a no-op so a focus storm cannot stack requests, and a successful list is
// retained for the lifetime of the mounted panel. A failed request can still
// be retried explicitly.
export function useOpenRouterModels(): UseOpenRouterModels {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsState, setModelsState] = useState<ModelsState>('idle');
  const requestStateRef = useRef<ModelsState>('idle');

  const loadModels = useCallback(async (): Promise<void> => {
    if (requestStateRef.current === 'loading' || requestStateRef.current === 'ready') return;
    requestStateRef.current = 'loading';
    setModelsState('loading');
    const r = await fetchJson<{ data?: ModelOption[] }>('/openrouter/models');
    if (r.ok && r.body) {
      setModels(r.body.data ?? []);
      requestStateRef.current = 'ready';
      setModelsState('ready');
    } else {
      requestStateRef.current = 'error';
      setModelsState('error');
    }
  }, []);

  return { models, modelsState, loadModels };
}
