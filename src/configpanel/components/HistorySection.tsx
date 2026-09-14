import type { ReactElement, RefObject } from 'react';
import { memo } from 'react';
import {
  Button,
  Cluster,
  LabeledField,
  Select,
  Stack,
  StatusIndicator,
  splitLabeledFieldControlProps,
  TextInput,
} from 'signalk-nearlcrews-ui';
import { SecretInput } from 'signalk-nearlcrews-ui/forms';
import type { HistoryTestResult, PanelConfig } from '../types.js';
import { historyValidity, urlError } from '../utils.js';

interface Props {
  cfg: PanelConfig;
  set: (patch: Partial<PanelConfig>) => void;
  testResult: HistoryTestResult | null;
  onTest: () => void;
  testing: boolean;
  urlRef: RefObject<HTMLInputElement | null>;
  databaseRef: RefObject<HTMLInputElement | null>;
  // True once a save attempt was blocked here, which is the only moment these
  // fields are genuinely in error: a pristine panel must not accuse the
  // operator of fields they have not reached yet.
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
  const validity = historyValidity(cfg.history);
  const { source, noUrl, invalidUrl, missingDatabase } = validity;
  const testText = testResult
    ? testResult.ok
      ? `Reachable at ${testResult.url}`
      : testResult.text
    : '';

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
          error={urlError(submitted, validity, 'Enter the QuestDB REST URL.')}
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
            error={urlError(submitted, validity, 'Enter the InfluxDB URL.')}
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
            error={
              submitted && missingDatabase ? 'Enter the database or DBRP database name.' : undefined
            }
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
              // A database credential the operator enters on the vessel's
              // behalf, not their own login for this origin. `username` would
              // opt it into identity autofill and, above the password field,
              // invite a password manager to store the pair as a login for the
              // Signal K server, which is what SecretInput beside it defaults
              // away from.
              autoComplete="off"
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
            {(controlContract) => (
              <SecretInput
                {...splitLabeledFieldControlProps(controlContract).controlProps}
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

      {/* The chip below appears with its text, so the panel announces the probe
       * result from the shell's own region instead: a region created together
       * with its message is not announced reliably. */}
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
            <StatusIndicator tone={testResult.ok ? 'success' : 'danger'}>
              {testText}
            </StatusIndicator>
          ) : null}
        </Cluster>
      ) : null}
    </Stack>
  );
});
