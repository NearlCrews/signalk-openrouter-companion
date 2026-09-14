// The daily OpenRouter call budget: the cap a fresh install runs with, and the
// ceiling the runtime clamps any configured value to.
//
// A dependency-free leaf module the way src/severityFloors.ts is for the
// forecast scale, and for the same reason: the option normalizer in
// src/types.ts, the JSON schema in src/schema.ts, and the configuration panel
// all state these two numbers, and the panel cannot reach into the plugin's
// runtime types. One module they all read is the single source of truth, rather
// than three copies kept honest by a test that notices one going stale.

// What an empty "maximum calls per day" field applies. The panel shows it as
// the field's placeholder, so the operator reads the cap that leaving it empty
// will use.
export const DEFAULT_MAX_CALLS_PER_DAY = 20;

// The most an operator may configure. The runtime clamps to it, the schema
// advertises it as the field's `maximum`, and the panel refuses anything above
// it, so a saved value the plugin would silently rewrite cannot be entered.
export const MAX_CALLS_PER_DAY_CEILING = 1000;
