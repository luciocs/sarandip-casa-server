<!-- SPDX-License-Identifier: Apache-2.0 -->
# Protocol `sarandip-ws-1`

Wire contract between a Sarandip Casa device (ESP32-S3 firmware) and this Cloudflare Worker + Durable Object voice server.

The **pairing contract in §2 is frozen**. Do not change it without coordinating with the firmware. The optional `claim` / `device_secret` request fields and the `403 claim_closed` answer (§2.2, on-device claim codes, firmware 0.1.3+) were added together with the firmware; requests without them behave exactly as before. The tests in `test/` and `tools/smoke-device.mjs` use the bytes described here.

The previous protocol name `luva-ws-1` is a compatibility alias: a device `hello` is accepted with no `protocol` field, with `sarandip-ws-1`, or with that legacy name. `GET /bloco/config` and `hello_ack` advertise `sarandip-ws-1`.

## 1. Overview

```
 device ──HTTPS POST /bloco/turn (multipart wake+audio)──▶ Worker ──▶ STT ──▶ fast LLM
   ▲                                                         │                └─▶ <<AGENT>> ─▶ owner agent
   │◀── 200 audio/wav stream (fast answer OR a short "on it") / 204 ──────────┘
   │
   └══ WSS /v1/devices/stream (outbound, opened by the device) ══▶ Durable Object DeviceHub (one per device)
          ▲                                                          ▲
          └──── tts_start / binary PCM / tts_end ◀───────────────────┘◀── POST /bloco/reply
```

- **Turn uplink is HTTP only** (`turn_uplink: "http"`). The WebSocket never carries uplink audio.
- **Fast answers** come in the body of `POST /bloco/turn`.
- **Late agent answers** come only over the open WebSocket. The device never opens an inbound port.
- One WebSocket per device. A new connection from the same device closes the previous one with code `4000 replaced`.
- Pairing is how a device receives its token. The server stores only the SHA-256 of that token, plus a legacy `DEVICE_TOKENS` secret as fallback.

## 2. Pairing (frozen contract)

This is the contract the firmware uses to obtain a device token. The owner types a short code on the device setup page; the owner never sees the token.

### 2.1 `POST /v1/admin/pairing-codes`

Protected by `Authorization: Bearer <ADMIN_TOKEN>`. If `ADMIN_TOKEN` is unset or shorter than 16 characters, the endpoint is closed (`401`).

Optional JSON body:

```json
{ "ttl_s": 600 }
```

- `ttl_s` is optional. Default `600`. Minimum `60`. Maximum `3600`.

`200` response:

```json
{
  "pairing_code": "AB3D-EF7H",
  "expires_in": 600,
  "expires_at": "2026-11-21T01:00:00.000Z"
}
```

