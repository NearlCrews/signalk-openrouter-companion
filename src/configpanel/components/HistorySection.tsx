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
import type { HistoryTestResult, PanelConfig } from '../types.js';
import { isHttpUrl } from '../utils.js';

interface Props {
  cfg: PanelConfig;
  set: (patch: Partial<PanelConfig>) => void;
  testResult: HistoryTestResult | null;
  onTest: () => void;
  testing: boolean;
  urlRef: RefObject<HTMLInputElement | null>;
  databaseRef: RefObject<HTMLInputElement | null>;
}

export const HistorySection = memo(function HistorySection({
  cfg,
  set,
  testResult,
  onTest,
  testing,
  urlRef,
  databaseRef,
}: Props): ReactElement {
  const history: NonNullable<PanelConfig['history']> = cfg.history ?? {};
  const source = history.source ?? 'questdb';
  const questdb = history.questdb ?? {};
  const influxdb = history.influxdb ?? {};
  const activeUrl = source === 'influxdb' ? influxdb.url : questdb.url;
  const noUrl = source !== 'none' && !activeUrl?.trim();
  const invalidUrl = source !== 'none' && !noUrl && !isHttpUrl(activeUrl, source === 'influxdb');
  const missingDatabase = source === 'influxdb' && !influxdb.database?.trim();

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
                ? 'Enter an HTTP or HTTPS base URL without a query or fragment.'
                : undefined
          }
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
                  ? 'Enter an HTTP or HTTPS base URL without a query or fragment.'
                  : undefined
            }
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
            <TextInput
              type="password"
              autoComplete="new-password"
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
            <StatusIndicator tone={testResult.ok ? 'success' : 'danger'} role="status">
              {testResult.ok ? `Reachable at ${testResult.url}` : testResult.text}
            </StatusIndicator>
          ) : null}
        </Cluster>
      ) : null}
    </Stack>
  );
});
