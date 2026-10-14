// Requests one short-lived Cloudflare TURN credential through the server's own code, prints its URLs and lifetime (never the credential or the token), then revokes it, as the server does when players no longer need theirs.
// Run it with the server's variables, for example: node --env-file=.env scripts/check-turn.mjs
import { cloudflareIce, revokeCloudflareIce } from '../server/index.mjs';
const { CLOUDFLARE_TURN_KEY_ID: keyId, CLOUDFLARE_TURN_KEY_API_TOKEN: token, TURN_TTL_SECONDS: players } = process.env, ttl = 60;
if (!keyId || !token) { console.error('Set CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_KEY_API_TOKEN, for example: node --env-file=.env scripts/check-turn.mjs'); process.exit(1); }
try {
  const iceServers = await cloudflareIce({ keyId, token, ttl });
  console.log(`Cloudflare issued a TURN credential that expires in ${ttl} seconds (players' credentials last TURN_TTL_SECONDS, ${players || 10800} seconds). Players receive these URLs (port 53 removed):`);
  for (const url of iceServers.flatMap(server => server.urls)) console.log(`  ${url}`);
  try {
    for (const username of new Set(iceServers.map(server => server.username))) await revokeCloudflareIce({ keyId, token }, username);
    console.log('The credential was then revoked, so the server can revoke players\' credentials when they are no longer needed.');
  } catch (e) { console.error(`Revoking the credential failed: ${e.message}. Players' credentials would last until they expire.`); process.exitCode = 1; }
} catch (e) { console.error(`Cloudflare TURN check failed: ${e.message}. Check the key ID and API token.`); process.exitCode = 1; }
