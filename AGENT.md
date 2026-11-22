# AGENT.md: set up a Sarandip Casa voice server

These are instructions for an AI agent (for example Grok Bot) that has Cloudflare access and is acting **for the device owner**.

Goal: deploy this voice server into the **owner's own** Cloudflare account, set up the owner's keys as Worker Secrets, walk through memory and the owner's agent, verify everything, and pair the device.

Every step is **idempotent**: check the current state first, change only what is missing, and verify afterwards.

---

## 0. Safety rules (non-negotiable)

1. **Never print, log, echo, commit or paste a secret value.** This covers API keys, `REPLY_SECRET`, `REPLY_SECRET_PREVIOUS`, `ADMIN_TOKEN`, device tokens, `WEBHOOK_TOKEN` and `GITHUB_TOKEN`, and it applies to chat, terminal output, files, commit messages, routine or agent instructions, and issue text. When reporting, say "set" or "missing", never the value. Do not run commands whose output contains a secret. `tools/token.mjs` does not print a raw token; still, prefer pairing (step 4) so the token only ever appears in the pairing response to the device.
2. **Ask the owner only for their API keys,** and only through a protected or masked input: the agent's secure form or secret field, or `wrangler secret put` reading from a pipe that you never display. **Never ask for keys in chat.** If the owner pastes a key in chat anyway, do not use it. Tell them to revoke it and create a new one.
3. **Use the owner's account only.** Never deploy into an account that is not the owner's. If several accounts are visible, ask which one.
4. **Do not commit** `wrangler.toml` with an `account_id`, nor `.dev.vars` or any generated token or hash. Never push to any remote unless the owner explicitly asks.
5. **Confirm before anything destructive or externally visible:** deleting a Worker, Durable Object namespace or secret; overwriting an existing Worker that you did not create; rotating secrets in use; renaming the workers.dev subdomain; adding a custom domain or DNS records. State exactly what will change and wait for a yes.
6. **Do not flash firmware** and do not change device settings beyond the pairing flow the owner performs.
7. **Memory carries a privacy warning.** Anyone speaking to the device may hear its content. The fictional example repository is connected by default. Before pointing memory at a personal repository, tell the owner this and get a clear yes. Recommend a dedicated repository with nothing sensitive in it. The owner may skip memory entirely.
8. **If a step fails twice, stop** and report what you tried and the error class. Do not try riskier alternatives.

---

## 1. Check Cloudflare access

- With a Cloudflare connector, call `whoami` and list the accounts. With wrangler, run `npx wrangler whoami`.
- If more than one account is listed, **ask the owner which one**. Record the account id **locally only**, as the env var `CLOUDFLARE_ACCOUNT_ID`, never in a committed file.
- Find the account's workers.dev subdomain. If none exists, ask the owner to choose one; this is visible in URLs, so confirm it with them.
- **Verify:** you can list Workers in that account.

## 2. Prepare the config