- The code is 8 characters from `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no I, L, O, U), shown as `XXXX-XXXX`.
- Comparison is case-insensitive and ignores hyphens and spaces.
- Single use. Stored until it expires or is consumed.
- Other statuses: `401`, `400` (`bad_json`), `405`.

Device claim codes are an additive admin option. They do not change the `/v1/devices/pair` request or response (that contract stays frozen). Body:

```json
{ "device_id": "sc-0123456789ab", "permanent": true }
```

- `permanent: true` requires a valid `device_id` (`^[A-Za-z0-9_-]{1,64}$`). `ttl_s` is ignored.
- The code has no expiry and is bound to that `device_id`. Another device redeeming it gets `404 unknown_code`.
- The same device may redeem it again (factory reset, new owner, or a new pair after a Wi-Fi change). Each successful pair issues a fresh token, invalidates the previous one, and re-arms the welcome, same as a short-lived re-pair.
- Re-issuing for the same `device_id` replaces the previous claim code.

`200` response:

```json
{ "pairing_code": "AB3D-EF7H", "device_id": "sc-0123456789ab", "permanent": true, "rotated": false }
```

`rotated` is `true` when a previous claim code for that device was replaced. There is no `expires_in` / `expires_at`.

`DELETE /v1/admin/pairing-codes` with the same admin auth and `{"device_id":"…"}` or `{"pairing_code":"XXXX-XXXX"}` revokes that claim code (`200 {revoked:true, device_id}` or `404`). It does not revoke the current device token; use `POST /v1/admin/devices/revoke` for that. Short-lived expired or consumed codes are still swept after 24 hours; claim codes are never swept. Pairing rate limits on `/v1/devices/pair` still apply.

### 2.2 `POST /v1/devices/pair`

No device token. Rate limited (default 10 attempts per client IP per 300 seconds; `PAIR_RATE_MAX` / `PAIR_RATE_WINDOW_S`).

Request:

```json
{ "pairing_code": "AB3D-EF7H", "device_id": "dev_home01", "fw_version": "0.7.7" }
```

- `pairing_code` (required)
- `device_id` (required), `^[A-Za-z0-9_-]{1,64}$`
- `fw_version` (optional string, stored truncated to 40 characters)
- `claim` (optional, additive): `"device"` means the device's setup page checked `pairing_code` against the code
  stored on the device (firmware 0.1.3+, code printed on the device's card).
- `device_secret` (optional, additive, with `claim`): 32-128 printable ASCII characters (the firmware sends 64 hex)
  that the device generated and keeps; never shown to the owner.

**Device claim (on-device code).** When `pairing_code` matches an admin-issued code, pairing works exactly as
before and `claim` / `device_secret` are ignored. Otherwise:

- if this `device_id` was claimed before, the code must match the stored PBKDF2-SHA256 verifier (100,000
  iterations, random salt, over `device_id:code`) and, when a device secret was stored, SHA-256(`device_secret`)
  must match too. Any mismatch is `404 unknown_code`;
- if not, and `claim` is `"device"`, the server enrolls the device (trust on first use) when the policy allows:
  - `CLAIM_MODE = "first"` (default): only while the registry has no paired device and no claim;
  - `CLAIM_MODE = "open"`: any `device_id` not already paired;
  - `CLAIM_MODE = "off"`: never;
  - `CLAIM_DEVICE_IDS` (comma-separated): when set, only listed ids may claim, also after the first device
    (`"off"` still wins);
  - a `device_id` that is already paired through an admin code is never claimed;
  - refused: `403 claim_closed`.
- The raw code and device secret are never stored. `GET /v1/admin/claims` (admin) lists claimed ids with
  timestamps; `DELETE /v1/admin/claims` `{"device_id"}` forgets a claim (`200 {forgotten:true}` or `404`; the
  current token stays valid until revoked).

`200` response (the raw token appears **only** here):

```json
{
  "device_id": "dev_home01",
  "token": "<32-byte base64url, shown only once>",
  "base_url": "https://<worker-host>",
  "ws_url": "wss://<worker-host>/v1/devices/stream",
  "tz": "UTC"
}
```

- The server stores only the SHA-256 of `token`.
- Re-pairing the same `device_id` issues a new token and invalidates the previous one.
- `base_url` is `PUBLIC_BASE_URL` if set, otherwise the request origin.
- `tz` is the Worker `TZ` variable (IANA, default `UTC`).

Errors:

| Status | `error` | When |
|---|---|---|
| `400` | `bad_request` / `bad_json` | missing or invalid fields |
| `404` | `unknown_code` | the code does not exist (or a claimed device's code / device secret does not match) |
| `403` | `claim_closed` | device claim refused by `CLAIM_MODE` / `CLAIM_DEVICE_IDS` |
| `410` | `expired` | the code is past its ttl |
| `410` | `used` | the code was already consumed |
| `429` | `rate_limited` | too many attempts; `Retry-After` (seconds) |
| `405` | `method` | not POST |

Tokens issued this way live in the `DeviceRegistry` Durable Object. The `DEVICE_TOKENS` Worker secret remains a legacy fallback (JSON map of `device_id` to SHA-256 hex). Registry entries win when both exist.

To revoke a paired device: `POST /v1/admin/devices/revoke` with `Authorization: Bearer <ADMIN_TOKEN>` and `{"device_id":"dev_home01"}`. `200 {revoked:true}` or `404`.

## 3. Base, TLS and authentication

- Base: `https://<name>.<subdomain>.workers.dev` (or a custom domain on Cloudflare). WebSocket: `wss://<same host>/v1/devices/stream`.
- TLS against a public CA. The firmware already does NTP.
- The firmware only opens the WebSocket against an `https://` base, with a non-empty device id.
- **Every device request** sends `X-Device-Token: <token>` and, if available, `X-Device-Id: <device_id>`.
  - The server compares SHA-256 digests in constant time.
  - If `X-Device-Id` is present and does not match the token: `401`.
  - Missing or wrong token: `401` with `{"error":"device token rejected"}`.
