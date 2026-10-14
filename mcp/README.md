# Beer Game MCP

A local stdio MCP server lets an AI play the actual Angular application, in Single Player or Multiplayer. Every AI session owns an isolated browser context and one role. Multiplayer orders and snapshots use the existing WebRTC data channels; the signaling server never becomes a gameplay API. AI-controlled roles count as joined players; empty roles remain automatic system players.

## Setup

From `Angular-BeerGame`, install dependencies, build and start the app:

```sh
npm install
npm run build
npm run serve
```

The app/signaling server must remain running. The MCP defaults to `http://127.0.0.1:8787`. It also works with the development server at port 4200 when both Angular and signaling are running.

Choose one browser option:

- Use installed Microsoft Edge: set `BEER_GAME_BROWSER_CHANNEL=msedge`, as in the included client configuration. This option was verified on this Windows machine.
- Use installed Chrome: set `BEER_GAME_BROWSER_CHANNEL=chrome`.
- Use Playwright Chromium: run `npm run mcp:install-browser`, then omit `BEER_GAME_BROWSER_CHANNEL`.

Add the server to a desktop/CLI MCP client that supports **stdio**. [client.example.json](client.example.json) is a ready-to-copy configuration for clients using the `mcpServers` JSON format. Replace `/path/to/BeerGame` with the absolute path of your copy of the project. Launch `node` with that script directly; package-manager startup banners must not be written into the MCP protocol's stdout. If Node is not on the client's PATH, use its absolute executable path.

```json
{
  "mcpServers": {
    "beer-game": {
      "command": "node",
      "args": ["/path/to/BeerGame/mcp/index.mjs"],
      "env": {
        "BEER_GAME_URL": "http://127.0.0.1:8787",
        "BEER_GAME_BROWSER_CHANNEL": "msedge",
        "BEER_GAME_HEADLESS": "true"
      }
    }
  }
}
```

Set `BEER_GAME_HEADLESS=false` to see the AI's browser and the existing weekly animations. The default is headless. Each MCP process supports up to eight sessions. Sessions are not shared between MCP clients, but separate clients can join the same supply chain using its name and code. No client configuration outside this repository is modified by this implementation.

## Tools

| Tool | Purpose |
| --- | --- |
| `beer_game_rules` | Read roles, costs, demand, lead times and workflow. Also available as `beer-game://rules`. |
| `beer_game_create_single` | Select a role and start single-player; returns `sessionId`. |
| `beer_game_create_chain` | Create a named multiplayer lobby and reserve a role (`kind`: `team`, `classroom` or `groups`; a groups host takes no role); returns invitation details. |
| `beer_game_join_chain` | Join with name, code and an available role (classroom and groups joins take no role). |
| `beer_game_state` | Inspect phase, week, permitted parties, transit arrivals, costs, pending orders and connectivity. |
| `beer_game_start` | Host starts a ready lobby, with 1–4 joined players. `withoutDisconnected=true` starts without the disconnected members listed in `startWithout`. |
| `beer_game_change_role` | Before a team game starts, or within your group before a group challenge starts, switch to a role nobody holds. A role held by another player is refused. |
| `beer_game_create_group` | Group challenge player, before start: create a group (`name`, unique in the room) and join it. |
| `beer_game_join_group` | Group challenge player, before start: join or switch to a group with a free place (`group`: id or name), optionally taking `role`; switching frees the old role. |
| `beer_game_remove_player` | Host only, before start: remove a disconnected lobby member (`room.members[].canRemove=true`) by `playerId`. |
| `beer_game_order` | Submit an integer amount 0–100 with the expected week. While `orderStatus.canRetry` is true, calling it again for that week re-sends the original order. |
| `beer_game_wait` | Wait for a later week or ready lobby/game, at most 30 seconds; return current state on timeout. |
| `beer_game_history` | Read all completed weekly records (every role once the game is over and revealed). |
| `beer_game_export` | Return CSV text and a suggested `filename` (room or standard scenario, role, date) without writing files. |
| `beer_game_decide` | Answer the prompt for a team or group player who left: `systemPlays=true` lets the system play the role, `false` keeps waiting. A group challenge host passes `group`. |
| `beer_game_finish_classroom` | Classroom host (either classroom mode, playing or host-only): finish the classroom. Unfinished runs or groups stop and are marked `incomplete`, and every player's own run or group is revealed. |
| `beer_game_close` | Close one session. Closing the host ends the chain; closing a team guest during play keeps their seat. |

