# Device setup (captive portal)

> The **server** pairing contract (`POST /v1/admin/pairing-codes` and `POST /v1/devices/pair`) is implemented and frozen in `PROTOCOL.md` §2. The **captive portal in firmware** is not implemented yet; sections marked TODO are the spec for that work. Until the portal exists, Wi-Fi, server URL and device token may still be compiled into the firmware (`secrets.h`), and changing them means re-flashing over USB — only with the owner's explicit approval.

## For the owner

You need:
- your server running (see `AGENT.md` or the README);
- the **pairing code** your agent or server gave you;
- your home Wi-Fi name and password (2.4 GHz; the ESP32-S3 does not support 5 GHz).

1. **Power the device.** On first boot, or when it has no saved Wi-Fi, it opens its own Wi-Fi network, **`Sarandip-Setup`**. The light ring shows setup mode (TODO: define the pattern).
2. **Connect your phone or computer to `Sarandip-Setup`.** The setup page should open by itself. If it does not, open a browser and go to `http://192.168.4.1` (the ESP32 SoftAP default; TODO: confirm).
3. **On the setup page:**
   - choose your Wi-Fi network from the list, or type its name;
   - type the Wi-Fi password;
   - type the **pairing code**;
   - tap **Save**.
4. The device leaves setup mode, joins your Wi-Fi and pairs with your server. The page shows success or a clear error, such as a wrong Wi-Fi password, an invalid or expired code, or an unreachable server. On error, setup mode stays open so you can try again.
5. **Test it:** say the wake word and ask "what time is it?".

**Reopen setup** (new Wi-Fi, new server, or a new owner): **hold the device button for about 10 seconds** until the ring shows setup mode. The device keeps its old settings until new ones are saved successfully.

**Privacy reminders:**
- The device listens only after the wake word or the button.
- The mute switch stops all capture.
- The setup network is open only while setup mode is active.

## Firmware notes (TODO for implementation)

Base: firmware profile `0.7.7`. Today `WIFI_SSID`, `SARANDIP_TOKEN`, `SARANDIP_DEVICE_ID` and `SARANDIP_BASE_DEFAULT` come from `secrets.h`, the base URL can also come from the last-good value in NVS, and there is no OTA. `/bloco/config` does not send a `sarandip_base` override.

### Setup mode
- **Entry:**
  - no Wi-Fi credentials in NVS;
  - the button held for about 10 seconds at runtime (TODO: which button, the push-to-talk BOOT button on GPIO0 or another);
  - optionally, Wi-Fi failing for a long time. TODO: decide; it must never make a device stuck on a flaky network expose an open AP without the owner's intent.
- **Mute switch:** it must keep its meaning (pressed = muted) and must **not** be the setup trigger.
- **SoftAP:** SSID `Sarandip-Setup`, optionally with a short device suffix to tell devices apart (TODO: decide). Open network, or WPA2 with a printed password (TODO: decide).
- **Captive portal:**
  - a DNS server that answers every name with the AP IP;
  - an HTTP server that answers the OS captive-portal probes (Android `generate_204`, Apple `hotspot-detect.html`, Windows `connecttest.txt`) with a redirect, so the page opens automatically.
- **Page:** a single static HTML page, no external assets, in the device language. It holds the Wi-Fi scan list with a manual SSID field, the password field, the pairing code field, and an advanced field for the **server URL** (`https://` only; it may be prefilled if the code encodes it, see below).
- **Microphone:** while in setup mode, the mic, the wake word and the WebSocket are off.
- **Timeout:** leave setup mode after a period of inactivity (TODO: duration), if valid credentials exist.

### Pairing
- On Save:
  1. Join the Wi-Fi.
  2. Sync NTP, which TLS needs.
  3. Call `POST <server>/v1/devices/pair` with `{pairing_code, device_id, fw_version}` (implemented; see `PROTOCOL.md` §2).
  4. Receive the device token **once**.
  5. Store the Wi-Fi credentials, server base and token in NVS (namespace per profile). Use NVS encryption if feasible (TODO: evaluate flash-encryption impact).
- **Server URL:** TODO, decide how the device learns it. Options:
  - the owner types it on the page;
  - the pairing code also encodes or looks up the server (this needs the central admin from the architecture proposal);
  - it is prefilled at flashing time.
- **Device id:** derived from the chip MAC or generated at first boot and kept in NVS. Never secret.
- **Failure:** keep the previous working configuration (Wi-Fi, base, token) until the new one is verified, then switch atomically.
- **Factory reset:** a separate gesture (TODO), which clears Wi-Fi, token and base.

### Security
- No API keys ever on the device. The only credential is the device token.
- Never log the Wi-Fi password, the pairing code or the token over serial; log only "set" or "missing".
- TLS against the public CA bundle, as today; no insecure mode.
- After pairing, the existing protocol is unchanged: `X-Device-Token` on `/bloco/turn`, `/bloco/config` and `/bloco/wake-log`, and on the WS upgrade to `/v1/devices/stream`.

### Memory and heap
- The portal should run before the TLS sessions open, so it does not compete with them. The heap with two TLS sessions is estimated but **not measured on the board**; measure it with the portal code included.
