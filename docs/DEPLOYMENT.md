# Deploying beergame.io

This is a single-instance, in-memory hosted game. It is not yet a subscription/account/billing platform. The same MIT-licensed code powers self-hosting and the hosted service.

The beergame.io public beta runs on Oracle Cloud Infrastructure (India South, Hyderabad) behind nginx with certbot, uses Cloudflare's STUN servers and Cloudflare's TURN relay with short-lived per-player credentials (see [Cloudflare TURN relay](#cloudflare-turn-relay)), and keeps web server logs for 14 days. site.config.json and the generated privacy page describe exactly this. If any of it changes, update site.config.json (and the privacy text in scripts/build-site.mjs) before the change goes live.

## Packages

`pnpm run release:draft` builds three versioned archives under ignored `releases/` with SHA-256 checksums: source (Docker/Compose, game, server, MCP, tests and docs), hosting (built Angular files, Node server and ws with its upstream license), and MCP (local adapter, root dependency manifest and lockfile). Drafts are marked and must not be mistaken for approved public releases. `pnpm run release:package` first requires `release:check` to pass. Source archives use an explicit allowlist, never Git history or the entire working directory.

## Before publication

1. Keep site.config.json accurate: monitored email, public URL of the source for the exact hosted version, hosting/STUN/TURN providers, regions and infrastructure log retention. Keep a working private security contact in SECURITY.md. Review the privacy/terms drafts against actual operations with Australian legal advice as needed. The operator is Chandimal Adikari, Australia; no unconfirmed business address/state was invented.
2. Publish the source of each deployed version to the public repository linked from /open-source (`sourceUrl` in site.config.json), keeping notices and dependency licenses. The files that make up that source are listed in `scripts/source-files.mjs`. Run `pnpm run release:check` and rebuild. Confirm public links work. Never make a repository public if its history contains private material; .gitignore does not remove files that are already tracked or in history.
3. Provision one Linux host with Docker Compose and DNS A/AAAA records for beergame.io (and www if used). Only advertise IPv6 if it works. Open TCP 80/443 and optionally UDP 443. Do not expose port 8787 publicly. For a TURN relay, use [Cloudflare TURN](#cloudflare-turn-relay), which needs no ports on this host, or run your own relay with its own network ports and capacity.
4. Copy `.env.example` to `.env`; set DOMAIN, ACME_EMAIL, PUBLIC_ORIGIN and the Cloudflare TURN (or static TURN) values. Keep `.env` private. Run `docker compose config --quiet`, then `docker compose up -d --build`. Caddy obtains HTTPS certificates and forwards HTTP/WebSocket requests. Certificate data persists in named volumes. Caddy access logging is not enabled by this template; check provider/network logs separately.
5. Verify `/healthz`, `/rtc-config`, legal/source pages and a real two-device WebRTC/classroom session, including a network that requires TURN. Health checks only confirm the HTTP process, not peer connectivity. Local Docker daemon was unavailable during preparation; CI contains a Docker build check. Run container build and operational smoke tests before publishing.
6. Keep INDEXABLE=false on previews. After legal/source/provider details and public smoke tests pass, set INDEXABLE=true and restart the app. Submit `/sitemap.xml` to Google Search Console and Bing Webmaster Tools after verifying domain ownership. No ranking or AI-answer inclusion is guaranteed.

## Cloudflare TURN relay

Some school and workplace networks block direct WebRTC connections. beergame.io then relays the encrypted game traffic through Cloudflare Realtime TURN. Players never get relay credentials from `/rtc-config`; the server issues them per player, only when a relay could be needed, and revokes them when it no longer is:

- **Issuing.** A room member receives credentials once they have someone online to connect to: the host once any guest is online, a guest once the host is. A player alone in a room (a host waiting in the lobby, or a guest whose host is offline) gets none. The server asks Cloudflare for credentials lasting `TURN_TTL_SECONDS` and sends them over that player's signaling socket as an `ice` message. It holds that socket's other messages meanwhile (at most 3 seconds), so `ice` arrives before the messages that create peer connections: for a guest before `session`, for a host before the `room` that lists its first online guest. Reconnect and Resume open a new connection and get fresh ones under the same rule. Port-53 URLs are removed because browsers block them. If a peer connection was created without the relay anyway and then fails, the browser restarts ICE with it.
- **Revoking.** The server keeps the username of each connection's credential in memory (never logged or saved) and revokes it through Cloudflare's API:
  - when the player disconnects (the browser closes its peer connections when signaling drops, and Reconnect or Resume gets fresh credentials when needed), leaves, or is removed (including by Start without);
  - when their 24-hour reservation expires (normally already revoked when they disconnected);
  - when the host ends the room;
  - when a resume replaces it, for example another tab taking over the game; the old tab's socket closing afterwards revokes nothing more;
  - after the results are revealed: players' credentials 30 seconds later (at once if they disconnect first), so the final results still arrive over the relay; the host's when the finished room expires (30 minutes) or the host leaves or disconnects, because a player who missed the reveal reconnects to the host to receive it. That player gets new credentials, revoked with the room.

  Each credential is revoked at most once. Revocation is best effort: one attempt with a 3-second timeout, never retried. A failure logs one warning without secrets, the credential expires on its own, and the game is never delayed or affected. A server restart revokes nothing; those credentials expire within the TTL.
- **Limits.** One request per connection and at most 120 a minute for the whole server. A request that fails or takes longer than 3 seconds sends nothing extra: the server logs one warning (never credentials, the token or player details) and the player continues with STUN only, as without a relay. Players over the limit also continue with STUN only.
- **Lifetime.** `TURN_TTL_SECONDS` defaults to 10800 (3 hours), enough for a lesson. A shorter lifetime limits how long a harvested credential works, but a relayed connection can drop soon after its credential expires. A game that runs longer then needs Reconnect, or a refresh and Resume, which fetch fresh credentials.
- **Cost and abuse.** Cloudflare charges about $0.05 per GB relayed, and an allocation can carry 50–100 Mbps to any destination. Anyone who creates or joins a game, once someone else is online, receives credentials and can read them. Revocation ends a harvested credential as soon as its signaling connection closes, so a harvester has to keep a connection open in a room, and the credential then lasts until it expires. Set a budget alert: Cloudflare dashboard → Manage Account → Billing → Billable Usage → Create budget alert, with a USD threshold and email recipients. It only notifies, never caps usage, and can arrive a day late, so also watch the TURN usage in the Realtime dashboard.

Turning the relay off:

1. Empty or remove `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_KEY_API_TOKEN` in `.env` (and in the beergame.io compose file), then restart the app. Players then get STUN only, so those on networks that block direct connections cannot play multiplayer.
2. Credentials already issued would last until they expire. Delete or regenerate the TURN key in the Cloudflare dashboard so they stop working; a new key needs new values in both variables before the relay is turned on again.

Setting it up:

1. In the Cloudflare dashboard, create a Realtime TURN key (TURN app). Put its key ID in `CLOUDFLARE_TURN_KEY_ID` and its API token in `CLOUDFLARE_TURN_KEY_API_TOKEN` in `.env`. The token is a long-term secret: keep it on the server, out of the repository and the image.
2. Leave `STUN_URLS` empty or unset, which gives browsers `stun:stun.cloudflare.com:3478`, or set it to that URL. An older `.env` or compose file that still sets Google's STUN keeps sending browsers there, which the privacy page no longer mentions. Leave `TURN_URLS` empty: the server refuses to start with both Cloudflare and static TURN, or with only one of the two Cloudflare variables.
3. Pass `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_KEY_API_TOKEN` and optionally `TURN_TTL_SECONDS` to the app container. compose.yaml does; the beergame.io nginx compose file needs them in the app service's `environment`, like `PUBLIC_ORIGIN`.
4. Check the key from a checkout of this repository with dependencies installed (Node.js 24): `node --env-file=.env scripts/check-turn.mjs`. It requests one credential that expires after 60 seconds, prints the URLs players would receive and its lifetime (never the credential or the token), then revokes it, which confirms the server can revoke players' credentials. An HTTP error usually means a wrong key ID or token.
5. Restart the app. `/rtc-config` should list only `stun:stun.cloudflare.com:3478`. In a game, `edge://webrtc-internals` or `chrome://webrtc-internals` lists `relay` candidates; on a network that blocks direct connections the selected candidate pair is a relay.

The privacy page and terms (scripts/build-site.mjs) describe Cloudflare STUN and TURN; update them if the relay changes.

## Native hosting package

Extract the hosting archive on a Node.js 24 machine. Set NODE_ENV=production, PUBLIC_ORIGIN=https://beergame.io, HOST=127.0.0.1, PORT=8787 and run `node server/index.mjs` under a service manager. Put a TLS reverse proxy in front, forwarding `/signaling` WebSocket upgrades and `/rtc-config`. The included Caddyfile uses Docker's `app` hostname; change it to `127.0.0.1:8787` for native operation. The bundled ws dependency includes its license; Angular bundles include generated third-party notices. Serve the whole dist folder, including notices.

## nginx instead of Caddy

beergame.io uses nginx and certbot containers in front of the published image. The proxy must:

- Pass all traffic to the app on port 8787 (`proxy_pass http://beergame:8787;`) with HTTP/1.1 and the `Upgrade`/`Connection` headers, so the `/signaling` WebSocket works. A `map $http_upgrade $connection_upgrade` block lets one `location /` serve both pages and WebSockets.
- Redirect `www` and plain HTTP to `https://beergame.io`. The server accepts WebSockets only from the exact `PUBLIC_ORIGIN`, so `https://www.beergame.io` gets 401.
- Renew certificates in a loop (`certbot renew` every 12 hours) and reload nginx periodically (every 6 hours) so renewed certificates are used.
- Use `restart: unless-stopped` on every service, and start nginx after the app (`depends_on`), or nginx fails with "host not found in upstream".

Build and push the image for both server types as described in the README (`docker buildx build --platform linux/amd64,linux/arm64 … --push .`). The beergame.io server is ARM (`linux/arm64`).

To check the WebSocket through the proxy, run the command below. `101 Switching Protocols` means it works, `401` means an Origin mismatch, and `502` means nginx cannot reach the app.

```bash
curl -i -N --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Origin: https://beergame.io" https://beergame.io/signaling
```

### 14-day log retention

The app server logs no visitors; nginx does. The privacy page promises 14 days, but Docker keeps container logs indefinitely by default. To enforce the limit:

1. In both nginx `server` blocks, write logs to files, which replaces the default logging to the container output:

   ```nginx
   access_log /var/log/nginx/beergame/access.log;
   error_log  /var/log/nginx/beergame/error.log warn;
   ```

2. Mount that folder on the host, in the nginx service: `- ./data/logs:/var/log/nginx/beergame`.
3. On the host, add `/etc/logrotate.d/beergame` (adjust the path):

   ```
   /path/to/deploy/data/logs/*.log {
       daily
       rotate 14
       maxage 14
       missingok
       notifempty
       compress
       delaycompress
       copytruncate
   }
   ```

4. Cap the remaining container output (start-up messages, certbot) on every service with `logging: { driver: local, options: { max-size: "10m", max-file: "3" } }`.

## Operation and scaling

Use a single signaling process. Multiple replicas would split the room directory: shared room state and routing are required before horizontal scaling. The 32-person classroom and 1,000 total socket caps are protective limits, not load-test guarantees. Load-test expected rooms/networks before announcing capacity. Six-digit codes, per-socket throttling and Origin checks do not replace network-level abuse prevention. Never trust an arbitrary X-Forwarded-For header for rate limiting.

Restarting the app closes games. Arrange maintenance windows, notify active groups, retain the previous build/image for rollback, and avoid unattended restarts during lessons. Back up Caddy certificates/configuration and deployment configuration securely; game memory cannot be backed up by this release. SIGTERM closes sockets before shutdown.

## MCP

MCP remains local stdio. Extract its archive, install with `pnpm install --frozen-lockfile`, install Chromium with `pnpm exec playwright install chromium` (or choose installed Edge/Chrome), set BEER_GAME_URL=https://beergame.io, and run `node mcp/index.mjs` from an MCP client. No API key, public HTTP endpoint or hosted AI billing has been added. See mcp/README.md.

## SEO and answer engines

Build-time HTML at /about and /how-to-play contains direct answers and visible FAQs; legal and source pages also work without JavaScript. Each page has unique metadata, canonical URLs and WebPage JSON-LD. The game has WebApplication metadata and a non-JavaScript explanation. robots.txt and sitemap.xml include public content; draft legal/source pages carry noindex and are omitted from the sitemap. The HTTP default noindex protects previews. There is no invented review/rating/price markup or promise of FAQ rich results. Update site.config.json origin for forks to avoid canonicalizing another site. Public factual content, not hidden AI instructions, is the AEO approach.

Sources used: [Google AI features](https://developers.google.com/search/docs/appearance/ai-features), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [OAIC privacy policy guide](https://www.oaic.gov.au/privacy/privacy-guidance-for-organisations-and-government-agencies/more-guidance/guide-to-developing-an-app-privacy-policy), [ACCC consumer guarantees](https://www.accc.gov.au/consumers/buying-products-and-services/consumer-rights-and-guarantees).
