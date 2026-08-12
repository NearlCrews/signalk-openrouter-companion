const configuredPort = Number(process.env.ORC_BROWSER_PORT ?? 4174);

if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) {
  throw new Error('ORC_BROWSER_PORT must be an integer between 1 and 65535');
}

export const browserFixturePort = configuredPort;
