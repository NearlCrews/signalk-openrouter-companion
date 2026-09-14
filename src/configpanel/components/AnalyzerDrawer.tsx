import type { ReactElement, ReactNode } from 'react';
import { Button } from 'signalk-nearlcrews-ui';
import type { UseDisclosureResult } from 'signalk-nearlcrews-ui/composites';
import styles from './analyzer.module.css';

// A drawer is a button-triggered inline disclosure rather than a heading
// section, so it rides on the shared headless `useDisclosure`: the ids,
// aria-expanded, aria-controls, hidden, and the focus handoff (into the region
// on open, back to the toggle on close) all come from there, and the row calls
// it directly. The toggle and the body are separate pieces so every toggle sits
// in the row's button cluster and every body sits below it.

interface ToggleProps {
  drawer: UseDisclosureResult;
  // "reports" or "prompt": the drawer's contents, named in the button text and
  // in the per-analyzer accessible name.
  noun: string;
  // The verb used while the drawer is closed ("View" or "Edit"); closing is
  // always "Hide".
  openVerb: string;
  analyzerTitle: string;
}

export function AnalyzerDrawerToggle({
  drawer,
  noun,
  openVerb,
  analyzerTitle,
}: ToggleProps): ReactElement {
  const verb = drawer.open ? 'Hide' : openVerb;
  return (
    <Button {...drawer.triggerProps} aria-label={`${verb} ${noun} for ${analyzerTitle}`}>
      {`${verb} ${noun}`}
    </Button>
  );
}

interface BodyProps {
  drawer: UseDisclosureResult;
  // The region's own name. The toggle's label flips between its verbs, so the
  // region is not named after it.
  label: string;
  children: ReactNode;
}

// The body stays mounted while hidden so the toggle's aria-controls target
// always resolves, and its contents mount only while open.
export function AnalyzerDrawerBody({ drawer, label, children }: BodyProps): ReactElement {
  return (
    <section
      {...drawer.panelProps}
      aria-labelledby={undefined}
      aria-label={label}
      className={styles.drawer}
    >
      {drawer.open ? children : null}
    </section>
  );
}
