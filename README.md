# Neon Wick Socket.IO

## Run locally

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

Open `http://localhost:3000` in two browsers. Create a room, press
the host's start button, then join using that room ID in the other browser.
Both browsers must use the same relay server address.

On another device on the same LAN, use the server computer's LAN IP
instead of localhost, for example `http://192.168.1.100:3000`.
The operating system firewall must allow the port.

## Internet deployment

Deploy this directory to a Node.js hosting service supporting persistent
Socket.IO connections. Install with `npm install`, start with `npm start`.
The server reads the hosting service's `PORT` environment variable.
Use the HTTPS URL supplied by the hosting service. No credentials are
embedded in the game. This task does not automatically publish a server.

You can either open the game on that server, or keep the HTML on GitHub
Pages and enter the deployed HTTPS server URL in the room panel.
The client script is loaded from `/socket.io/socket.io.js` on that server,
not from PeerJS or a separate CDN. The address is remembered locally.

Set `ALLOWED_ORIGINS` to a comma-separated list of allowed frontend origins,
including the server's own origin if it serves the game:

```text
ALLOWED_ORIGINS=https://your-server.example,https://your-name.github.io
```

Without this setting, cross-origin access is permitted for local testing.
Use a single server instance: rooms live in memory and are lost on restart.
Do not deploy this as a short-lived serverless function.

## Room Rules and Movement

The HTML defaults to `https://neon-wick-online.onrender.com`.
When served on localhost, it uses that local server for previews instead.
Deploy BOTH `server.js` (plus `package.json`) to Render and the complete `neon-wick-room36.html`
to every player's frontend. This version changes gameplay message types;
an old relay will reject the new messages. Room registration and joining
keep the same workflow and room codes.
Start with `npm start` or `node server.js`; `server.cjs` is a compatibility
entry point for older Render start commands. No remote deployment is automatic.

Room Settings contains PVP/PVEVP, map, enemy count, health, respawn rules,
respawn count, both damage multipliers, stealth/dash duration, and optional
laser/nailgun/gatling loadouts. Settings are editable before hosting starts.
Joining guests receive the host's authoritative settings and can inspect them.
PVP has no AI. Desert has no AI or bosses in either mode, occupies 3x2
rainforest-sized blocks (1320x680), uses solid cacti and destructible tumbleweed
cover, and includes pistol/rifle/rocket/katana plus checked special guns.

PVEVP bosses keep dropping alternating ability chips. Each player's every
10 AI kills earns a red supply drop reserved for that player; it restores
health and ammunition. Friendly fire includes projectiles, rockets, and melee
where melee is available. Challenge lives are tracked per player.

All player position/input packets include x/y, a life version, and an increasing sequence ID and
are throttled to 60ms. Local movement is predicted immediately, acknowledged
position corrections replay only actual movement since the sample, excluding
previous corrections. Remote players/NPCs interpolate toward received positions.
Server player snapshots are throttled to 60ms and NPC snapshots to 80ms.
Sequence/life/revision checks reject reordered and previous-life state.
Finite bounds, a saved valid position, and camera recovery prevent invalid
packets or broken perimeter walls from losing the local character.
Ping uses server-generated nonces and measured RTT, not trusted client latency.

## Behavior and limits

Gameplay packets are separated into `playerState`, `fireEvent`, `heartbeat`,
`ping`, `hitClaim`, `npcUpdate`, and `killConfirm`.
Shooting immediately creates local projectiles, muzzle effects,
trails, and shake. Fire events carry origin, angle, timestamp, weapon, event
ID, actor ID, round, and spawn version; the relay never simulates projectiles
or sends their positions. All browsers simulate visual projectiles locally.
Blood and a red damage flash are predicted effects only; clients never apply
multiplayer damage, death, or respawn themselves. Snapshots never
replace live projectiles. Duplicate fire events are ignored.

The backend saves two seconds of entity positions, associates each claim
with a previously validated fire event, and rewinds to the shot receipt time
minus half of its server-measured RTT. It ray-tests historical entities and
cover, computes weapon damage, and broadcasts `killConfirm` for accepted
hits (including `killed: false` for a nonlethal hit).
Claims cannot choose damage or arbitrary timestamps. Duplicate hits, stale
rounds/lives, impossible origins, and cross-room claims are rejected.
NPC movement, firing, health, and player respawns now run on the backend.
Host browsers still generate maps, display room settings, and supply scenery
and item updates; this is not a complete anti-cheat/security boundary against
a malicious room host.

Every client sends a heartbeat every 1.5 seconds independently of the render
loop. Remote actors remain visible until more than four seconds without
data, including when omitted from a snapshot. Independent ping messages log
client-server RTT. Browser suspension can still prevent timers from running.
Katana is available in all multiplayer maps with the existing Q binding;
remote sword swings are rendered too.

- No PeerJS, WebRTC, STUN, or TURN is used.
- Socket.IO transports game messages; the server owns combat and NPCs.
- Up to eight players per room. The original single-player mode is retained.
- Guests may join the lobby before the host starts; the start packet supplies
  the new map, loadouts, and final rules to all members.
- Connection and map-handshake timeout is eight seconds after the client
  library has loaded. Library loading has its own eight-second timeout.
- A guest waits until the host has been silent for over four seconds before
  returning to the menu; retry using the same room
  while its host is still online. There is no automatic session recovery.
- Host departure or server restart ends the room. Keep the host tab active:
  browsers can throttle background game simulation.
- No anti-cheat service, accounts, or persistent game storage is included.
- Anyone with the room ID can join; do not treat it as a private authenticated
  service. Public deployment should have origin restrictions and service-level
  abuse controls.

## Test

```sh
npm test
```

Tests cover 12,000 prediction/correction cycles, single-player behavior,
visual-only hit feedback, server health authority, room workflows, lag
compensation, stale/replayed claims, and liveness.
`tests/browser-game.cjs` additionally uses Playwright Chromium (installed
separately) for two browser contexts, actual room UI, Canvas pixels,
and desktop/mobile screenshots. Set `PLAYWRIGHT_MODULE` to the installed
Playwright module if it is not in local `node_modules`.
