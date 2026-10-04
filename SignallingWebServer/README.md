# Wilbur

A Direct replacement for cirrus.

Wilbur is a small intermediary application that sits between streamers and other peers. It handles the initial connection negotiations and some other small ongoing control messages between peers as well as acting as a simple web server for serving the [Frontend](/Frontend/README.md) web application. What it serves is a stream grid: `grid.html` is the homepage, `wall.html` is the multiviewer, and `player.html` is a single feed.

Differences of behaviour from the old cirrus are described [here](from_cirrus.md).

## Building
Building is handled by `npm` and `tsc`. However, the easiest method to install and build everything is to invoke:

```
.\SignallingWebServer\platform_scripts\cmd\start.bat --dev
```

This will install and build all the required components.

## Building manually

However, if you would like to manually build them yourself (or build other configs), you will need to:

```bash
npm install
npm run build
# Or npm run build-dev
```

In the `/common`, `/Signalling`, and `/SignallingWebServer` directories (in that order).

Each of these will output built files into the `build` or `dist` directory.

## Running
After you have build the server you can run it with both `node` directly or the `npm start` script.
```
npm start -- [arguments]
```
or
```
node dist/index.js [arguments]
```
Invoking `npm start -- --help` or `node dist/index.js --help` will display the configuration options.
```
Usage: node dist/index.js [options]

A basic signalling server application for Unreal Engine's Pixel Streaming applications.

Options:
  -V, --version                 output the version number
  --log_folder <path>           Sets the path for the log files. (default: "logs")
  --log_level_console <level>   Sets the logging level for console messages. (choices: "debug", "info", "warning", "error", default: "info")
  --log_level_file <level>      Sets the logging level for log files. (choices: "debug", "info", "warning", "error", default: "info")
  --console_messages [detail]   Displays incoming and outgoing signalling messages on the console. (choices: "basic", "verbose", "formatted", preset: "verbose")
  --streamer_port <port>        Sets the listening port for streamer connections. (default: "8888")
  --player_port <port>          Sets the listening port for player connections. (default: "80")
  --sfu_port <port>             Sets the listening port for SFU connections. (default: "8889")
  --max_players <number>        Sets the maximum number of subscribers per streamer. 0 = unlimited (default: "0")
  --hide_non_sfu_streamers      Hides non-SFU streamers from players. Players can only see and subscribe to SFUs. (default: false)
  --serve                       Enables the webserver on player_port. (default: true)
  --http_root <path>            Sets the path for the webserver root. (default: "D:\\PixelStreamingInfrastructure\\SignallingWebServer\\www")
  --homepage <filename>         The default html file to serve on the web server. (default: "grid.html")
  --snapshot_proxy              Proxies /snapshots on the webserver through to the SFU snapshot API, so stream previews are served from the same origin as the rest of the frontend. (default: false)
  --snapshot_proxy_host <host>  The host of the SFU snapshot API to proxy to. (default: "127.0.0.1")
  --snapshot_proxy_port <port>  The port of the SFU snapshot API to proxy to. (default: "8891")
  --no_auth                     Disables the sign-in requirement. Anyone can view the grid, the player and the player websocket. (default: false)
  --auth_store <path>           Sets the path of the auth data file (users, invites, sessions). (default: "SignallingWebServer/data/auth.json")
  --session_days <days>         Sets how long a sign-in lasts before it has to be repeated. (default: "30")
  --invite_days <days>          Sets the default lifetime of an invite link generated from the admin page. (default: "7")
  --auth_app_name <name>        Sets the site name shown on the sign-in, invite and admin pages. (default: "Live streams")
  --auth_base_url <url>         Sets the public base URL used to build invite links, e.g. https://streams.example.com. (default: "")
  --https                       Enables the webserver on https_port and enabling SSL (default: false)
  --https_port <port>           Sets the listen port for the https server. (default: 443)
  --ssl_key_path <path>         Sets the path for the SSL key file. (default: "certificates/client-key.pem")
  --ssl_cert_path <path>        Sets the path for the SSL certificate file. (default: "certificates/client-cert.pem")
  --https_redirect              Enables the redirection of connection attempts on http to https. If this is not set the webserver will only listen on https_port. Player websockets will still listen on player_port. (default: true)
  --rest_api                    Enables the rest API interface that can be accessed at <server_url>/api/api-definition (default: false)
  --peer_options <json-string>  Additional JSON data to send in peerConnectionOptions of the config message. (default: "")
  --log_config                  Will print the program configuration on startup. (default: true)
  --stdin                       Allows stdin input while running. (default: false)
  --save                        After arguments are parsed the config.json is saved with whatever arguments were specified at launch. (default: false)
  -h, --help                    Display this help text.
```
These CLI options can also be described in a `config.json` (default config file overridable with --config_file) by specifying the command option name and value in a simple JSON object. eg.
```
{
	"log_folder": "logs",
	"log_level_console": "info",
	"log_level_file": "info",
	"streamer_port": "8888",
	"player_port": "80",
	"sfu_port": "8889",
	"hide_non_sfu_streamers": false,
	"serve": true,
	"http_root": "www",
	"homepage": "grid.html",
	"snapshot_proxy": true,
	"snapshot_proxy_host": "127.0.0.1",
	"snapshot_proxy_port": "8891",
	"auth_store": "data/auth.json",
	"session_days": "30",
	"invite_days": "7",
	"auth_app_name": "Live streams",
	"auth_base_url": "",
	"log_config": false,
	"stdin": false
}
```
Given these options, to start the server with the closest behaviour as the old cirrus, you would invoke,
```
npm start -- --console_messages --https_redirect verbose --serve --log_config --http_root www --homepage player.html
```
Note that `www` being used as the http root assumes your Frontend is in that directory.

