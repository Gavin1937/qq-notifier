# qq-notifier

Durable one-way notifications to QQ, from any process on your home server, through a QQ bot you create yourself.

`qqn` accepts short texts over a local HTTP API, queues them in SQLite, and delivers them one at a time to a QQ private chat. If the network or the bot is down, messages wait; when delivery keeps failing, the worker cools down and finally stops until you look at it.

```
process ──HTTP──▶ qqn ──queue──▶ QQ bot ──▶ your QQ private chat
```

## Why not just the official bot API?

QQ removed proactive bot pushes from the generic messaging API, and throttles them for agent bots. This service therefore treats every send as best-effort: it keeps the message on disk until the platform confirms delivery, and it tells you when it had to give up.

## Requirements

- **Node.js 22, 24 or 26.**
  - Node 24/26: nothing to do.
  - Node 22: SQLite is still flag-gated there; run with `NODE_OPTIONS=--experimental-sqlite` (PowerShell: `$env:NODE_OPTIONS='--experimental-sqlite'`). If `node:sqlite` is unavailable, the server exits immediately with `Cannot find module 'node:sqlite'` — set the flag.
- A QQ account that owns the bot (scanning the QR logs that account in as the bot's owner; the bot then talks to you in a private chat).

## Install

```bash
cd qq-notifier
npm ci            # or `npm install` on a fresh clone without a lockfile
npm test          # 42 tests, no network required
```

Run it as `node src/cli.js <command>`, or put `qqn` on your PATH once:

```bash
npm link          # then `qqn --help`
# or: npm install -g .
```

## Setup (once)

```bash
node src/cli.js setup
```

1. A QR code is printed in the terminal — scan it with the QQ app on the account that should own the bot.
2. The credentials land in `data/credentials.json` (mode `0600` on POSIX).
3. The command then says: *send any message to the bot in QQ*. Send anything; it captures your private-chat `openid` and writes it to `data/config.json`.
4. It exits and prints the next command plus a ready-to-paste `curl`.

Re-running `setup` needs `--force`; it never silently replaces working credentials.

If the config file does not exist, `setup` creates it from the template. Use `--config <path>` to keep it elsewhere:

```bash
node src/cli.js setup --config /srv/qqn/config.json
```

Print a documented template at any time:

```bash
node src/cli.js --config-template
```

## Run

```bash
node src/cli.js server
# or: qqn server --config /srv/qqn/config.json
```

The server listens on `127.0.0.1:<port>` and, when `server.bind_lan_ip` is set, on that address too. It refuses to start without `data/credentials.json` or `qq.target_open_id`, and tells you to run `setup`.

## Send

### Linux / macOS (bash)

```bash
# plain text body (shortest form)
curl -X POST http://127.0.0.1:24046/notify \
  -H 'Content-Type: text/plain' \
  --data 'download finished'

# JSON with an optional key
curl -X POST http://127.0.0.1:24046/notify \
  -H 'Content-Type: application/json' \
  -d '{"text":"build failed","key":"build-42"}'

# via the CLI (does not need curl)
node src/cli.js send "download finished" --key dl-7
```

### Windows PowerShell

`curl` in Windows PowerShell 5.1 is an alias for `Invoke-WebRequest`, so call `curl.exe` explicitly.

```powershell
# plain text
curl.exe -X POST http://127.0.0.1:24046/notify -H "Content-Type: text/plain" --data "download finished"

# JSON with a key (single-quoted so PowerShell does not interpolate)
curl.exe -X POST http://127.0.0.1:24046/notify `
  -H "Content-Type: application/json" `
  -d '{"text":"build failed","key":"build-42"}'

# no curl needed, and UTF-8 safe on both 5.1 and 7
$body = @{ text = 'build failed'; key = 'build-42' } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:24046/notify `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

Pass **bytes** to `Invoke-RestMethod`, not a string: Windows PowerShell 5.1 encodes a string body as Latin-1 and would mangle non-ASCII text.

### Windows cmd.exe

cmd has no single quotes; escape the JSON quotes, or keep the body in a file.

```bat
curl.exe -X POST http://127.0.0.1:24046/notify -H "Content-Type: text/plain" --data "download finished"

curl.exe -X POST http://127.0.0.1:24046/notify -H "Content-Type: application/json" -d "{\"text\":\"build failed\",\"key\":\"build-42\"}"

:: non-ASCII text: write a UTF-8 (no BOM) file and send it verbatim
curl.exe -X POST http://127.0.0.1:24046/notify -H "Content-Type: text/plain" --data-binary "@msg.txt"
```

When `server.token` is set, add `-H "X-Auth-Token: <token>"` to any of these requests.
The recipient sees:

```
**[2026-11-11 03:14:22.481] #build-42**

build failed
```

The timestamp is the time the server **accepted** the message, so a notification delivered late still shows when it happened. Late deliveries also render the same way — the age is visible in the timestamp. `#build-42` is printed only if you pass `key`.

## HTTP API

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/notify` | `text/plain` body, or JSON `{text, key?}` | `202 {id, queued_at}`; `400` empty/invalid; `401` bad token; `409 duplicate_key`; `413` text > 12 000 bytes; `415` bad content type; `429 queue_full` |
| `GET` | `/health` | — | bot state, queue depth, oldest age, halt/cooldown, last error |
| `GET` | `/queue?limit=50&full=1` | — | pending messages (bodies only with `full=1`) |
| `GET` | `/history?limit=50` | — | sent/abandoned rows |
| `POST` | `/resume` | — | clears halt and cooldown |

When `server.token` is set, every request needs `X-Auth-Token: <token>` or `Authorization: Bearer <token>`.

## Delivery semantics

- **Ordered**: oldest `received_at` first, one at a time, paced by `send_rate_per_second`.
- **Retries**: a failing attempt increments `attempts`; waits come from `backoff_ms`; after `max_attempts` the message is recorded as `abandoned` and the next one proceeds.
- **Bot offline**: the worker pauses and does **not** consume attempts; messages wait for the connection to come back.
- **Cooldown**: two abandoned messages in a row start a cooldown (`cooldown_ms`, doubling per extra failure up to `cooldown_max_ms`) so a systemic outage does not burn through the queue.
- **Halt**: after `halt_after_abandons` consecutive abandons the worker stops completely and logs it. This is intentional — run `node src/cli.js resume` once you have fixed the cause.
- **At-least-once**: a crash between "platform accepted" and "row deleted" replays the message on restart. Duplicates are possible; losses are not.

## Configuration (`data/config.json`, JSONC — comments allowed)

| Key | Default | Meaning |
|---|---|---|
| `server.port` | `24046` | HTTP port |
| `server.bind_localhost` | `true` | listen on `127.0.0.1` |
| `server.bind_lan_ip` | `null` | extra address, e.g. `"192.0.2.10"`; `null` = localhost only; `"0.0.0.0"` only inside Docker |
| `server.token` | `null` | shared secret; `null` disables auth |
| `server.max_body_bytes` | `65536` | request body cap |
| `qq.target_open_id` | — | written by `setup` |
| `queue.max_attempts` | `3` | attempts per message before abandoning |
| `queue.backoff_ms` | `[2000, 8000, 30000]` | wait before attempt 2, 3, … |
| `queue.cooldown_ms` | `300000` | first cooldown after consecutive abandons |
| `queue.cooldown_max_ms` | `3600000` | cooldown ceiling |
| `queue.halt_after_abandons` | `5` | consecutive abandons that stop the worker |
| `queue.max_outbox` | `1000` | pending cap; new messages get `429` |
| `queue.send_rate_per_second` | `1` | minimum spacing between sends |
| `queue.history_keep` | `1000` | history rows to keep; **`0` = keep everything** |
| `log.level` | `info` | `debug`, `info`, `warn` or `error` |
| `log.dir` | `null` | folder for `qqn.log` and its rotations, relative to `storage.data_dir`; `null` = stderr only |
| `log.console` | `true` | also write to stderr (journald / `docker logs`) |
| `log.max_size_bytes` | `10485760` | rotate when the file would exceed this |
| `log.max_files` | `5` | rotated copies to keep (`.1` … `.N`) |

Relative `storage.data_dir` resolves against the config file's directory. `data/` is gitignored: it holds credentials and the queue.

## Docker

```bash
cp examples/config.docker.jsonc data/config.json   # bind_localhost:false, bind_lan_ip:0.0.0.0
echo "LAN_IP=192.0.2.10" > .env                    # your real LAN address
docker compose run --rm -it app node src/cli.js setup
docker compose up -d
```

The container listens on `0.0.0.0:24046`, but compose publishes it only on `127.0.0.1` and `${LAN_IP}` — binding the host's LAN address from inside a container is impossible (`EADDRNOTAVAIL`), and this reaches the same result.

## Run as a service

### Linux (systemd)

[`examples/qq-notifier.service`](examples/qq-notifier.service) is a hardened unit: dedicated user, read-only filesystem except `data/`, restart with a start limit.

```bash
# 1) service user and ownership
sudo useradd --system --home /opt/qq-notifier --shell /usr/sbin/nologin qqn
sudo chown -R qqn:qqn /opt/qq-notifier/data

# 2) install the unit (edit the paths if the project is not in /opt/qq-notifier)
sudo cp examples/qq-notifier.service /etc/systemd/system/
sudo systemctl daemon-reload

# 3) enable at boot and start now
sudo systemctl enable --now qq-notifier

# 4) watch it
systemctl status qq-notifier
journalctl -u qq-notifier -f
```

Run `setup` **as the service user**, otherwise `credentials.json` ends up root-owned and the daemon cannot read it:

```bash
sudo -u qqn node src/cli.js setup --config /opt/qq-notifier/data/config.json
```

`ExecStart` assumes `/usr/bin/node` (distro or NodeSource install). With nvm or another prefix, put the absolute path from `command -v node` there — systemd does not read your shell's `PATH`.

Update:

```bash
cd /opt/qq-notifier && git pull && npm ci && sudo systemctl restart qq-notifier
```

Notes:

- `ProtectSystem=strict` makes the filesystem read-only except `data/`; keep config, credentials, the database and logs under that directory.
- `ProtectHome=true` hides `/home`; drop it if the project lives there.
- After 5 start attempts in 2 minutes systemd gives up, so a broken config fails visibly instead of crash-looping — inspect `journalctl -u qq-notifier`.

### Windows

Keep `node src/cli.js server` running under Task Scheduler ("At startup", "Run whether user is logged on or not") or a wrapper such as NSSM. There is no OS-specific code.
## Logging

By default the server logs to stderr only — journald, or `docker logs`. To keep a file:

```jsonc
"log": {
  "level": "info",
  "dir": "logs",              // folder, relative to storage.data_dir
  "max_size_bytes": 10485760,
  "max_files": 5,
  "console": true
}
```

- The server writes `<dir>/qqn.log` and creates the folder on startup.
- When the file would grow past `max_size_bytes` it rotates **inside that folder**: `qqn.log` → `qqn.log.1` → `qqn.log.2` … and the oldest of `max_files` copies is deleted. Rotation happens on a line boundary, never mid-line.
- The file is appended across restarts.
- `console: false` writes only to the file.
- `QQN_LOG_LEVEL` overrides `log.level` for one-off debugging (e.g. `QQN_LOG_LEVEL=debug qqn server`).
- `log.file` (an earlier 1.0.x spelling) is rejected at startup with a message pointing at `log.dir`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Cannot find module 'node:sqlite'` | Node 22: set `NODE_OPTIONS=--experimental-sqlite` |
| `credentials not found` | run `setup` |
| `qq.target_open_id is missing` | `setup` was interrupted before you messaged the bot; run `setup --force` |
| `EADDRINUSE` | another process owns the port; change `server.port` (and the URL in your scripts) |
| `EADDRNOTAVAIL` on the LAN address | DHCP changed your IP, or you are in Docker — see the Docker section |
| `401 unauthorized` | `server.token` is set; send the header |
| `413 text_too_large` | 12 000 byte platform limit |
| `429 queue_full` | the bot has been unreachable for a while; check `/health` |
| `/health` shows `halted: true` | fix the cause, then `node src/cli.js resume` |
| `Ctrl+C` seems to hang | shutdown stops the bot, worker and listeners, then exits explicitly (5 s timeout); a second `Ctrl+C` exits immediately |
| QR expired | the connector refreshes it; keep the terminal open |

## Development

```bash
npm test        # node --test, in-process, no network
```

Layout: `src/cli.js` (entry), `config.js` (JSONC + validation), `db.js` (node:sqlite), `queue.js` (delivery state machine), `qq.js` (bot adapter), `http.js` (API), `server.js` (wiring), `setup.js` (QR + openid).

File modes are explicit: `src/cli.js` is `100755` (it is the `qqn` bin) and every other
tracked file is `100644`. On Windows `core.filemode` is off, so the bit lives in the index
(`git update-index --chmod=+x src/cli.js`) and is applied by git on a Linux checkout.
The repository is meant to be committed frequently; `data/` and `node_modules/` are ignored.

## License

MIT - see [LICENSE](LICENSE).
