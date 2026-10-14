# Deploying beergame.io

This is a single-instance, in-memory hosted game. It is not yet a subscription/account/billing platform. The same MIT-licensed code powers self-hosting and the hosted service.

The beergame.io public beta runs on Oracle Cloud Infrastructure (India South, Hyderabad) behind nginx with certbot, uses Google's public STUN servers and no TURN relay, and keeps web server logs for 14 days. site.config.json and the generated privacy page describe exactly this. If any of it changes, update site.config.json (and the privacy text in scripts/build-site.mjs) before the change goes live.

## Packages

`pnpm run release:draft` builds three versioned archives under ignored `releases/` with SHA-256 checksums: source (Docker/Compose, game, server, MCP, tests and docs), hosting (built Angular files, Node server and ws with its upstream license), and MCP (local adapter, root dependency manifest and lockfile). Drafts are marked and must not be mistaken for approved public releases. `pnpm run release:package` first requires `release:check` to pass. Source archives use an explicit allowlist, never Git history or the entire working directory.

## Before publication

1. Keep site.config.json accurate: monitored email, public URL of the source for the exact hosted version, hosting/STUN/TURN providers, regions and infrastructure log retention. Keep a working private security contact in SECURITY.md. Review the privacy/terms drafts against actual operations with Australian legal advice as needed. The operator is Chandimal Adikari, Australia; no unconfirmed business address/state was invented.
2. Publish the source of each deployed version to the public repository linked from /open-source (`sourceUrl` in site.config.json), keeping notices and dependency licenses. The files that make up that source are listed in `scripts/source-files.mjs`. Run `pnpm run release:check` and rebuild. Confirm public links work. Never make a repository public if its history contains private material; .gitignore does not remove files that are already tracked or in history.
3. Provision one Linux host with Docker Compose and DNS A/AAAA records for beergame.io (and www if used). Only advertise IPv6 if it works. Open TCP 80/443 and optionally UDP 443. Do not expose port 8787 publicly. Set up TURN separately where required; TURN needs its own network ports and capacity.
4. Copy `.env.example` to `.env`; set DOMAIN, ACME_EMAIL, PUBLIC_ORIGIN and TURN values. Keep `.env` private. Run `docker compose config --quiet`, then `docker compose up -d --build`. Caddy obtains HTTPS certificates and forwards HTTP/WebSocket requests. Certificate data persists in named volumes. Caddy access logging is not enabled by this template; check provider/network logs separately.
5. Verify `/healthz`, `/rtc-config`, legal/source pages and a real two-device WebRTC/classroom session, including a network that requires TURN. Health checks only confirm the HTTP process, not peer connectivity. Local Docker daemon was unavailable during preparation; CI contains a Docker build check. Run container build and operational smoke tests before publishing.
6. Keep INDEXABLE=false on previews. After legal/source/provider details and public smoke tests pass, set INDEXABLE=true and restart the app. Submit `/sitemap.xml` to Google Search Console and Bing Webmaster Tools after verifying domain ownership. No ranking or AI-answer inclusion is guaranteed.

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
