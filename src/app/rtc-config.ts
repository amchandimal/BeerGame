const setupHelp = 'Run npm start from Angular-BeerGame to start the app and signaling service together. If using ng serve, start npm run start:server and restart ng serve.';

/** Reject an SPA fallback response before it can become a JSON syntax error. */
export async function loadRtcConfig(request: typeof fetch = fetch): Promise<RTCConfiguration> {
  let response: Response;
  try {
    response = await request('/rtc-config', {
      headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(8000)
    });
  } catch {
    throw new Error(`Cannot reach the multiplayer signaling service. ${setupHelp}`);
  }
  if (!response.ok) throw new Error(`Multiplayer signaling service is unavailable (HTTP ${response.status}). ${setupHelp}`);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json') && !contentType.includes('+json')) {
    throw new Error(`Multiplayer configuration returned a web page instead of JSON. ${setupHelp} On a hosted site, forward /rtc-config and /signaling to the signaling service.`);
  }
  let config: unknown;
  try { config = await response.json(); }
  catch { throw new Error(`Multiplayer configuration contains invalid JSON. ${setupHelp}`); }
  if (!config || typeof config !== 'object' || !('iceServers' in config) || !Array.isArray(config.iceServers) ||
    !config.iceServers.every(server => server && typeof server === 'object' &&
      (typeof server.urls === 'string' && server.urls.length > 0 || Array.isArray(server.urls) && server.urls.length > 0 && server.urls.every((url: unknown) => typeof url === 'string' && url.length > 0)))) {
    throw new Error(`Multiplayer configuration is missing valid ICE server settings. ${setupHelp}`);
  }
  return config as RTCConfiguration;
}
