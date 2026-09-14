import type { ReactElement } from 'react';
import { useId } from 'react';
import {
  Banner,
  Button,
  Card,
  Cluster,
  LabeledField,
  Stack,
  StatusIndicator,
  Text,
  Textarea,
} from 'signalk-nearlcrews-ui';
import type { AnalyzerUiState } from '../types.js';
import { isPromptOverride } from '../utils.js';

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
  // The drawer announces its own load and failure through the stable region
  // AnalyzerDrawerBody keeps outside this subtree, so nothing here is a live
  // region: every element below mounts together with the text it carries.
  const resetHintId = useId();

  if (!ui.promptLoaded) {
    return (
      <Card>
        <StatusIndicator tone="info">Loading prompt…</StatusIndicator>
      </Card>
    );
  }

  if (ui.promptError) {
    return (
      <Card>
        <Stack gap={3}>
          <Banner tone="danger">Failed to load prompt: {ui.promptError}</Banner>
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
            monospace
            minRows={8}
            spellCheck={false}
            value={value}
            onChange={(event) => onChange(analyzerId, event.target.value)}
          />
        </LabeledField>
        {!isOverride ? (
          // The reason the reset is inert, as text rather than a `title`:
          // a title renders on pointer hover only, so a keyboard or touch
          // user never sees one.
          <Text id={resetHintId} as="p" tone="muted" size="sm">
            This analyzer is already using the built-in default, so there is nothing to reset.
          </Text>
        ) : null}
        <Cluster gap={2} justify="end">
          <Button
            // aria-disabled rather than disabled: the control keeps focus, so
            // the description above reaches a keyboard user who lands on it.
            ariaDisabled={!isOverride}
            aria-describedby={isOverride ? undefined : resetHintId}
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
