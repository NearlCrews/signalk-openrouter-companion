import type { ReactElement, RefObject } from 'react';
import { memo } from 'react';
import {
  Button,
  Cluster,
  LabeledField,
  Select,
  Stack,
  StatusIndicator,
  TextInput,
} from 'signalk-nearlcrews-ui';
import { SecretInput } from 'signalk-nearlcrews-ui/forms';
import type { HistoryTestResult, PanelConfig } from '../types.js';
import { HISTORY_URL_RULE, historyValidity } from '../utils.js';

interface Props {
  cfg: PanelConfig;
  set: (patch: Partial<PanelConfig>) => void;
  testResult: HistoryTestResult | null;
  onTest: () => void;
  testing: boolean;
  urlRef: RefObject<HTMLInputElement | null>;
  databaseRef: RefObject<HTMLInputElement | null>;
  // True once a save attempt was blocked here, which is the only moment a field
  // error is newly relevant and worth announcing.
  submitted: boolean;
}

export const HistorySection = memo(function HistorySection({
  cfg,
  set,
  testResult,
  onTest,
  testing,
  urlRef,
  databaseRef,
  submitted,
}: Props): ReactElement {
  const history: NonNullable<PanelConfig['history']> = cfg.history ?? {};
  const questdb = history.questdb ?? {};
  const influxdb = history.influxdb ?? {};
  const { source, noUrl, invalidUrl, missingDatabase } = historyValidity(cfg.history);
  const errorLive = submitted ? 'polite' : 'off';

  return (
    <Stack gap={3}>
      <LabeledField
        label="History provider"
        description="Aging and drift require history; forecast uses it as a baseline."
        layout="inline"
      >
        <Select
          value={source}
          onChange={(event) =>
            set({
              history: {
                ...history,
                source: event.target.value as 'none' | 'questdb' | 'influxdb',
              },
            })
          }
        >
          <option value="none">Disabled</option>
          <option value="questdb">QuestDB</option>
          <option value="influxdb">InfluxDB</option>
        </Select>
      </LabeledField>

      {source === 'questdb' ? (
        <LabeledField
          label="QuestDB REST URL"
          description="The HTTP endpoint reachable from the Signal K server."
          error={
            noUrl
              ? 'Enter the QuestDB REST URL.'
              : invalidUrl
                ? `Enter an ${HISTORY_URL_RULE}.`
                : undefined
          }
          errorLive={errorLive}
          layout="inline"
          required
        >
          <TextInput
            ref={urlRef}
            type="url"
            placeholder="http://localhost:9000"
            value={questdb.url ?? ''}
            onChange={(event) =>
              set({ history: { ...history, questdb: { ...questdb, url: event.target.value } } })
            }
          />
        </LabeledField>
      ) : null}

      {source === 'influxdb' ? (
        <>
          <LabeledField
            label="InfluxDB version"
            description="Version 2 requires its InfluxQL DBRP mapping."
            layout="inline"
          >
            <Select
              value={influxdb.version ?? '1'}
              onChange={(event) =>
                set({
                  history: {
                    ...history,
                    influxdb: { ...influxdb, version: event.target.value as '1' | '2' },
                  },
                })
              }
            >
              <option value="1">InfluxDB 1.x</option>
              <option value="2">InfluxDB 2.x</option>
            </Select>
          </LabeledField>
          <LabeledField
            label="InfluxDB URL"
            description="The v1-compatible HTTP endpoint reachable from Signal K."
            error={
              noUrl
                ? 'Enter the InfluxDB URL.'
                : invalidUrl
                  ? `Enter an ${HISTORY_URL_RULE}.`
                  : undefined
            }
            errorLive={errorLive}
            layout="inline"
            required
          >
            <TextInput
              ref={urlRef}
              type="url"
              placeholder="http://localhost:8086"
              value={influxdb.url ?? ''}
              onChange={(event) =>
                set({
                  history: { ...history, influxdb: { ...influxdb, url: event.target.value } },
                })
              }
            />
          </LabeledField>
          <LabeledField
            label="Database"
            description="For version 2, enter the DBRP database name."
            error={missingDatabase ? 'Enter the database or DBRP database name.' : undefined}
            errorLive={errorLive}
            layout="inline"
            required
          >
            <TextInput
              ref={databaseRef}
              placeholder="signalk"
              value={influxdb.database ?? ''}
              onChange={(event) =>
                set({
                  history: {
                    ...history,
                    influxdb: { ...influxdb, database: event.target.value },
                  },
                })
              }
            />
          </LabeledField>
          <LabeledField
            label="Username"
            description="Leave blank to use InfluxDB 2 token authentication."
            layout="inline"
          >
            <TextInput
              autoComplete="username"
              value={influxdb.username ?? ''}
              onChange={(event) =>
                set({
                  history: {
                    ...history,
                    influxdb: { ...influxdb, username: event.target.value },
                  },
                })
              }
            />
          </LabeledField>
          <LabeledField
            label="Password or API token"
            description="InfluxDB 2 uses an API token here."
            layout="inline"
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
                autoComplete="new-password"
                spellCheck={false}
                value={influxdb.password ?? ''}
                onChange={(event) =>
                  set({
                    history: {
                      ...history,
                      influxdb: { ...influxdb, password: event.target.value },
                    },
                  })
                }
              />
            )}
          </LabeledField>
        </>
      ) : null}

      {source !== 'none' ? (
        <Cluster gap={3}>
          <Button
            variant="primary"
            loading={testing}
            loadingLabel="Testing"
            disabled={noUrl || invalidUrl || missingDatabase}
            onClick={onTest}
          >
            Test connection
          </Button>
          {testResult ? (
            <StatusIndicator tone={testResult.ok ? 'success' : 'danger'} live="polite">
              {testResult.ok ? `Reachable at ${testResult.url}` : testResult.text}
            </StatusIndicator>
          ) : null}
        </Cluster>
      ) : null}
    </Stack>
  );
});