- Prefer pairing (§2) to deliver the token. `tools/token.mjs --hash-stdin <device_id>` hashes a token from stdin and prints **only** the hash, for the legacy `DEVICE_TOKENS` secret.

## 4. `GET /bloco/config`

`200 application/json`. Device-authenticated.

```json
{
  "backend": "sarandip", "wake_word": "hey_jarvis", "wake_display": "Hey Jarvis",
  "sample_rate": 16000, "channels": 1, "bits": 16,
  "turn_url": "https://<base>/bloco/turn", "wake_log_url": "https://<base>/bloco/wake-log",
  "ws_url": "wss://<base>/v1/devices/stream",
  "token_header": "X-Device-Token", "device_id_header": "X-Device-Id", "auth_required": true,
  "ws_enabled": 1, "ws_mute_events": 1, "ws_wake": 0, "turn_uplink": "http",
  "ambient_listen": "off", "ambient_enabled": 0, "follow_up_enabled": false, "barge_in": "off",
  "late_reply": "ws", "reply_audio": {"format": "pcm_s16le", "sample_rate": 16000, "frame_bytes": 8192},
  "protocol": "sarandip-ws-1", "tz": "UTC",
  "ota_auto": "on", "ota_url": "https://<base>/bloco/ota"
}
```

- The response does **not** include a `sarandip_base` override: the device keeps the base it already has (from pairing or from its saved settings).
- `ambient_listen` is always `"off"`. This config cannot turn ambient listening on.
- `tz` is the configured IANA time zone.
- `wake_word` / `wake_display` are labels. The device always uses the wake model embedded in its firmware build (public default `hey_jarvis`, "Hey Jarvis"; alternatives `okay_nabu`, `hey_mycroft`); it ignores `wake_word` and any `model`, `models`, `model_url` or `models_detail` key, and never downloads models.

## 5. `POST /bloco/wake-log`

Device-authenticated. Body like `{"keyword":"hey_jarvis","score":0.97,"max":0.99,"window":3,"fw":"0.7.7"}`. Response `204`. Stored in the device Durable Object (last 2000 rows).

## 6. `POST /bloco/turn`

### Request

- `Content-Type: multipart/form-data; boundary=BelaTurn7f3a`, `Connection: close` and an exact `Content-Length` (no chunked uplink).
- Part `wake` (WAV PCM16 mono 16 kHz, wake clip) and part `audio` (WAV PCM16 mono 16 kHz, the question).
- Headers `X-Sarandip-Trigger: wake|button|continuation`, `X-Sarandip-Wake-Score`, `X-Sarandip-Wake-Hi`, `X-Sarandip-Wake-Cut`. `X-Bela-Firmware` (legacy) is accepted and ignored.
- `X-Sarandip-Firmware: <version>` (e.g. `0.1.0-dev`): the firmware version, sent by the device on `GET /bloco/config` and `POST /bloco/turn`. Informational; the server may log it and must not reject a request because it is missing or unknown.
- Button or continuation turns may send a single `Content-Type: audio/wav` body instead of multipart.

Limits: body up to 1 MiB (`413`); question up to 15 s (`413`); WAV must be PCM16 mono 16 kHz (`400`); a `data` size of `0xFFFFFFFF` is accepted; `X-Sarandip-Trigger: wake` without a `wake` part is `400`.

### Responses

| Status | Body | Device |
|---|---|---|
| `200` | `audio/wav` stream: RIFF header with sizes `0xFFFFFFFF` + PCM16 mono 16 kHz until close. Cloudflare delivers it **chunked**. | play |
| `204` | empty. Silence or an empty transcript (STT < 2 characters). | do not play, not an error |
| `400` / `401` / `413` / `415` | JSON `{"error":"..."}` | fail, do not play |
| `502` | JSON (STT or TTS failed) | fail, do not play |

Response headers:

