import { useCallback, useState } from 'react';

export interface UseOpenSections {
  isOpen: (id: string) => boolean;
  setOpen: (id: string, open: boolean) => void;
}

// Which collapsible top-level sections are open, keyed by section id. Every
// section starts collapsed so the panel opens compact, showing just the live
// status and the section headers. One map and one stable setter, so adding a
// section costs no new state or callback; a write that would not change the
// map returns it unchanged and adds no render.
export function useOpenSections(): UseOpenSections {
  const [open, setOpenMap] = useState<Record<string, boolean>>({});
  const setOpen = useCallback((id: string, next: boolean): void => {
    setOpenMap((prev) => (Boolean(prev[id]) === next ? prev : { ...prev, [id]: next }));
  }, []);
  const isOpen = (id: string): boolean => Boolean(open[id]);
  return { isOpen, setOpen };
}