## Snapshot proxy

The SFU can decode a JPEG preview out of each hosted stream ([details](../SFU/README.md#stream-snapshots)), which the bundled stream grid uses as the thumbnail on every tile. Those frames are served by the SFU on its own port, and cannot be written into `http_root` because rebuilding the frontend wipes that directory.

With `snapshot_proxy` enabled, requests for `/snapshots` and `/snapshots/*` on the player port are forwarded to the SFU snapshot API and the response is passed back verbatim, so the frontend can fetch previews from its own origin with no CORS setup and no second port to expose:

```
GET /snapshots                      ->  {"snapshots":[{"sfuId":"SFU-MyApp","state":"running","hasImage":true}]}
GET /snapshots/SFU-MyApp.jpg       ->  the latest frame, or 404 if there is not one yet
```

Set `snapshot_proxy_host`/`snapshot_proxy_port` to wherever the SFU snapshot API is listening. If it is unreachable the proxy answers 502 and logs `Snapshot proxy unavailable`, rather than breaking the rest of the server. The route only exists when the option is on, so leaving it off costs nothing.

## Sign-in and accounts

**On by default.** Wilbur will not serve the grid, the player page or open a player websocket to somebody who is not signed in. The whole system is built into the signalling server — no external service, no database engine and no native modules — and it stores its state in one JSON file.

There are three ways into a running deployment, and all three matter:

| Way in | Protected by |
| --- | --- |
| Web pages on `player_port` (`/`, `/grid.html`, `/player.html`, scripts and images) | the express gate below |
| The player websocket on `player_port` | `verifyClient` on the ws handshake, since ws upgrades never pass through express |
| The streamer port (`--streamer_port`, 8888 by default) | **nothing** — see [the known risk](#the-streamer-port-is-still-open) |

### Creating the first account

There are no accounts until one is made from the command line, so do this before exposing the server:

```
node dist/auth/cli.js create-admin alice
```

That prints a generated password once, or you can pass `--password "<password>"`. Running the server with no accounts logs the same hint at startup. After that, every further account is created from the admin page, and the CLI is only needed for recovery.

### The command line

Every command takes `--store <file>` (defaults to the same file the server uses, so the two never disagree) and `--base <url>` (used to print absolute invite links).

```
create-admin <username>          Create or re-arm an admin account
create-user <username>           Create or re-arm an ordinary account
set-password <username>          Set a password directly
invite <username>                Issue an invite link without touching the web UI
reset-link <username>            Issue a single-use password reset link
list-users                       Show accounts, roles and status
disable-user <username>          Refuse sign-ins and end existing sessions
enable-user <username>           Undo the above
revoke-sessions <username>       End every session for an account
delete-user <username>           Remove the account, its sessions and its invites
```

Accounts are edited in memory by the running server, so the CLI is for building accounts before the first boot, or for recovery while the server is stopped. On a running server use the admin page instead of the CLI.

### The admin page

`/admin` is not linked from anywhere. It answers 404 unless the signed-in account is an admin, so an ordinary member has no way to know it exists. From it you can:

* issue an invite, choosing the username, a label, the role and how long the link lasts, and see the link it produced;
* see the roster with each account's role, whether it can sign in, and when it last did, and revoke sessions, disable, re-enable, reset the password of, or delete any of them;
* see and revoke pending invites, including the links that are still outstanding.

An invite **creates the account immediately, without a password**, and the link sets the first password. Redeeming also signs the new member in. Only one invite can be outstanding per account: issuing another one revokes the previous link. A used or revoked link is refused, and the code itself is dropped from the file as soon as it is spent, so only its hash remains for the audit trail.

Every form on the page carries a CSRF token tied to the session. A POST without a valid token is rejected with `Form expired`.

### Sessions

Signing in returns an opaque token in the `ps_session` cookie (`HttpOnly`, `SameSite=Lax`, and `Secure` when the request arrived over https or with `X-Forwarded-Proto: https`). Only the SHA-256 of that token is written to disk, so the file cannot be replayed as a sign-in. Validity is decided on every request, which is why signing out, disabling an account, revoking sessions and deleting an account all take effect immediately — including for websockets.

Sessions last `--session_days` (30 by default) and are refreshed on use. Failed sign-ins are limited to 30 per address and 6 per address+account per 15 minutes; invite redemption to 20 per hour and admin actions to 200 per hour. A rate-limited reply carries `Retry-After` and the page says how long to wait.

**Set `--reverse-proxy`** whenever Wilbur sits behind one, or every request looks like it came from the proxy and the per-address limits collapse into a single shared budget. The server warns at startup if sign-in is on without it.

### Where the data lives

`data/auth.json` (override with `--auth_store`), next to `SignallingWebServer` and outside both `dist/` and `http_root`, written 0600 via a temp file and a rename. `data/` is ignored by git. Back it up and do not serve it: the server warns if the store is placed inside the web root.

### The streamer port is still open

`--streamer_port` (8888) is unauthenticated. Anybody who can reach it can publish a stream, or with a crafted message interfere with the server's notion of what is streaming. Sign-in closes the viewer side only. Until that port is gated, firewall it so only the streaming machines can reach it — the port has no business being reachable from the internet.

### Turning it off

`--no_auth` removes the gate entirely: no sign-in page, no sessions, everyone sees everything. It exists for local development and for a deployment that is protected some other way (an allow-list in front of the server, for example).

## Installing and deploying

`setup.bat` in the repository root is the whole install and update path on Windows. On a fresh clone it downloads the bundled Node runtime, installs the workspace dependencies, builds the signalling server, the web pages and the account tools, prepares the SFU, fetches the ffmpeg build that produces the stream previews and CoTURN for viewers behind a strict NAT, and creates the first admin account:

```
setup.bat                 prompts for the admin username
setup.bat --admin alice   creates that admin without prompting
setup.bat --no-admin      touches no accounts
setup.bat --skip-build    installs dependencies only
```

The build scripts skip `npm run build` in `SignallingWebServer` when `dist/` already exists, so `git pull` on a deployment can leave old compiled code in place and quietly serve the previous version. `setup.bat` always rebuilds, which is why it is also the update path:

```
git pull
setup.bat --no-admin
```

The same steps by hand are `npm install` and then `npm run build:all:cjs` from the repository root, but the start scripts' own setup skips a rebuild whenever `dist/` exists, so the compiled server and the pages must be rebuilt deliberately.

`www/` is generated by the same command, so the frontend is rebuilt along with the server. Restarting Wilbur is safe: it saves the auth file before exiting, so a freshly redeemed invite or a just-issued session is not lost.

The launcher keeps the sign-in settings in one command line:

```
start_with_turn.bat --player_port 8080 --reverse_proxy
```

`--reverse_proxy` is what tells the server that a proxy such as Caddy is in front of it, so the real client address reaches the sign-in limits and the session cookie is marked `Secure`; `"reverse_proxy": true` in `config.json` does the same thing. Sign-in is on by default, so create the first admin (`node dist/auth/cli.js create-admin alice`, or `setup.bat --admin alice`) before restarting, otherwise nobody can get in.

The streamer port, 8888 by default, is not behind the sign-in at all. Anyone who can reach it can publish a stream, so limit it to where streaming happens:

```
netsh advfirewall firewall add rule name="PixelStreaming streamer" dir=in action=allow protocol=TCP localport=8888 remoteip=1.2.3.4
```


## Stream grid status

A tile reports the stream and nothing about the snapshot pipeline:

* The **badge** is a tally of the stream, and nothing else. It reads `Live` whenever the signalling server names the stream in its streamer list, which is polled every five seconds. It reads `Unknown` only while that list cannot be refreshed, i.e. from the moment the web socket closes until it is reconnected, because then no tile can honestly claim to be live. A preview failing says nothing about the stream, so a failed snapshot never moves this badge.
* The **frame** carries the two figures worth reading at a glance: how long the stream has been up, in the top right corner, and how many viewers are on it, in the bottom right. The thumbnail's colour bar doubles as a "signal present" cue: it is drawn at full strength once a frame has loaded and dimmed while one is still awaited.
* **Preview health is not reported.** A snapshot is a convenience, and when one is missing, queued behind the snapshot workers, or older than the refresh interval, the frame itself says so — it shows the last frame it had, or the placeholder. The tile needs no "last updated" line for that: an operator watching a wall of tiles reads the picture, not the timestamp, and a tile with nothing to show is obvious as soon as it is looked at.

## Stream grid backdrop

The stream grid (`grid.html`) draws a decorative animated backdrop behind the tiles. Because browsers composite that alongside every other window, it is deliberately restricted to compositor-only work: the drifting orbs animate `transform` only, and the softness of the preview montage is baked into the 128x72 canvas at capture time rather than applied as a CSS `filter` over a full-viewport layer.

The montage is a single `<canvas>` at a constant opacity, and it cross-fades between frames *inside* the canvas rather than by animating the opacity of two stacked elements. That keeps the compositor from having to upscale and blend two full viewports on every frame of a fade, and from promoting and un-promoting a layer around each one.

It also disables itself when the machine cannot afford it:

* `html.calm` is applied when the measured frame rate drops below 48 fps, or at load time when WebGL reports a software renderer. The orbs and the montage are then removed and replaced with a static gradient.
* `html.nowash` is applied first, while the page is still settling, when the frame rate drops below 58 fps. Only the montage goes away; the orbs stay. Fading the montage is the cheaper concession, so it is tried before giving up on the backdrop entirely.
* `grid.html?fx=off` forces calm mode, `grid.html?fx=nowash` keeps the orbs but never shows the montage, and `grid.html?fx=on` keeps the backdrop on regardless of the measurements.
* The topbar's **Backdrop** button cycles Auto / On / No montage / Off at runtime. The choice is stored in `localStorage` under `ps-grid-fx`, and an explicit `?fx=` in the URL overrides it for that page load.

### Grid operators' controls

The grid carries a few controls for someone who watches the same feeds all day rather than browsing them:

* **Pin** holds a feed at the top of the grid. The pin leads every sort, so it outranks the sort key itself, and the set is remembered under `ps-grid-pins` — the arrangement survives a reload without surprising a different browser profile.
* **Sort** by name, by liveness (`Live`, then `Idle`, then `Unknown`) or by viewer count, stored under `ps-grid-sort`.
* **Drop and return alerts.** A feed that stops, or comes back, puts a line in the alert rail below the grid and can also raise a desktop notification (`ps-grid-alert-notify`) and a short tone (`ps-grid-alert-sound`). The alerts are deliberately damped: nothing is reported for the first eight seconds after the page loads, a feed has to hold its new state for fifteen seconds before it is announced, and each feed is announced at most once every forty-five seconds, so a flapping streamer cannot turn the rail into noise. Notifications need a secure origin, so on plain HTTP the button says why it is unavailable and only the rail is used.
* **Previews load only for tiles that are on screen.** Every tile is observed with an `IntersectionObserver`, so a tile scrolled out of view fetches nothing. An image that fails keeps the frame it already had and retries shortly afterwards, because a preview caught mid-write is not a stream that has gone away.

## Multiviewer wall

`wall.html` is the same stream list rendered as a wall of *live* players instead of previews: every cell is a bare-mode `player.html` in an iframe (`AutoConnect`, `AutoPlayVideo`, `StartVideoMuted`, `Chrome=0`), so each one is a real WebRTC subscription to the SFU that keeps playing on its own.

* Layouts are `Auto` (the smallest square that holds every feed), 1-up, 2x2, 3x3 and 4x4, from the buttons in the bar or the `0`-`4` keys, and the choice is stored in `localStorage`. A fixed layout is a ceiling on what is watched: feeds beyond it are never subscribed, so a 2x2 wall on a six-feed server opens four players, not six.
* The index chip on a tile is its position in the whole list (`3/6`) rather than in the visible window, so the wall and the grid agree about which feed is which.
* **Fullscreen** asks the wall itself to go fullscreen (`f`), so the display fills with the wall rather than one cell.
* **Sound** unmutes every tile by reloading it with `StartVideoMuted=false`, which is the only reliable way to change a muted autoplaying player. Tiles start muted because a browser will not begin audible playback on a page of many videos without a gesture.
* The bar is the grid's bar: same back link, same feed count, same running clock, same auto-hide.

## Player page

Opening `player.html` with a `StreamerId` starts that stream straight away: the page sets `AutoConnect` and `AutoPlayVideo` as its own defaults, so arriving from a grid tile plays the feed with no extra click. Both remain ordinary URL settings, so `player.html?StreamerId=SFU-Feed&AutoConnect=false` still gives you the manual flow.

While the player is connecting it covers the stage with its own loader rather than the library's static text, and each stage has a different animation so the state is readable at a glance:

| Stage | Indicator | Steps reached | Colour |
| --- | --- | --- | --- |
| Booting the client | three bouncing dots | — | grey |
| Connecting to the signalling server | rotating orbit | Signalling | cyan |
| Negotiating WebRTC | two counter-rotating rings | WebRTC | yellow |
| Connected, no frames yet | expanding ripples | Video | magenta |
| Receiving and warming up playback | sweeping progress bar | Video | lifted blue |
| Live | tick that draws itself, then the loader fades out | Live | green |

The colours are the bar palette described under [Colour-bar theming](#colour-bar-theming); the step rail along the bottom of the loader walks the same ramp, so the two cues agree.

Terminal states are deliberately *not* covered by this loader: when the connection fails or the library wants a click to play, the loader steps aside and hands over to the library's own overlay, because that overlay carries the action that recovers the stream. A feed that simply does not exist is the exception, and is handled below.

Audio is the other thing the library leaves to the host page. Browsers refuse to start audible playback without a gesture, so the page starts muted when it is blocked and shows a speaker button in the top bar to unmute. A stream that is still connecting after 15 seconds gets a line saying so and a **Reconnect** button.

### A feed that is not there

If the page is opened for a `StreamerId` the signalling server does not have, the loader stays up and names it: *"SFU-Feed" is not on air right now. It will play here as soon as the streamer publishes it.* It then keeps asking, on a growing interval (3 s, 5 s, 10 s, 20 s, 30 s), until the feed appears — with the same **Reconnect now** button for anyone who would rather not wait. This is deliberate: the library's own answer to an unknown streamer is to step aside for a streamer list that this page does not render, which leaves a black stage with nothing on it.

### Self-healing

A wall display or a control room should never need a person to click anything, so the player drives its own recovery and narrates it:

* The library retries a dropped connection by itself for eight seconds. The page watches instead of competing; only once there is no transport, nothing in flight **and** the library's grace has expired does the page's own loop take over and ask for a reconnect itself. Getting this wrong is expensive — a loop that reconnects on top of a library that is already reconnecting tears down each fresh transport about a second after ICE completes, which looks exactly like an unstable streamer.
* Once the page is driving, attempts are spaced 3 s / 5 s / 10 s / 20 s / 30 s apart.
* A transport that comes back but never delivers a first frame counts as a failed attempt after 20 seconds and is taken down, rather than being waited on indefinitely.
* A live picture whose frame counter stops advancing raises the **stalled** cue after 6 seconds. If frames return the cue clears; if they do not, the page forces one reconnect after 15 seconds, then leaves that feed alone for 45 seconds so a genuinely frozen streamer cannot be hammered.
* The same stage rail reports the whole cycle, so a recovery looks exactly like a first connection.

### Keyboard shortcuts

The player is meant to be driven from a desk, so the keys are the whole UI: `m` sound, `f` fullscreen, `p` picture-in-picture, `s` statistics, `h` or `?` the shortcut card, and `Escape` to close the card. Any key press also brings the chrome back, so the shortcuts are discoverable without a mouse.

### Player chrome

The bar across the top is the whole of the player's own UI: back to the grid, the tally light, the stream name, the connection state, how many viewers are watching, and four buttons — sound, statistics, picture-in-picture, and fullscreen. It floats *over* the video rather than sitting above it, so the picture stays full-bleed and hiding the bar never resizes the video element (which would otherwise cost a decode-resolution round trip). Picture-in-picture is hidden entirely on browsers that do not offer it.

The bar hides itself after three seconds without pointer or keyboard activity and returns on the first pointer move, tap, or key press. It deliberately stays up while the loader is on screen — there is always something to read — and while the statistics panel is open. Under `prefers-reduced-motion` it simply appears and disappears, and the tally light holds its colour without pulsing.

Two library features are switched off on purpose:

* **The connection strength (QP) indicator.** The connection state in the bar already says what a viewer needs, and the indicator's coloured circle reads as noise against the test-card theme.
* **The settings panel**, removed outright along with its *Commands* section (request keyframe, restart stream). Quality, codec, FPS, and bitrate follow what the server sends; a viewer cannot retune them. A deployment that needs a fixed value sets the usual URL parameters (`PreferredQuality`, `PreferredCodec`, `WebRTCMinBitrate`, `WebRTCMaxBitrate`, `WebRTCFPS`) or `Config` defaults.

The statistics panel is the only library panel left, opened from the pulse button in the bar. Its config supplies an explicit empty `sectionVisibility` map: a panel config *without* that key makes the library's `isSectionEnabled()` call `hasOwnProperty` on `undefined` while the panel is being built, which throws inside the `Application` constructor and takes the entire player down with it. An empty map means "every section enabled", which is what the library does when no config is passed at all.

### Fullscreen

`f`, or the button at the end of the bar, expands the **stage** — the bar, the picture, the loader and the shortcut card together — rather than the video element on its own. That is what keeps the bar usable in fullscreen: a browser only paints the fullscreen element and its descendants, so a bar left outside it would vanish exactly when a viewer wants the exit most. The library's own fullscreen control is switched off for the same reason, because it fullscreens its inner UI element instead.

Once the picture is up, fullscreen behaves like the rest of the page: three seconds without a pointer or a key and the bar slides away, and the pointer goes with it, so nothing sits over the picture. The first movement of the mouse brings both back. The bar stays up while the loader is showing and while a feed is reconnecting, so a viewer never loses the exit on a stream that has gone wrong.

### The tally light and the viewer count

The dot after the back link is the tally, and it reads the same three states the loader rail reports: red and pulsing while the picture is live, amber and pulsing while a dropped feed is being rebuilt, and a plain dim dot while it is still connecting. On a bar that is otherwise grey this is the one piece of state worth a colour, and it is the broadcast convention: red means on air.

The eye chip further along is how many players are attached to this feed, this page included, and the Information panel's **Viewers** row carries the same number. The count comes from the snapshot index (`./snapshots`) — the same source the grid uses for its "most watched" sort, so a tile and the player cannot disagree — refreshed on load, on regaining visibility, when the picture first arrives, when the library itself reports a count, and every fifteen seconds behind that. Reading the index is a workaround for a gap in this stack rather than a preference: the library's `playerCount` event only fires if the signaller sends a `playerCount` message, and this server never sends one, so the library's row would otherwise read "—" for the life of the page. Until a number has actually been read, the chip and the row both stay out of the way rather than claiming an invented zero.

## Colour-bar theming

Both pages are themed around the SMPTE 75% colour bars, because this frontend is used in broadcast production where test cards are the familiar reference. The palette is declared once per stylesheet as custom properties in `:root`, taken from the 75% (not 100%) bars:

| Token | Bar | Value |
| --- | --- | --- |
| `--bar-grey` | Grey | `#bfbfbf` |
| `--bar-yellow` | Yellow | `#bfbf00` |
| `--bar-cyan` | Cyan | `#00bfbf` |
| `--bar-green` | Green | `#00bf00` |
| `--bar-magenta` | Magenta | `#bf00bf` |
| `--bar-red` | Red | `#bf0000` |
| `--bar-blue` | Blue | `#0000bf` |
| `--bar-blue-lit` | Blue, lifted | `#4a6bff` |

`--bars` is the seven-stop gradient built from those tokens, drawn as a strip along the top of the top bar, as the app's small test-card chip next to the wordmark, and as a thin signal line across the bottom of each grid tile that brightens once a preview frame has loaded. The player reuses the same tokens for its per-stage loader colours and for the step rail, so the rail's cyan / yellow / magenta / green ramp reads as one sequence with the stage tints.

Two rules keep the theme from getting in the way of the job:

* **Red is reserved for faults.** It is never used decoratively, so a red element on screen means something is wrong. Blue is used at its lifted value wherever it is a thin animated stroke, because the true 75% blue is nearly invisible on the dark background.
* **Colour is never the only cue.** Every coloured element also carries text, a shape, or an `aria-live` announcement, so the state is still legible in greyscale or to a user who cannot distinguish these hues. The strips and swatches are static backgrounds, not animations, so they cost nothing to composite.

## Installable app and its offline shell

The pages are a small PWA. `manifest.webmanifest` gives the app a name, the theme colour (`#0d0f12`) and three icons including a maskable one, and `sw.js` precaches the app shell — `grid.html`, `player.html`, `wall.html`, the three bundles, the three stylesheets, the icons and the manifest — so the pages open instantly and still render something sensible while the signalling server is briefly unreachable.

Nothing live is ever cached: the streamer list, the snapshot index, the snapshot JPEGs themselves and every WebRTC or signalling socket go to the network every time, because a stale preview or a stale feed list would be worse than no preview at all. The bundles are emitted with stable names, so `copy-webpack-plugin` stamps each build into the cache name and the previous cache is dropped on activation.

Service workers, notifications, Wake Lock and picture-in-picture all need a *trusted* origin. `http://localhost` counts; any other host name needs `https://`. `make_cert.bat` creates a local certificate authority and a server certificate covering the loopback names this app is used on, and `start_local.bat --https` then serves the frontend over TLS:

```
make_cert.bat --trust      once, from an elevated prompt, to import the CA
start_local.bat --https
```

The certificates live in `SignallingWebServer\certificates` and are not committed; `make_cert.bat` will not overwrite an existing set unless it is given `--force`. To use the same app from another machine, install `ps-local-ca-cert.pem` as a trusted root there first.

## Starting everything locally

`start_local.bat` (at the repository root) starts both halves of the stack in their own windows and prints the URLs, waiting for Wilbur to listen before it starts the SFU:

```
start_local.bat             local mode - the SFU advertises this machine
start_local.bat --cloud     cloud mode - the SFU advertises the public IP it looks up
start_local.bat --https     serve the frontend on 443 with the certificates above
```

Wilbur is started with `--hide_non_sfu_streamers`, so players only ever see SFU feeds, and with `--snapshot_proxy`, so previews come from the frontend's own origin. If the SFU port is already in use the script assumes Wilbur is already running and starts only the SFU, which makes it safe to re-run after one half has died.

## Development
This implementation is built on the [Signalling](../Signalling) library which is supplied as a library for developing signalling applications. Visit its [documentation](../Signalling/docs) for more information.

A development mode that watches for changes to libraries, frontend and source exists in this project. To utilize it you can invoke `npm run develop`. This will kick off a series of watchers that all watch the individual components of the signalling server and frontend for changes and will auto build and restart the signalling server, or in the case of frontend changes, redeploy the frontend for the signalling server to serve.
#### Note
By default, when the signalling server launches in this mode, the port to access the frontend changes to 1025 and so you will need to visit `http://localhost:1025` to access the frontend. This is to get around the need for elevated permissions for port 80.

### Self-signed certificates
During development it may be useful to work with self-signed SSL certificates (e.g. HTTPS is required for some features like XR and microphone usage). Self signed certificates can be generated using the following instructions:

1. Navigate to the `SignallingWebServer` directory.
2. Create a subdirectory called `certificates`.
3. Open Git Bash or your preferred shell.
4. Run `openssl req -x509 -newkey rsa:4096 -keyout client-key.pem -out client-cert.pem -sha256 -nodes`
5. Ensure your `config.json` contains:

```json
"ssl_key_path": "certificates/client-key.pem",
"ssl_cert_path": "certificates/client-cert.pem",
```

## Further Documentation
- [Protocol Messages](../Common/docs/messages.md)
- [Protocol Negotiation](../Common/docs/Protocol.md)