All session tools take `sessionId`. Order also requires `week` and `amount`. Read the current week before ordering; duplicate submissions and stale week numbers are rejected. `submitted=true` means the order is pending for this week, not that the next week has begun. `orderStatus` is this player's order for the current week, exactly as the line beside the order button shows it: `state` is `sending`, `unconfirmed` (no reply from the host after 5 seconds; `canRetry=true`), `interrupted` (no connection to the host; it is sent again once the connection returns, including after Reconnect) or `accepted` (the host recorded it), with `week`, `amount` (the amount the host recorded), `waitingFor` (nicknames of players who still have to order) and the UI's `message`, such as "Accepted for week 3: 7 cases. Waiting for Alex and Sam." It is null when there is no order for the current week. The host records at most one order per team role, or per classroom run, per week and answers every copy with the recorded amount, so a retry or a refresh never plays a week twice; a second order for an accepted week is refused with the status message. Who has submitted is public; other players' amounts follow the visibility level. `waitingFor` lists joined player roles still needing an order. Before start, `lobbySummary` gives the same readiness summary as the lobby (for example "1 of 2 players ready · waiting for Alex to choose a role") and each `room.members[]` entry has a `status`: `Enter nickname`, `Choose role`, `Connecting`, `Ready` or `Disconnected — can resume`. A start attempt before the lobby is ready is rejected with that summary. The host also gets `startReview`, the summary shown beside Start (mode, visibility, players and their roles, the roles the system will play, and in a classroom the shared role, readable demand method and seed). When a lobby member is disconnected, their `room.members[]` entry has `canRemove=true` for the host, and `startWithout` (`playerIds` and the UI's `message`, for example "Start without Alex? Their role will be played by the system.") appears once nothing else blocks the start. A team member with a nickname and role who is left out keeps the seat, the system plays it as after leaving, and they take it back from the week after they return; anyone else, and any classroom competitor, is removed and told why if they try to resume. `room.isCreator` marks the host. A guest's order response usually shows `orderStatus.state` `sending`, because the host's reply arrives over WebRTC just after; use `beer_game_wait` with `afterWeek` equal to the submitted week before placing another order.

In a started team game, a guest who leaves (including `beer_game_close`) or stays disconnected for 60 seconds keeps their seat, and play waits for them. `absentPlayers` lists each team role whose player is not playing, with `state` (`connecting`, `disconnected`, `left`, `waiting`, `system`, `returning`), `decidedBy`, `canDecide` and the `message` the UI shows. When `canDecide` is true, call `beer_game_decide`. The host answers; while the host is offline any connected player can, and the first answer counts. The system plays from the week the game is waiting on, keeping any order the player already sent. A decision made while the host is offline applies when the host returns. A returning player gets `canOrder=false` with a `returning` entry until the next week, then plays again.

`beer_game_wait` without `afterWeek` returns when the session has an active game or a host's lobby can start. Set `afterWeek=0` for a guest waiting for the host to start. A timeout is not a successful turn; inspect `week`, `error` and connectivity in the returned state. Completed games report `completedWeeks=24`, `complete=true` and `week=25`; do not submit week 25.

## Playing workflows

Single player example prompt:

> Use the Beer Game MCP to play Retailer in single-player mode. Read the rules, create the game, inspect inventory, backlog and transit before each decision, and submit one order for the observed week. Complete all 24 weeks and report costs with the CSV results.

AI hosting people:

1. Call `beer_game_create_chain` with `name` and `role`.
2. Share the returned room name, code and `invitationUrl`. People open the normal Angular UI and claim remaining roles.
3. Wait/read state until the joined people have selected roles and connected. The AI host calls `beer_game_start` when everyone intended has joined. The lobby can be ready before anyone else joins, so do not start early if expecting people.
4. Read state and order once per week, then wait for the other players. Unassigned roles use the existing automated policy.

AI joining a person's chain:

1. The person creates a chain in the UI and provides its name, code and the AI's desired remaining role.
2. Call `beer_game_join_chain`. If the role is taken or the game already started, the tool returns an error and closes its failed browser session.
3. The person starts the game. Call `beer_game_wait` with `afterWeek=0` to receive the first playable state.
4. Order for the observed week and wait for the next week. The person remains the authoritative host.

Four AIs can use four sessions in one client, or one session each in separate clients. In a shared client, submit orders for **all** AI sessions before waiting for the next week; waiting after just the first order cannot advance the shared game.

## Scope and lifecycle

