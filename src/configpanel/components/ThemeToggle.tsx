import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { PANEL_CLASS } from '../styles.js';
import { SegmentedControl } from './SegmentedControl.js';

// "auto" follows the host admin UI theme; the explicit choices pin a theme by
// setting `data-orc-theme` on the `.orc-config-panel` root, which the theme
// override blocks in styles.ts key off.
export type ThemeChoice = 'auto' | 'light' | 'dark' | 'night';

const STORAGE_KEY = 'orc-theme';

const CHOICES: ReadonlyArray<{ value: ThemeChoice; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'night', label: 'Night' },
];

function readStoredChoice(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (CHOICES.some((c) => c.value === raw)) return raw as ThemeChoice;
  } catch {
    // Storage can be unavailable (private mode, blocked third-party storage);
    // fall through to following the host.
  }
  return 'auto';
}

// Segmented control that pins the panel theme: Auto (follow host), Light,
// Dark, or the red-preserving Night mode for night vision at the helm. The
// choice persists in localStorage and is applied to the nearest
// `.orc-config-panel` ancestor, so the control works wherever it is mounted.
export function ThemeToggle(): ReactElement {
  const [choice, setChoice] = useState<ThemeChoice>(readStoredChoice);
  const groupRef = useRef<HTMLFieldSetElement>(null);

  useEffect(() => {
    const root = groupRef.current?.closest(`.${PANEL_CLASS}`);
    if (!root) return;
    if (choice === 'auto') root.removeAttribute('data-orc-theme');
    else root.setAttribute('data-orc-theme', choice);
    try {
      window.localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // Persistence is best-effort; the in-session choice still applies.
    }
  }, [choice]);

  return (
    <SegmentedControl
      legend="Panel theme"
      choices={CHOICES}
      value={choice}
      onChange={setChoice}
      fieldsetRef={groupRef}
    />
  );
}