- `X-Sarandip-Led: speaking` and `X-Sarandip-Sample-Rate: 16000`.
- `X-Sarandip-Route`: `fast`, `routine` (agent accepted; body is the short acknowledgement) or `routine_failed`. `204` uses `silent`.
- `X-Sarandip-Late-Reply` is always present when there is an audio body: `1` only when the agent accepted (a late answer will arrive on the WebSocket); `0` on `fast` and `routine_failed`. `204` does not send this header.
- `X-Sarandip-Turn-Id: t_<16 hex>` on `routine` and `routine_failed`.

Optional firmware behaviour: on `X-Sarandip-Late-Reply: 1`, keep a thinking LED for up to 120 s or until `tts_start` for that `turn_id`.

## 7. WebSocket `GET /v1/devices/stream`

### Handshake

```
GET /v1/devices/stream HTTP/1.1
Host: <host>
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <16 bytes base64>
Sec-WebSocket-Version: 13
X-Device-Token: <token>
(X-Device-Id: <device_id> is accepted and recommended)
```

- `101` with a correct `Sec-WebSocket-Accept`.
- `401` (no upgrade) if the token fails. Firmware should treat HTTP 401 like close codes 4401/4403, with a 5-minute wait, so it does not retry every 30 s.

### Control frames (text JSON, client → server)

Envelope: `{"v":1,"type":"...","device_id":"dev_home01","seq":N,"ts":ms,...}`.

| type | When | Server |
|---|---|---|
| `hello` | first frame, required. Extra fields: `fw_version`, `hw_rev`, `capabilities`, optional `protocol`. | `hello_ack` `{"v":1,"type":"hello_ack","session_id":"<uuid>","filter_version":"casa-1","server":"sarandip-casa/0.1","protocol":"sarandip-ws-1","reply_audio":"pcm_s16le_16000"}`. If `device_id` ≠ the token's device: close `4403`. |
| `heartbeat` | every 30 s, with `rssi`, `uptime`, `muted`, `tts_*` | none. `muted` updates state. |
| `mute` / `unmute` | mute switch (`ws_mute_events: 1`) | none. While muted, `/bloco/reply` returns `409` and sends no audio. |
| `ping` | optional | `{"v":1,"type":"pong"}`. The exact text `{"v":1,"type":"ping"}` is answered by Cloudflare without waking the Durable Object. |
| anything else | — | ignored (forward compatible) |

- Any frame before `hello`: close `4400`.
- Binary frame from the device: `{"v":1,"type":"error","code":"binary_unsupported"}`. Turns are not sent over the WebSocket in this protocol.
- Text frame over 64 KiB: close `1009`.

### Keepalive and hibernation

- The Durable Object uses the Hibernation API (`acceptWebSocket`). Between messages it sleeps; the socket stays open at Cloudflare.
- **Protocol ping (opcode 0x9) every 15 s**: Cloudflare answers with pong (0xA) without waking the object. This feeds the firmware `lastRx` and keeps NAT open.
- `heartbeat` every 30 s wakes the object briefly.
- The firmware reconnects if it receives nothing for 60 s.
- The server does **not** send application pings. Protocol pong is enough.

### Reconnect

- Backoff 1, 2, 4, 8, 16, 30 s with ±20% jitter. Reset to 1 s after a session that reached `hello_ack`.
- Close `4400`, `4401` or `4403`: wait 5 minutes.
- Close `4000 replaced` (another connection for the same device): normal backoff.
- Cloudflare runtime updates drop sockets occasionally; that is why backoff exists.

### Late audio: agent reply

Always in this order, on the same connection:

1. Text `{"v":1,"type":"tts_start","stream":<n>,"phase":"final","turn_id":"t_…","format":"pcm_s16le","sample_rate":16000}`
2. N **binary** frames (opcode 2, FIN=1, no fragmentation): raw PCM16 little-endian mono 16 kHz, **no header**.
   - Each frame is **8192 bytes** (256 ms). The last may be shorter, but always **even**.
3. Text `{"v":1,"type":"tts_end","stream":<n>,"phase":"final","turn_id":"t_…","audio_ms":<ms>}`

Notes:

- No frame starts with `0x53 0x41` ("SA", ADPCM) or `0x53 0x31` (S1). If it would, the server changes the first byte to `0x52` (1 LSB, inaudible).
- `phase:"final"` is the answer, not the acknowledgement.
- Play `tts_start` / binary / `tts_end` while the device is idle. During a turn, drop and send `tts_dropped` with `reason:"busy_turn"`. The server resends (below). Mute: discard.

