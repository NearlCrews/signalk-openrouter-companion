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
import { HISTORY_SOURCES, type HistorySource } from '../../historyConfig.js';
import type { HistoryTestResult, PanelConfig } from '../types.js';
import { HISTORY_SOURCE_LABELS, historyValidity, urlError } from '../utils.js';

type HistoryConfig = NonNullable<PanelConfig['history']>;

interface Props {
  // The history slice alone, so an edit elsewhere in the panel leaves this
  // memoized section's props unchanged.
  history: PanelConfig['history'];
  setHistory: (history: HistoryConfig) => void;
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
  history: saved,
  setHistory,
  testResult,
  onTest,
  testing,
  urlRef,
  databaseRef,
  submitted,
}: Props): ReactElement {
  const history: HistoryConfig = saved ?? {};
  const questdb = history.questdb ?? {};
  const influxdb = history.influxdb ?? {};
  const setQuestdb = (patch: Partial<NonNullable<HistoryConfig['questdb']>>): void =>
    setHistory({ ...history, questdb: { ...questdb, ...patch } });
  const setInfluxdb = (patch: Partial<NonNullable<HistoryConfig['influxdb']>>): void =>
    setHistory({ ...history, influxdb: { ...influxdb, ...patch } });
  const validity = historyValidity(saved);
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
            setHistory({ ...history, source: event.target.value as HistorySource })
          }
        >
          {HISTORY_SOURCES.map((value) => (
            <option key={value} value={value}>
              {HISTORY_SOURCE_LABELS[value]}
            </option>
          ))}
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
            onChange={(event) => setQuestdb({ url: event.target.value })}
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
              onChange={(event) => setInfluxdb({ version: event.target.value as '1' | '2' })}
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
              onChange={(event) => setInfluxdb({ url: event.target.value })}
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
              onChange={(event) => setInfluxdb({ database: event.target.value })}
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
              onChange={(event) => setInfluxdb({ username: event.target.value })}
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
                onChange={(event) => setInfluxdb({ password: event.target.value })}
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
