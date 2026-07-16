import type { ReactElement, RefObject } from 'react';
import { memo } from 'react';
import {
  Button,
  Checkbox,
  Cluster,
  LabeledField,
  Stack,
  StatusIndicator,
  TextInput,
} from 'signalk-nearlcrews-ui';
import type { PanelConfig, QdbTestResult } from '../types.js';
import { isHttpUrl } from '../utils.js';

interface Props {
  cfg: PanelConfig;
  set: (patch: Partial<PanelConfig>) => void;
  testResult: QdbTestResult | null;
  onTest: () => void;
  testing: boolean;
  urlRef: RefObject<HTMLInputElement | null>;
}

export const QuestDBSection = memo(function QuestDBSection({
  cfg,
  set,
  testResult,
  onTest,
  testing,
  urlRef,
}: Props): ReactElement {
  const questdb: NonNullable<PanelConfig['questdb']> = cfg.questdb ?? {};
  const noUrl = !questdb.url?.trim();
  const invalidUrl = !noUrl && !isHttpUrl(questdb.url);

  return (
    <Stack gap={3}>
      <Checkbox
        label="Enable QuestDB enrichment"
        description="The aging and drift trend analyzers require QuestDB."
        checked={Boolean(questdb.enabled)}
        onChange={(event) => set({ questdb: { ...questdb, enabled: event.target.checked } })}
      />
      {questdb.enabled ? (
        <>
          <LabeledField
            label="QuestDB REST URL"
            description="The HTTP endpoint reachable from the Signal K server."
            error={
              noUrl
                ? 'Enter the QuestDB REST URL.'
                : invalidUrl
                  ? 'Enter an HTTP or HTTPS base URL without a query or fragment.'
                  : undefined
            }
            layout="inline"
            required
          >
            <TextInput
              ref={urlRef}
              type="url"
              spellCheck={false}
              placeholder="http://localhost:9000"
              value={questdb.url ?? ''}
              onChange={(event) => set({ questdb: { ...questdb, url: event.target.value } })}
            />
          </LabeledField>
          <Cluster gap={3}>
            <Button
              variant="primary"
              loading={testing}
              loadingLabel="Testing"
              disabled={noUrl || invalidUrl}
              title={
                noUrl || invalidUrl
                  ? 'Enter a valid HTTP or HTTPS base URL without a query or fragment first'
                  : undefined
              }
              onClick={onTest}
            >
              Test connection
            </Button>
            {testResult ? (
              <StatusIndicator
                tone={testResult.ok ? 'success' : 'danger'}
                role="status"
                aria-live="polite"
              >
                {testResult.ok ? `Reachable at ${testResult.url}` : testResult.text}
              </StatusIndicator>
            ) : null}
          </Cluster>
        </>
      ) : null}
    </Stack>
  );
});
