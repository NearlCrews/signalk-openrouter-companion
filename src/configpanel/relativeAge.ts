/**
 * Options every relative-age display in this panel passes to the shared UI's
 * `formatRelativeAge`. The library default is numeric-always and narrow, which
 * renders a fresh timestamp as "0 sec. ago"; `numeric: 'auto'` says "now" and
 * `style: 'long'` spells the unit out. One constant so a second age display
 * cannot drift from the first.
 */
export const RELATIVE_AGE_FORMAT = { numeric: 'auto', style: 'long' } as const;