Device → server (already in current firmware):

- `{"v":1,"type":"tts_played","stream":n,"turn_id":"t_…","played_ms":…,"result":"done|button|muted|timeout"}`: the server marks the turn `played` (final) and drops the stored reply text.
- `{"v":1,"type":"tts_dropped","stream":n,"turn_id":"t_…","reason":"busy_turn|muted|format"}`, sent on `tts_start`, before any audio:
  - `busy_turn`: status `retry`, Durable Object alarm. The whole reply is resent (new TTS, new `stream`) after 10 s, 20 s and 30 s, at most `REPLY_RETRY_MAX` (3) times and always within `REPLY_TTL_S`. If the device is offline or muted at alarm time, try again 20 s later, still within the TTL.
  - `muted` or `format`: final (`dropped`), no resend.
- If neither arrives, the turn stays `delivered` (older firmware). That remains compatible.

### Welcome (server-initiated, once per pairing)

A successful `POST /v1/devices/pair` arms a one-time welcome for that `device_id`. After the next `hello` (and after `WELCOME_DELAY_MS`, default 2000 ms, so `hello_ack` is never delayed), the server sends it exactly like a late reply: `tts_start` (`phase:"final"`, a fresh `turn_id` `t_<16 hex>`), binary PCM frames, `tts_end`. The device handles it with the existing late-reply code and answers `tts_played` / `tts_dropped` as usual; `busy_turn` is resent by the same alarm schedule. If the device is offline or muted, the welcome stays armed and goes out on the next `hello` or `unmute`. It is never sent twice for one pairing. `WELCOME_MODE = "off"` disables it. Admin routes (`Authorization: Bearer <ADMIN_TOKEN>`): `PUT|GET|DELETE /v1/admin/welcome-audio` (owner clip, WAV PCM16 mono 16 kHz ≤ 1 MiB; `GET` returns metadata only) and `POST /v1/admin/devices/welcome` `{"device_id"}` (re-arm).

**Serialization:** each device Durable Object sends one reply at a time. Two concurrent `/bloco/reply` calls are queued: frames never interleave, and the same `turn_id` goes out once (the second gets `409 already_delivered`). `stream` is a monotonic counter persisted in the object.

Turn states: `pending` → `sending` → `delivered` → `played` | `retry` (→ `delivered` …) | `dropped`.

## 8. `POST /bloco/reply` (agent → Worker)

- `Authorization: Bearer <REPLY_SECRET>`, compared in constant time. If the secret is unset or shorter than 16 characters, the endpoint is closed (`401`).
- During rotation the Worker also accepts `REPLY_SECRET_PREVIOUS` (same minimum length). Both are per owner (one Worker), not per device. Recommended order: give the new value to the agent first, then set it as `REPLY_SECRET` and keep the old value in `REPLY_SECRET_PREVIOUS` until late replies with the old value have finished (up to `REPLY_TTL_S`). Then delete `REPLY_SECRET_PREVIOUS`.
- Body: `{"turn_id":"t_<16 hex>","device_id":"dev_home01","text":"<up to 500 characters, spoken, no markdown>"}`.
- The Worker synthesizes speech and sends it on the open WebSocket for that device.

| Status | `status` | Meaning |
|---|---|---|
| `200` | `delivered` (+ `audio_ms`) | sent on the socket |
| `503` | `offline` | no open WebSocket with hello |
| `409` | `muted` / `already_delivered` | muted, or already answered |
| `404` | `unknown_turn` | `turn_id` is not registered on this device |
| `410` | `expired` | past `REPLY_TTL_S` (900 s) |
| `400` | — | bad body |
| `502` | `tts_error` | TTS failed |

The webhook the Worker sends to the agent already has everything the agent needs:

```json
{"text":"<transcript>","turn_id":"t_…","device_id":"dev_home01","spoken_at":"<ISO UTC>",
 "timezone":"UTC","local_date":"2026-11-20","weekday":"Friday","local_time":"22:40",
 "utc_offset":"+00:00","local_datetime":"Friday, 20 November 2026, 22:40",
 "source":"device","context":"pedido: …\nuser: …\nsarandip: …","reply_url":"https://<base>/bloco/reply?t=<token>","reply_auth":"url"}
```

