import type { ReactElement, ReactNode, RefObject } from 'react';
import { useEffect, useRef } from 'react';
import { Button } from 'signalk-nearlcrews-ui';
import styles from './analyzer.module.css';

export interface DrawerHandles {
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
  readonly bodyRef: RefObject<HTMLDivElement | null>;
}

// Focus follows the drawer: opening moves it into the revealed body, closing
// returns it to the toggle so keyboard users never land on <body>.
export function useAnalyzerDrawer(open: boolean): DrawerHandles {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const previousOpen = useRef(open);
  useEffect(() => {
    if (open === previousOpen.current) return;
    previousOpen.current = open;
    if (open) bodyRef.current?.focus();
    else buttonRef.current?.focus();
  }, [open]);
  return { buttonRef, bodyRef };
}

interface ToggleProps {
  buttonRef: RefObject<HTMLButtonElement | null>;
  bodyId: string;
  open: boolean;
  // "reports" or "prompt": the drawer's contents, named in the button text and
  // in the per-analyzer accessible name.
  noun: string;
  // The verb used while the drawer is closed ("View" or "Edit"); closing is
  // always "Hide".
  openVerb: string;
  analyzerTitle: string;
  onToggle: () => void;
}

// The toggle half of a drawer. Kept separate from the body so both can keep
// their place in the row layout: every toggle sits in the button cluster and
// every body sits below it.
export function AnalyzerDrawerToggle({
  buttonRef,
  bodyId,
  open,
  noun,
  openVerb,
  analyzerTitle,
  onToggle,
}: ToggleProps): ReactElement {
  const verb = open ? 'Hide' : openVerb;
  return (
    <Button
      ref={buttonRef}
      aria-label={`${verb} ${noun} for ${analyzerTitle}`}
      aria-expanded={open}
      aria-controls={bodyId}
      onClick={onToggle}
    >
      {`${verb} ${noun}`}
    </Button>
  );
}

interface BodyProps {
  bodyRef: RefObject<HTMLDivElement | null>;
  bodyId: string;
  open: boolean;
  children: ReactNode;
}

// The body half of a drawer. It stays mounted while hidden so the toggle's
// aria-controls target always resolves, and its contents mount only while open.
export function AnalyzerDrawerBody({ bodyRef, bodyId, open, children }: BodyProps): ReactElement {
  return (
    <div id={bodyId} ref={bodyRef} className={styles.drawer} tabIndex={-1} hidden={!open}>
      {open ? children : null}
    </div>
  );
}