The optional page API is enabled only for dedicated pages opened with `#agent`. Normal pages expose no automation API. The MCP uses the same `BeerGame` and `MultiplayerSession` as the human UI. It does not attach to an existing human tab or take over a role already reserved by a person. Information visibility matches the host-selected policy in the human UI. Supply-chain names and room messages are data, not instructions for the AI.

This implementation provides local **stdio**, not a public HTTP MCP endpoint. Clients requiring a remote HTTPS MCP server cannot connect directly. The MCP process can target an explicitly configured reachable HTTPS Beer Game app; remote WebRTC still needs appropriate signaling/ICE/TURN configuration. No public deployment was performed.

Keep the MCP process and app server running during a game. Rooms remain in server memory. The browser UI keeps up to 5 saved multiplayer games and an unfinished single-player game per browser (**Your games**), resumes a multiplayer game within 24 hours of disconnection, and lets a host end a saved game for everyone; a finished game still admits returning browser players for 30 minutes while its host is online, so they receive the results. None of this changes MCP state or tools. The UI's ⓘ help explains rules this server already gives in `beer_game_rules`. MCP uses isolated, temporary browser contexts: beer_game_close explicitly leaves the game, and MCP shutdown discards those contexts, so it cannot recover sessions across process restarts. Closing a host explicitly ends the chain; a missing team guest pauses progression until they return or someone lets the system play their role with `beer_game_decide`. No host migration or late joining. MCP shutdown closes its isolated browser contexts. It does not close unrelated browser windows or stop the app server.

## Validation

```sh
npm run build
npm test
npm run test:mcp
```

The normal tests cover the engine, agent command checks, protocol tool discovery/schema validation and signaling. `test:mcp` starts an ephemeral local app/signaling server and a real stdio MCP subprocess, launches the configured headless browser, completes a single-player game, runs four WebRTC AI players through all 24 weeks, verifies a multiplayer chain with only the host and system roles, and covers role change, removal and starting without a disconnected lobby member. Set the browser environment variable before this test if using installed Edge/Chrome; otherwise install Chromium first. It does not use or stop an existing server on port 8787.