`source` is the `DEVICE_KIND` var (default `device`). Clock fields are computed at the moment of the turn, in the configured `TZ` and `LANGUAGE`. The agent should use them for "today", "tomorrow" and "now", without converting UTC.

A webhook is accepted on **any HTTP 2xx**. The Grok Bot `success` / `runUuid` body is still fine, but it is no longer required.

**Never put `REPLY_SECRET` in the agent's or routine's instruction text.** When `reply_auth` is `"url"`, `reply_url` already carries a short-lived, turn-scoped authorization, so the agent `POST`s that URL with the JSON body and no secret header. Agents that still use the Bearer header must read `REPLY_SECRET` from a secret store, never from instruction text.

`PUBLIC_BASE_URL`, when empty, is derived from the request origin so `reply_url` still works.

## 9. `GET /v1/devices/status`

Authenticated. `online` is true only when a WebSocket for that device is open **and** has completed `hello`.

- Device token (`X-Device-Token`): status of that device.
- Admin (`Authorization: Bearer <ADMIN_TOKEN>`) with `?device_id=dev_home01`: the same payload, so the owner's agent can check status without ever seeing the device token.

`200`:

```json
{ "device_id": "dev_home01", "online": true, "muted": false, "fw": "0.7.7", "pending": 0 }
```

`401` if neither credential is valid. `400` if admin auth is used without a valid `device_id`.

## 10. Fast-path context (clock and memory)

The system prompt of every turn has three parts:

1. **Rules.** The assistant name (`ASSISTANT_NAME`, default `Sarandip`) and device kind (`DEVICE_KIND`, default `device`). Prompts are in English or Brazilian Portuguese according to `LANGUAGE`. When `ROUTINE_PROVIDER` is not `off` and `ESCALATE_PREROUTE` is on (the default), calendar, email, tasks, reminders, messages and other live personal data are pre-routed to the agent before the fast model is called. Clock questions stay on the fast path. The system prompt also tells the model that memory is a static snapshot and must not be used to answer those questions; the model still escalates with `ESCALATE_MARK` (default `<<AGENT>>`) for tools, live data, or memory that is not in the block. When the provider is `off`, the fast model may answer from memory as before.
2. **Clock.** Computed every turn from `TZ` (IANA, default `UTC`) and `LANGUAGE`. Never cached.
3. **Memory.** Read from `Agent.md` in `MEMORY_REPO` (`owner/name`). Default repo: `luciocs/jarvis-memory-demo` (fictional example). Default headings: `## Quem sou`, `## Família` / `## Familia`, `## Tom e formato` / `### Tom e formato`, `## Perfil resumido`. Override with `MEMORY_SECTIONS`. Lines that look like secrets are dropped. Cap: `MEMORY_MAX_CHARS` (1400).

`MEMORY_ENABLED` defaults to `true`. The owner can skip memory by setting `MEMORY_ENABLED=false`. A **public** repository is fetched without `GITHUB_TOKEN` from `https://raw.githubusercontent.com/{repo}/{ref}/{path}`, with `If-None-Match` / ETag, the same cache, TTL and filters. A **private** repository still uses the GitHub contents API with `GITHUB_TOKEN`. The default example repository (`luciocs/jarvis-memory-demo`) is public and is read without a token.

Cache: isolate memory (L1) and the device Durable Object SQLite (L2). Fresh for `MEMORY_TTL_S` (600 s). After that the stale copy is served and revalidated in `waitUntil`. A cold fetch uses `MEMORY_FETCH_TIMEOUT_MS` (800 ms) in parallel with STT. Failure: no memory and a 60 s backoff. Memory content, tokens and speech never go to logs.

`GET /health` → `{"ok":true,"memory":"configured"|"off"}`. The flag only says whether memory is enabled and the repo/path vars are valid. It does not expose the repo, the content, or whether the last fetch succeeded.

Questions about a diary, themes or notes escalate straight to the agent (English and Portuguese patterns).

## 11. Agent connectors

`ROUTINE_PROVIDER`:

