# Device setup: server side

**Source of truth for the owner steps:** the firmware package, `../sarandip-casa-firmware/docs/device-setup.md`
(sibling directory today; it becomes the firmware repository's `docs/device-setup.md` when published). It
covers the setup network, the setup page, error messages, the setup gestures (mute switch and BOOT) and the NVS layout. This file
keeps only what the server operator (or the owner's agent) needs, and must not contradict it.

## Summary of the device flow (decided 20/11/2026)

- On first boot (or after a factory reset, or when the owner reopens setup) the device opens the
  **open** Wi-Fi network **`Sarandip-Setup`** (no password, by design) and a setup page at
  `http://192.168.4.1`. The microphone is off during setup.
- The owner enters the home Wi-Fi (2.4 GHz), its password, the **pairing code** and, if not prefilled by the
  firmware build, the server URL (`https://...`).
- **Reopen setup:** flip the case mute switch **5 times within about 5 seconds** (ring blinks blue), then
  leave it alone for 3 seconds. Alternative: hold BOOT (inside the case) for about 10 seconds and release.
- **Factory reset:** flip the mute switch **10 times within about 10 seconds** (ring turns red), then leave it
  alone for 3 seconds. Alternative: hold BOOT for about **25 seconds** (ring blinks red) and release.
  An 11th flip cancels. The mute switch always keeps muting (closed = muted).
- Wake word: the public firmware default is **"Hey Jarvis"** (`hey_jarvis`); `okay_nabu` and `hey_mycroft`
  are build-time alternatives. Set `WAKE_WORD` / `WAKE_DISPLAY`
  to the model of the owner's firmware build.
- The device token is kept in the device's NVS **without encryption**. The mitigation for a lost, stolen or
  given-away device is **revoking it on this server** (below).

## Server steps

1. **Create a pairing code** (admin):
   `POST /v1/admin/pairing-codes` with `Authorization: Bearer <ADMIN_TOKEN>`, optional `{"ttl_s":600}`.
   The response `pairing_code` (`XXXX-XXXX`, single use, default 10 minutes) is the only thing the owner
   sees. Never show or send the device token.
2. **The device pairs** with `POST /v1/devices/pair` `{pairing_code, device_id, fw_version}` and receives
   `{device_id, token, base_url, ws_url, tz}` once (`PROTOCOL.md` §2). Device ids are `sc-` + the Wi-Fi MAC
   in hex. Errors the device shows to the owner: `404` code not found, `410` expired or used, `429` too many
   attempts (`PAIR_RATE_MAX` / `PAIR_RATE_WINDOW_S`).
3. **Check status:** `GET /v1/devices/status?device_id=<id>` with the admin token. `"online": true` once the
   device opened the WebSocket and sent `hello` (`protocol: "sarandip-ws-1"`).
4. **Re-pair** (new owner, new server, or a lost token): the owner reopens setup (mute switch 5 flips, or BOOT
   about 10 seconds) and
   types a new code. Re-pairing the same `device_id` invalidates the previous token. Changing only the Wi-Fi
   needs no code: the device checks its saved token with `GET /bloco/config` before saving.
5. **Revoke:** `POST /v1/admin/devices/revoke` `{"device_id":"..."}` with the admin token. The device then
   gets `401`, shows one blinking amber LED and retries slowly until the owner reopens setup.

There is no OTA: firmware updates are a USB flash by the owner. The server cannot push firmware or wake
models to the device.