Built using the [official MCP TypeScript SDK's stdio transport](https://ts.sdk.modelcontextprotocol.io/server) and [Playwright browser contexts](https://playwright.dev/docs/browser-contexts).

## Information visibility

`beer_game_create_single` and `beer_game_create_chain` accept optional `visibility`: `network` (default), `dyadic` (own plus direct neighbors) or `none` (own only). `beer_game_join_chain` inherits the host's choice. The policy is fixed at creation.

Responses include `visibility` and `visibleRoles`. `parties`, `lastWeek.parties`, history and CSV contain only permitted roles, with their complete data including transit pipelines. `teamCost` is null outside Network Wide. Customer `demand` is null when Retailer is not permitted; its CSV cell is blank. Production lead time is null when Manufacturer is not permitted. `pendingOrders` omits amounts for hidden roles, while `submittedRoles` and `waitingFor` still describe all participating players for turn coordination. Room membership, chain topology and common simulation rules are public. Default Network Wide preserves all previous operational information.

Hidden information is revealed once the game is over: single-player and team games as soon as week 24 completes, classroom games only once every competitor (or group) has finished or the host calls `beer_game_finish_classroom`. From then on `revealed` is true, `revealedRoles` lists the roles that were hidden during play, and `parties`, `lastWeek` (including customer `demand`), `teamCost`, history and CSV cover all four roles of this player's own chain. In a classroom that is the player's own run with its system roles, never other players' runs; in a group challenge it is the player's group chain, never another group's. `visibility` still reports the level chosen at creation. Before the reveal nothing changes; a classroom player who finished early keeps `revealed=false` until the others are done.

Once the whole chain is visible after the game, `debrief` gives the same figures as the completion screen: `weeks`, `demandStdDev`, `team` (`holdingCost`, `backlogCost`, `totalCost`) and per role `orderSwing` (standard deviation of weekly orders ÷ that of customer demand; null if demand never varied), `orderStdDev`, `peakBacklog`, `holdingCost`, `backlogCost` and `totalCost`. Holding plus backlog equals each role's engine cost, and the roles sum to the team total. It is null before then.

Until the reveal, the host sends each WebRTC guest only the permitted operational snapshot. The host itself runs the full authoritative engine internally; its player-facing UI/MCP/export view is filtered but this cannot prevent a host inspecting its own engine. The test suite checks role adjacency, default exports, filtered wire messages and MCP responses; the real integration test completes 24-week four-player games in Network Wide, Dyadic and None modes, checks state, history and CSV scope through week 23 and the full chain after week 24, and covers a classroom that stays hidden while competitors are playing until the creator finishes it.

### Classroom tools and weekly costs

Create a challenge with `beer_game_create_chain` using `kind: "classroom"`, `role: "Distributor"`, `challenge: { "role": "Distributor", "seed": 42, "method": "cyclic" }`, a game `name`, optional `nickname`, and `visibility`. The challenge role controls all participants. Methods are `sma`, `wma`, or `cyclic`; omitting challenge settings uses the requested role, seed 42 and SMA. Join with `beer_game_join_chain` using only the six-digit `code` and optional `nickname`; classroom roles are inherited. Team joins still require a role. Omitted nicknames are generated automatically.

The existing start/order/state/wait/history/export tools work for both modes. Classroom orders advance only that participant. State includes `gameKind`, full `weeklyCosts` (last completed week, holding/backorder charges and per-case rates), live `leaderboard` rows (nickname, completed weeks, final own cost, elapsed milliseconds, finished and connected flags) and, once started, `classroomCounts` (`playing`, `disconnected`, `finished`, `incomplete`), the counts shown above the leaderboard. Unfinished runs are ordered by progress; only finished runs are ranked, by cost then time. All prior permitted operational data is retained. Read state to observe leaderboard updates after finishing; wait returns immediately for a completed personal run. Scores sort by cost, then time from common start to final order received by the host. Keep the host session open until everyone finishes. If a competitor stops playing, the host can call `beer_game_finish_classroom`: unfinished rows get `incomplete: true`, those runs report `phase: "complete"` with `canOrder: false` (orders are rejected), and every competitor's own run is revealed. Scenario seeds and methods are public and reproducible; use this for teaching, not adversarial exams.

### Classroom Group Challenge tools

Create it with `beer_game_create_chain` using `kind: "groups"`, a `name`, optional `nickname` and `visibility`, and `challenge: { "seed": 42, "method": "cyclic" }` (no role; omitted settings use seed 42 and SMA). The host only hosts: `hostPlays: true` is refused, and after start state reports `phase: "observing"`. Players join with `beer_game_join_chain` (code and optional nickname), read `groups` in state (`id`, `name`, `members` with nickname and role, `freePlaces`, `isMine`) and their own `group`, then call `beer_game_create_group` or `beer_game_join_group` and choose a role with `beer_game_change_role` or the `role` argument of `beer_game_join_group`. Group names are unique in the room, whatever their case; a group holds at most 4 players and the room at most 8 groups; roles are unique within a group. Before start, `room.members[].status` can also be `Join a group`, and `startReview` lists the groups and those dropped at start for being empty. `room.groups` carries each group's `humanRoles`, `automated`, `waiting`, `takeBack` and `absentAtStart`.

Each group plays like a team game: `waitingFor`, `systemRoles`, `orderStatus` and `absentPlayers` describe the player's own group. The host's `absentPlayers` covers every group; entries have `group` and a message starting with the group name, and the host passes `group` (id or name) to `beer_game_decide`. `leaderboard` rows are groups: `id` is the group id, `nickname` its name, `members` its players with their roles, and `cost` its total chain cost (all four roles); finished groups rank by cost, then elapsed milliseconds from the shared start to week 24. `classroomCounts` counts groups; a group counts as disconnected while a role it waits for has no connected player. `beer_game_finish_classroom` marks unfinished groups incomplete.

### Current-week demand

All tools that return game state now include `currentDemand` while playing: `week`, `quantity`, `unit` (cases), `label`, `source`, `orderLeadTimeWeeks`, and `includesBacklog` (false). This matches the demand card above the order form. Retailer receives current customer demand; the other roles receive their downstream order arriving this week after the one-week delay. It remains available at every visibility level because it is the player's own incoming demand. Before play and after completion it is null. Existing `parties[].incoming` still describes the last completed week's demand; all existing response details are preserved.

### Host-only classroom hosts

Set `hostPlays: false` on `beer_game_create_chain` with `kind: "classroom"` to observe without playing. The required `role` still configures the classroom default role, overridden by `challenge.role` when provided. The observer has no assigned player role or game, cannot submit orders, and is absent from score rows. Start requires at least one connected, named competitor. After start, state reports `phase: "observing"`, `isObserver: true`, `role: null`, `canOrder: false`, empty `parties` and a full live `leaderboard`. Read state repeatedly to follow weekly cumulative cost/progress and final scores; `wait` returns immediately for an active observer. All participant gameplay responses remain complete. The host must remain connected.