| Value | Behaviour |
|---|---|
| `webhook` | `POST` `WEBHOOK_URL` with `Authorization: Bearer <WEBHOOK_TOKEN>` by default (the header a Grok Bot routine webhook expects). If the optional var `WEBHOOK_AUTH_HEADER` is set to another header name, the raw token is sent in that header instead. Accepted on any HTTP 2xx. HTTPS only. This is also how a Grok Bot routine or OpenClaw webhook is connected. |
| `openai` | OpenAI-compatible `POST {OPENAI_BASE_URL}/chat/completions` with `OPENAI_API_KEY`. The spoken answer is delivered as a late reply in `waitUntil`. |
| `anthropic` | Anthropic `POST {ANTHROPIC_BASE_URL}/v1/messages` with `ANTHROPIC_API_KEY`. Same late-reply path. |
| `stub` | Test double. |
| `off` | No hand-off. |

There is no native OpenClaw client: configure OpenClaw as a generic webhook.

## 12. Limits considered

| Item | Limit | Use |
|---|---|---|
| CPU per request (Workers Free) | 10 ms; waiting on `fetch` does not count | multipart via native `formData()`; TTS is passed through |
| Durable Object CPU | 30 s per message or request (default) | about 40 `ws.send` of 8 KB per reply |
| Memory | 128 MB per isolate | largest buffer: the turn body (≤ 1 MiB) |
| WebSocket to the DO | 32 MiB; Worker WS messages up to 1 MiB | control < 1 KB; downlink frames of 8 KB |
| Subrequests | 50 per request (Free) | a turn is well under this |
| Requests | 100,000 / day (Worker and DO) on Free | home use: hundreds per day |
| Duration | HTTP unbounded while the client is connected | streamed answers |

## 13. Compatibility with existing firmware

Already present and still valid:

- `wsHandshake` with `X-Device-Token`, `hello`, `hello_ack`, `heartbeat`, protocol ping, backoff, 44xx codes.
- `tts_start` / binary / `tts_end` and raw PCM decode.
- Multipart turn uplink, chunked download and `204`.

Additive, backward-compatible fields: `protocol` and `tz` on config and `hello_ack`. The previous protocol name remains accepted on `hello`.


## 14. Firmware OTA

The device pulls an **application** image (the `firmware.bin` that starts at flash offset 0x10000), never a combined factory bundle.

### Admin (Bearer `ADMIN_TOKEN`)

- `PUT /v1/admin/firmware?channel=<id>` with `X-Sarandip-Firmware-Version: <semver>` and the raw app bytes (`100000`–`6 MiB`). Optional `X-Sarandip-Firmware-Sha256`. The Worker stores the image in the `FirmwareStore` Durable Object, computes SHA-256, and signs it with `FIRMWARE_SIGNING_KEY` when that secret is set (ECDSA P-256, SHA-256, raw `r||s` as 128 hex chars). A combined factory image (0xFF padding into the partition table at 0x8000) is rejected. `201` with `{channel, version, sha256, size, signature, uploaded_ms}`.
- `GET /v1/admin/firmware?channel=<id>` lists images. `GET ...&version=` returns one manifest. `DELETE ...&version=` removes it.
- `POST /v1/admin/firmware/assign` `{"device_id","channel","version"?}` binds that image to the device.
- `POST /v1/admin/firmware/push` does the same and, if the device WebSocket is up, sends `ota_available` and `ota`.
- `GET /v1/admin/firmware/status?device_id=` returns the assignment, last device report, and hub online/fw if known.

### Device (device token)

- `GET /bloco/ota?fw=<running>` — `204` if nothing is assigned or the assigned version is not newer. `200` JSON: `{version, channel, url, sha256, size, signature}`. `url` is a path on the same host (`/bloco/ota/image?...`).
- `GET /bloco/ota/image?channel=&version=` — the assigned image only, `application/octet-stream`, headers `X-Sarandip-Ota-Sha256` and `X-Sarandip-Ota-Signature`.
- `POST /bloco/ota/status` `{"event","version"?,"fw"?,"detail"?}` — `204`. Events used by the firmware: `started`, `applied`, `failed`, plus `verified` is reserved.

`GET /bloco/config` includes `ota_auto: "on"` and `ota_url`. Firmware 0.1.2-dev advertises `capabilities.ota_http: true`, polls when idle or muted (or immediately on a WebSocket `ota` / `ota_available`), refuses to start while speaking/listening/thinking, verifies hash and signature, writes the other OTA slot, and marks the new image valid only after a later config fetch or `hello_ack`.
