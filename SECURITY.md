# Security

Do not post live room codes, personal data or exploit details in public issues. Report security problems privately to skillidaus@gmail.com with steps to reproduce. This contact is also used in site.config.json.

Rooms are invite-code based, not authenticated accounts. Creators are trusted authorities, and visibility is a learning mechanic rather than protection against a malicious creator. Codes are not appropriate for confidential sessions. The host must remain connected; state is not persistent. The server limits message size/rate and total connections, but these are not DDoS protection. Apply infrastructure rate limits and monitoring before a broadly advertised service.

Production checks browser Origin against PUBLIC_ORIGIN. WebRTC requires HTTPS. The hosted beergame.io beta uses no TURN relay, so players on networks that block direct connections cannot join multiplayer games there. Self-hosted deployments that add a TURN relay should know that credentials returned to browsers are not secret from users; use short-lived/scoped credentials and rotate them. Do not expose the local stdio MCP server as a public service. Restrict .env, private keys and Docker access. Review dependencies and image updates for each release.
