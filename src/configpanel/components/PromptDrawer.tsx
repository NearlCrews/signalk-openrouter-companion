import type { ReactElement } from 'react';
import {
  Banner,
  Button,
  Card,
  Cluster,
  LabeledField,
  Stack,
  StatusIndicator,
  Textarea,
} from 'signalk-nearlcrews-ui';
import type { AnalyzerUiState } from '../types.js';
import { isPromptOverride } from '../utils.js';
import styles from './PromptDrawer.module.css';

interface Props {
  analyzerId: string;
  ui: AnalyzerUiState;
  value: string;
  onChange: (id: string, value: string) => void;
  onReset: (id: string) => void;
  onClose: () => void;
}

export function PromptDrawer({
  analyzerId,
  ui,
  value,
  onChange,
  onReset,
  onClose,
}: Props): ReactElement {
  if (!ui.promptLoaded) {
    return (
      <Card>
        <StatusIndicator tone="info" role="status" aria-live="polite">
          Loading prompt...
        </StatusIndicator>
      </Card>
    );
  }

  if (ui.promptError) {
    return (
      <Card>
        <Stack gap={3}>
          <Banner tone="danger" live="assertive">
            Failed to load prompt: {ui.promptError}
          </Banner>
          <Cluster justify="end">
            <Button onClick={onClose}>Close</Button>
          </Cluster>
        </Stack>
      </Card>
    );
  }

  const isOverride = isPromptOverride(value, ui.promptDefault);
  return (
    <Card>
      <Stack gap={3}>
        <LabeledField
          label="System prompt"
          description={`The prompt the LLM receives. Save the panel to apply changes. ${
            isOverride ? 'A custom override is active.' : 'The built-in default is active.'
          }`}
        >
          <Textarea
            className={styles.textarea}
            spellCheck={false}
            value={value}
            onChange={(event) => onChange(analyzerId, event.target.value)}
          />
        </LabeledField>
        <Cluster gap={2} justify="end">
          <Button
            disabled={!isOverride}
            title={isOverride ? undefined : 'Already using the built-in default'}
            onClick={() => onReset(analyzerId)}
          >
            Reset to default
          </Button>
          <Button onClick={onClose}>Close</Button>
        </Cluster>
      </Stack>
    </Card>
  );
}
