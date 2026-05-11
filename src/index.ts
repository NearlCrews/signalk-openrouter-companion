export default function createPlugin(_app: unknown) {
  return {
    id: 'signalk-openrouter-companion',
    name: 'OpenRouter Companion',
    schema: () => ({ type: 'object', properties: {} }),
    start: () => {},
    stop: () => {},
  };
}
