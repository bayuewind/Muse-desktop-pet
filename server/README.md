# Muse → AI Passport bridge (server)

Headless service that keeps a native Muse connection and pushes the task
state to the Muse avatar on an AI Passport. It reuses the desktop pet's
`desktop-pet/native` modules unchanged (`NativeSource`: renewal, gateway token,
Noise channel, heartbeat, polling, reconnect); only the credential storage is
swapped for a server implementation. No browser or Electron at runtime.

```
Muse gateway ──Noise──> muse-bridge (Docker) ──HTTP /avatar──> device gateway ──MQTT/WS──> AI Passport
```

The device side (avatar + MCP tool `self.avatar.set_state`) lives in
`bayuewind/folo-ai-passport-xiaozhi`, branch `feature/muse-avatar`.

## 1. Pair once (on the Mac)

Needs Google Chrome and a network that can reach Muse.

```sh
cd desktop-pet && npm ci --omit=dev --ignore-scripts && cd ..
node server/pair-for-server.cjs --approved-session-export
```

A dedicated Chrome window with a **fresh temporary profile** opens; log in to
Muse yourself. The tool verifies the VM assignment, the Noise binding and a
ping, then stores the session encrypted (AES-256-GCM) in
`server/data/native-session.enc`. The key is generated into `server/.env`
(`MUSE_VAULT_KEY`, mode 0600). The session is independent from the desktop
pet's own login; the desktop keychain vault is never read.

**Never commit or share `server/data/` or `server/.env`** (both are
git-ignored and excluded from the Docker build context). Anyone with both can
act as your Muse account.

## 2. Run

```sh
docker compose -f server/docker-compose.yml up -d --build
curl -s localhost:18787/state      # redacted status, no credentials or chat
docker compose -f server/docker-compose.yml logs -f
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `MUSE_VAULT_KEY` | from `.env` | 32-byte base64 key for the session vault |
| `DEVICE_GATEWAY_URL` | `http://host.docker.internal:8003` | gateway exposing `GET /avatar?state=&subagents=` (for now the test server in `folo-ai-passport-xiaozhi/scripts/sim-test/server.py`) |
| `BRIDGE_PORT` | `18787` | host port for `/healthz` and `/state` (127.0.0.1 only) |

The session is renewed every 10 minutes and written back to `server/data`,
so the volume must stay writable. After an authorization or server-identity
error the bridge stops reconnecting and reports `unknown`; re-running the
pairing tool replaces the vault file and the bridge reconnects within ~30 s.

## State mapping

| Muse (`NativeStatus.view().kind`) | Device `state` |
| --- | --- |
| `idle` | `default` |
| `working` / `making_something` variant | `working` (+ sub-agent count) / `making_something` |
| `approval`, `waiting`, `limited`, `syncing` | same name |
| `unknown` "原生连接中" / "原生连接已断开" | `syncing` / `offline` |
| other `unknown`, `login` (re-authorize) | `unknown` |

Changes are pushed immediately and re-sent every 60 s, so a rebooted device
recovers the current state. Uncertain states never map to idle.

## Tests

```sh
cd server && npm test
```

## Known limits

- The device cannot tell that the bridge itself stopped; it keeps the last state.
- The device has no dedicated "re-authorize" state yet (shown as unknown).
- Whether the desktop and server sessions coexist long-term, and whether
  using the session from another IP triggers extra verification, still has
  to be observed.