- `npm ci && npm test && npm run typecheck`. **Verify:** everything is green; the tests use stubs and need no network or keys.
- Create `wrangler.toml` from `wrangler.example.toml` (it is gitignored). Set:
  - `name`: ask the owner, or default to `sarandip-casa`. Check that no Worker with this name already exists in the account. If one does and you did not create it, ask before overwriting.
  - `PUBLIC_BASE_URL`: you may leave it empty (the Worker then uses the request origin) or set `https://<name>.<subdomain>.workers.dev` so late-reply webhooks have a stable URL.
  - `ASSISTANT_NAME`, `DEVICE_KIND`: the owner's choice. Defaults `Sarandip` / `device`.
  - `WAKE_WORD`, `WAKE_DISPLAY`: must name the wake model the device firmware was built with. The public firmware default is `hey_jarvis` / `Hey Jarvis` (the example file's default); the other shipped models are `okay_nabu` / `Okay Nabu` and `hey_mycroft` / `Hey Mycroft`. These are labels: the device always uses its embedded model. A "Hey Sarandip" model is future work and not available yet; do not configure it.
  - `ELEVENLABS_VOICE_ID`: ask the owner. Offer to list voices with their key; voice ids are not secret. Leave it empty until they choose.
  - `LANGUAGE` (`en` or `pt-BR`) and `TTS_LANGUAGE_CODE`.
  - `TZ` (IANA, for example `America/Sao_Paulo` or `UTC`). Default in the example file is `UTC`.
  - `ROUTINE_PROVIDER = "off"` for now. It is switched on in step 7.

## 3. Deploy the Worker and the Durable Objects

- `npx wrangler deploy`, with `CLOUDFLARE_ACCOUNT_ID` set in the environment. This creates the Worker, the `DeviceHub` Durable Object, the `DeviceRegistry` Durable Object and the `FirmwareStore` Durable Object (SQLite classes, migration tags `v1` and `v2`).
- Alternative: deploy through the Cloudflare API or connector, using the same script and bindings. Keep existing `secret_text` and Durable Object bindings if you replace the script.
- **Verify:** `GET <PUBLIC_BASE_URL or workers.dev URL>/health` returns `{"ok":true,"memory":"configured"}` with the default memory settings, or `"memory":"off"` if the owner already skipped memory. Device routes without a token return `401`.
- Re-running is safe: a deploy replaces the code, and the migration `v1` applies only once.

## 4. Generate internal secrets locally (the owner never sees them)

- **`REPLY_SECRET`:** at least 32 random bytes, encoded as base64url, generated locally (for example `node -e` with `crypto.randomBytes`). The endpoint stays closed if the secret is shorter than 16 characters. Pipe it straight into `npx wrangler secret put REPLY_SECRET`, without printing it. The Worker uses it to sign turn-scoped `reply_url` tokens, so a Grok Bot routine does not need this value at all. Agents that still call `/bloco/reply` with a Bearer header must keep it only in their secret store, never in a file in the repo, and never in routine or agent instruction text.
- **`ADMIN_TOKEN`:** the same kind of long random string. Pipe it into `npx wrangler secret put ADMIN_TOKEN`. You will use it to issue pairing codes and to read device status. Do not print it.
- **Device code (devices that ship with their own code; nothing to issue):** the device's setup page checks the code printed on its card, then pairs with the server URL the owner types, sending `claim:"device"` and a device secret. The server enrolls it on first use (`PROTOCOL.md` §2.2). Before the owner pairs, ask for the device id shown at the top of the device's setup page (`sc-` + 12 hex) and set `CLAIM_DEVICE_IDS = "sc-…"` in `wrangler.toml` (then deploy), so only that device can claim this server. If the owner cannot read it yet, the default `CLAIM_MODE = "first"` accepts only the first device; tell the owner to pair soon after the deploy. Never ask for, print or store the device code.
- **Server-issued pairing codes (devices without their own code):**
  1. Choose a `device_id` matching `^[A-Za-z0-9_-]{1,64}$`, for example `dev_home01`, or let the device use the id it already has (chip-derived).
  2. `POST /v1/admin/pairing-codes` with `Authorization: Bearer <ADMIN_TOKEN>` and an optional `{"ttl_s":600}` for a short-lived code, or `{"device_id":"sc-…","permanent":true}` for a claim code that ships with the device (no expiry, bound to that device, reusable; re-POST rotates, `DELETE` revokes).
  3. Show the owner **only the pairing code** (and when it expires, if it does). Never the device token.
  4. The device calls `POST /v1/devices/pair` with `{pairing_code, device_id, fw_version}` and receives its token **once** per pair. The server stores only the hash. See `PROTOCOL.md` §2 (`/v1/devices/pair` is frozen; claim codes are an additive admin option) and `docs/device-setup.md`.
- **Legacy `DEVICE_TOKENS`:** only if pairing cannot be used. Hash a token with `node tools/token.mjs --hash-stdin <device_id>` (token on stdin, **hash only** on stdout) and store the JSON map with `npx wrangler secret put DEVICE_TOKENS`. Do not print the token. `DEVICE_TOKENS` is a fallback; the registry is the source of truth for paired devices.
- **Verify:** `npx wrangler secret list` shows the names `REPLY_SECRET` and `ADMIN_TOKEN`. It shows names only, never values.

## 5. Ask the owner for their API keys (protected field only)

Ask for these, one at a time, each in a masked or secure field:

| Secret | Where the owner gets it | Required |
|---|---|---|
| `XAI_API_KEY` | xAI console, API keys | yes |
| `ELEVENLABS_API_KEY` | ElevenLabs, API keys. Limit it to speech-to-text and text-to-speech if the console allows. | yes |

- Pipe each value directly into `npx wrangler secret put <NAME>`, or use the Cloudflare API or connector, without echoing it. Do not keep a copy.
- **Verify:** `wrangler secret list` shows the names. Then try one fast question (step 8). A wrong key shows up as a spoken failure; the logs carry only the error class.

## 6. Memory (the owner may skip this step)

Memory is a normal part of setup. It is **on by default** and points at the fictional example repository `luciocs/jarvis-memory-demo`. Anyone who talks to the device may hear what is in the configured memory.

**To skip:** set `MEMORY_ENABLED = "false"` and redeploy. `/health` then returns `"memory":"off"`. Stop here and continue to step 7.

**To keep the example memory:** tell the owner that the default is a short fictional profile in the public repository `luciocs/jarvis-memory-demo`, and that it is read without a GitHub token. No token is needed unless they later point memory at a private repository of their own.

**To use the owner's own repository:**

1. Give the privacy warning (rule 7) and get an explicit yes.
2. The owner creates or chooses a **dedicated** repository with an `Agent.md` file.
   - Default sections (configurable via `MEMORY_SECTIONS`): `## Quem sou`, `## Família` / `## Familia`, `## Tom e formato` / `### Tom e formato`, `## Perfil resumido`.
   - Lines with secret-like words are dropped, and the text is capped at `MEMORY_MAX_CHARS` (1400).
3. If that repository is **public**, do not ask for a GitHub token.
4. If it is **private**, the owner creates a fine-grained GitHub token:
   - Repository access: *Only select repositories*, that one repo.
   - Permissions: *Contents: Read-only*.
   - The shortest practical expiry.
   - They paste it into a protected field, and you store it as `GITHUB_TOKEN`.
5. Set `MEMORY_ENABLED = "true"`, `MEMORY_REPO="<owner>/<repo>"` and, if needed, `MEMORY_PATH`, `MEMORY_REF` and `MEMORY_SECTIONS`, then redeploy.
6. **Verify:** `/health` returns `"memory":"configured"`. Ask a question answered by the memory, such as "how do I like you to talk to me?".
7. **Turning it off later:** set `MEMORY_ENABLED=false` (confirm first). If a `GITHUB_TOKEN` was stored and is no longer needed, ask before deleting it. Then check that `/health` says `"memory":"off"`.

## 7. Connect the owner's agent (the owner may skip this step)

The server forwards questions it cannot answer quickly to an agent. Skip this step if the owner only wants fast answers: leave `ROUTINE_PROVIDER = "off"`.

The agent answers later with `POST <PUBLIC_BASE_URL or origin>/bloco/reply`.

**Webhook request sent by the server** (`ROUTINE_PROVIDER = "webhook"`):
- `POST <WEBHOOK_URL>` with `Authorization: Bearer <WEBHOOK_TOKEN>` and a JSON body. That is the header a Grok Bot routine webhook expects. If a different agent needs another header, set the optional var `WEBHOOK_AUTH_HEADER` to that header name; the Worker then sends the raw token in it.
- The body has these fields: `text`, `turn_id`, `device_id`, `spoken_at` (ISO UTC), `timezone`, `local_date`, `weekday`, `local_time`, `utc_offset`, `local_datetime`, `source` (`DEVICE_KIND`), `context`, `reply_url`, and `reply_auth` (`"url"` when `reply_url` carries a turn-scoped token).
- The webhook counts as accepted on **any HTTP 2xx**. Only the acknowledgement is awaited.

**The agent's reply:**
- `POST` the exact `reply_url` from the payload with the body `{"turn_id":"t_…","device_id":"…","text":"<≤500 chars, plain spoken text>"}`. When `reply_auth` is `"url"`, the URL already carries a short-lived token (`?t=…`) valid only for that turn and device; no `Authorization` header is needed.
- Agents that do not use the signed URL may instead `POST /bloco/reply` with `Authorization: Bearer <REPLY_SECRET>`. During rotation, `REPLY_SECRET_PREVIOUS` is also accepted, including for tokens signed with the previous secret.
- The `turn_id` (and the URL token) is valid for `REPLY_TTL_S` seconds, and a turn is delivered at most once.
- Responses: `200 delivered`, `503 offline`, `409 muted` or `already_delivered`, `404 unknown_turn`, `410 expired`, `400` bad request, `502 tts_error`.

### 7a. Grok Bot routine (webhook)

1. In Grok Bot, create a routine (for example "Sarandip late answer") with a **webhook trigger**.
2. Write its instructions. The routine should:
   - read the JSON body;
   - answer `text` using the owner's tools and the provided local date and time;
   - keep the answer short, spoken-style and without markdown;
   - `POST` the exact `reply_url` with the JSON body `{turn_id, device_id, text}`. When `reply_auth` is `"url"`, do not add an `Authorization` header: the URL already carries its own short-lived, turn-scoped authorization.
3. **Never put any secret value in the routine instructions.** The `reply_url` carries its own short-lived authorization, so no secret goes into the routine.
4. The routine panel shows the **webhook URL and key**. The panel's `header` field is the full `Authorization: Bearer <key>` line. Ask the owner to paste the URL and key into protected fields, then store them as `WEBHOOK_URL` and `WEBHOOK_TOKEN`. The Worker sends `Authorization: Bearer <WEBHOOK_TOKEN>` by default.
5. Set `ROUTINE_PROVIDER = "webhook"` and redeploy.

### 7b. Other agents

- Any HTTPS endpoint that accepts the webhook request above and calls `/bloco/reply` works: n8n, Make, a small server, OpenClaw (configure it as a generic webhook), or another agent platform.
- Native connectors: set `ROUTINE_PROVIDER = "openai"` (OpenAI-compatible; `OPENAI_BASE_URL`, `OPENAI_MODEL`, secret `OPENAI_API_KEY`) or `ROUTINE_PROVIDER = "anthropic"` (`ANTHROPIC_MODEL`, secret `ANTHROPIC_API_KEY`). The Worker calls the API after the spoken acknowledgement and delivers the answer as a late reply.

**Verify:** run the simulated hand-off in step 8.

## 8. Tests

1. **Health:** `GET /health` returns `200 {"ok":true,...}`.
2. **Auth:** `GET /bloco/config` without `X-Device-Token` returns `401`. After pairing, with the token (do not print it) it returns `200`, with `"protocol":"sarandip-ws-1"` and `"ambient_listen":"off"`.
3. **Simulated voice turn:**
   - Use `tools/live-turn.mjs <base_url> <question.wav>`, with the token in the env var `DEVICE_TOKEN`. Never type the token on the command line, where it would land in shell history.
   - The WAV must be PCM16, mono, 16 kHz, for example "what day and time is it?".
   - **Verify:** the answer gives today's date, weekday and time in the configured time zone. Compare with the `local_now` the tool prints (it uses `TZ` and `LANGUAGE` from the environment, default `UTC` / `en`).
4. **Local smoke test without keys:**
   - `npx wrangler dev --local -c wrangler.example.toml` with a `.dev.vars` file that sets every `*_PROVIDER="stub"`.
   - Run `node tools/smoke-device.mjs 127.0.0.1 <port> <token> <reply_secret>`, using throwaway local values only.
5. **Hand-off,** if step 7 is done:
   - Ask something that needs the agent, for example "what is my next calendar event?".
   - **Verify:**
     - the response carries the header `X-Sarandip-Late-Reply: 1` and the spoken "on it" message;
     - a WebSocket client receives `hello_ack`, then `tts_start`, binary PCM16 at 16 kHz, and `tts_end` for the same `turn_id`;
     - `/bloco/reply` answers `200 delivered`.
6. **Time zone:** in tests, or in a temporary deploy, set a different `TZ` and check that the spoken answer and the `timezone` and `local_time` fields of the webhook payload change accordingly.

## 9. Pair the device

The owner-facing steps live in the firmware package: `../sarandip-casa-firmware/docs/device-setup.md` (source of truth; `docs/device-setup.md` here keeps only the server side). With the owner:
1. Give the owner the server URL (`https://...`). A device with its own code (printed card) needs nothing else: the owner types that code on the device, and the device claims this server (set `CLAIM_DEVICE_IDS` first, see step 4). Only for a device without its own code: create a pairing code (`POST /v1/admin/pairing-codes`, default 10 minutes) and give the owner **only the code**. Never the token.
2. The owner powers the device. On first boot the ring breathes blue and the device opens the **open** Wi-Fi network `Sarandip-Setup` (no password, by design). The owner joins it; the setup page opens by itself (or `http://192.168.4.1`).
3. The owner picks the home Wi-Fi (2.4 GHz), types its password, the device code (or the pairing code) and, under "Advanced", the server URL unless the firmware build prefilled it.
4. The page shows "Saved" (green ring, the device restarts) or a clear error: wrong code (checked by the device, with a lockout after 5 tries), wrong Wi-Fi password, network not found, no internet time, server not accepting new devices (`403 claim_closed`: fix `CLAIM_DEVICE_IDS` / `CLAIM_MODE`), code not found (`404`), code expired or used (`410`), too many attempts (`429`), server unreachable.
5. **Verify:**
   - `GET /v1/devices/status?device_id=<id>` with `Authorization: Bearer <ADMIN_TOKEN>` returns `"online": true` once the device has opened the WebSocket and sent `hello`. The device id is `sc-` followed by the Wi-Fi MAC in hex (12 characters);
   - the owner says "Hey Jarvis" (or the wake word of their build), or uses the button / wrist pad, and gets a spoken answer.

Do not flash anything. If the device does not run the Sarandip Casa firmware yet, stop and tell the owner.

### 9a. Welcome audio (optional)

The welcome plays once on the first connection after pairing. Default: `WELCOME_MODE = "tts"` with the default line for `LANGUAGE`. Ask the owner whether they want the default line, their own text (`WELCOME_TEXT`), their own clip, or nothing (`WELCOME_MODE = "off"`).

- Own clip: convert it to WAV PCM16 mono 16 kHz (`ffmpeg -i in.mp3 -ac 1 -ar 16000 -c:a pcm_s16le welcome.wav`, at most about 32 s), set `WELCOME_MODE = "audio"`, redeploy, and upload it with `curl -X PUT --data-binary @welcome.wav -H "content-type: audio/wav" -H "authorization: Bearer $ADMIN_TOKEN" <base>/v1/admin/welcome-audio` (read `ADMIN_TOKEN` from the environment; never print it). Only use audio the owner has the right to use; keep the clip out of any repository.
- **Verify:** `GET /v1/admin/welcome-audio` (admin) shows `present: true` and the duration. To replay: `POST /v1/admin/devices/welcome` with `{"device_id":"…"}`.

## 10. Rotation, revocation, rollback

- **Rotate an API key:** the owner creates a new key at the provider. You store it with `wrangler secret put` (it takes effect without a code change), then the owner revokes the old key.
- **Rotate `REPLY_SECRET`** (per owner, not per device):
  1. Confirm with the owner first.
  2. Generate the new value and update the agent's copy first.
  3. Put the new value in `REPLY_SECRET` and the previous value in `REPLY_SECRET_PREVIOUS`.
  4. After late answers that still use the old value have finished (up to `REPLY_TTL_S`), delete `REPLY_SECRET_PREVIOUS`.
- **Revoke a device:** `POST /v1/admin/devices/revoke` with `ADMIN_TOKEN` and `{"device_id":"…"}` (confirm first). If a legacy `DEVICE_TOKENS` entry exists, remove it from that secret too. The next request gets `401`. Device NVS is not encrypted (decided), so revocation is the mitigation for a lost or stolen device. To re-pair, the owner reopens the setup portal: flip the case mute switch 5 times within about 5 seconds and leave it for 3 seconds (ring blinks blue), or hold BOOT (inside the case) for about 10 seconds and release; and the owner types the device code (or a new short-lived code); re-pairing the same `device_id` invalidates the previous token. A revoked device that was claimed with its device code can pair again with the same code and device secret; to block that too, also `DELETE /v1/admin/claims` with `{"device_id"}` and keep `CLAIM_MODE`/`CLAIM_DEVICE_IDS` closed. Revoke or rotate an admin claim code with `DELETE` / re-issue on `/v1/admin/pairing-codes`.
- **Factory reset (device):** flip the mute switch 10 times within about 10 seconds and leave it for 3 seconds (ring turns red), or hold BOOT for about 25 seconds (ring blinks red) and release. It erases Wi-Fi, server URL and token on the device; the device code and device secret stay, so the same card works again. Before the device changes hands, revoke it and forget its claim on this server (`DELETE /v1/admin/claims`), so the new owner's server can claim it.
- **Firmware updates:** HTTPS OTA after the device has been flashed once with an OTA-capable image (0.1.2-dev or later). Upload the **app** `firmware.bin` (not `firmware.factory.bin`) with `PUT /v1/admin/firmware?channel=…` and `X-Sarandip-Firmware-Version`, then `POST /v1/admin/firmware/push` with the `device_id`. The helper `/home/box/secrets/ota-push-luva-gui.sh` (or `node tools/ota-push.mjs`) does this. Do not flash or OTA the owner's device without them present. Set `FIRMWARE_SIGNING_KEY` (PKCS#8 PEM of the official P-256 key) with `wrangler secret put` so the Worker signs images the official firmware will accept.
- **Turn memory or the agent off:** see steps 6 and 7. `ROUTINE_PROVIDER="off"` disables hand-off. `MEMORY_ENABLED=false` disables memory.
- **Roll back code:** `npx wrangler rollback`, or `wrangler deployments list` and then `wrangler rollback <id>`. Confirm first. Secrets are not rolled back.
- **Remove everything:** `npx wrangler delete <name>`. Confirm explicitly, because this deletes the Durable Object data. Then the owner revokes the API keys and any GitHub token at the providers.

## 11. Report to the owner

Give a short summary:
- the Worker URL;
- what is configured, as set or missing, never values;
- whether memory is on or off, and whether it is the example repository or the owner's;
- whether an agent is connected, and which provider;
- the test results;
- what remains.

No secret values.
