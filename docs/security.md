# Security notes

Server-side security (secrets, hashed device tokens, logs) is described in `README.md` (Privacy) and
`PROTOCOL.md` §2-3. This file records the **device-side decisions** that affect how this server is operated.
Full firmware details: `../sarandip-casa-firmware/docs/security.md`.

## Decisions (Lucio, 20/11/2026)

1. **Setup network is open.** `Sarandip-Setup` has no WPA2 password. It exists only while setup mode is
   open (first boot, factory reset, or the owner's gesture: 5 quick mute-switch flips or BOOT held 10 s; never automatically on a Wi-Fi outage),
   accepts at most 2 clients, and the microphone is off meanwhile. Accepted risk: someone nearby, at that
   moment, could see the Wi-Fi password and the single-use, short-lived pairing code.
2. **Public default wake word is `okay_nabu` ("Okay Nabu").** No project-specific model is trained for now.
   `WAKE_WORD` / `WAKE_DISPLAY` default to `okay_nabu` / `Okay Nabu`.
3. **Device token in NVS without encryption.** No eFuse burning and no flash encryption. Someone with
   physical USB access to the device can read the token and the Wi-Fi password. **Mitigation: revoke the
   device on this server** (`POST /v1/admin/devices/revoke`, or re-pair the same `device_id`, which
   invalidates the previous token). The server stores only the SHA-256 of each token.
4. **Factory reset** is holding BOOT for **25 seconds** (BOOT is inside the case), or, from outside, flipping
   the mute switch 10 times within about 10 seconds and leaving it for 3 seconds. It erases Wi-Fi, server URL and token on the
   device; revoke the device on the server as well before it changes hands.
5. **Adafruit NeoPixel (LGPL-3.0)** is approved as a firmware build dependency. This server does not use it.

## Other device facts the operator relies on

- No OTA and no remote wake models: the server cannot push code or model bytes to the device.
- The device sends its token only over TLS (public CA bundle) to the server it was paired with; a
  `sarandip_base` value in `/bloco/config` cannot redirect it.
