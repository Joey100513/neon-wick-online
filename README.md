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
Deploy BOTH `server.cjs` to Render and the complete `neon-wick-room36.html`
to every player's frontend. This version changes gameplay message types;
an old relay will reject the new messages. Room registration and joining
keep the same workflow and room codes.

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

Guest position/input packets include x/y and an increasing sequence ID and
are throttled to 60ms. Local movement is predicted immediately, acknowledged
position corrections preserve movement made since the packet, and remote
actors interpolate toward received positions. Host snapshots are also
throttled to 60ms. Ping RTT through client-relay-host is logged every 2 seconds;
it is not a one-way latency or a server-only ping. The host bounds/checks
movement against collision but this is not a production anti-cheat system.

## Behavior and limits

Gameplay packets are separated into `playerState`, `fireEvent`, and
`heartbeat`. Shooting immediately creates local projectiles, muzzle effects,
trails, and shake. Fire events carry origin, angle, timestamp, weapon, event
ID, actor ID, round, and spawn version; the relay never simulates projectiles
or sends their positions. All browsers simulate projectiles locally, while
the host browser decides damage and sends health/world state. Snapshots never
replace live projectiles. Duplicate fire events are ignored.

Every client sends a heartbeat every 1.5 seconds independently of the render
loop. Remote actors remain visible until more than four seconds without
data, including when omitted from a snapshot. Heartbeat echoes also log
client-relay RTT. Browser suspension can still prevent timers from running.
Katana is available in all multiplayer maps with the existing Q binding;
remote sword swings are rendered too.

- No PeerJS, WebRTC, STUN, or TURN is used.
- Socket.IO forwards game messages; the room host still simulates the game.
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

Tests use real Socket.IO clients and the HTML's connection adapter to exercise
room creation/joining, message relay, failures, isolation, and disconnects.
