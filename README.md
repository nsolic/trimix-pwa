# Trimix Analyzer PWA

Web Bluetooth client for the ESP32-C6 Trimix Analyzer. Installable on
Android (Chrome / Edge). iOS Safari does not implement Web Bluetooth — use
this on Android, or fall back to the WiFi captive-portal UI.

## Phase 3 scope

- Connect via Web Bluetooth and stream the live snapshot at 1 Hz.
- Authenticate with the device password (default `trimix123`) using
  challenge-response — the password never leaves the phone.
- Trigger an O₂ 1-point calibration (opcode `0x01`).

History/dives/OTA are intentionally not handled here yet — Phase 4 wires
them up over WiFi with a “switch to WiFi” banner when on BLE.

## Run locally

Web Bluetooth requires a secure context. Localhost counts as secure, so:

    cd pwa
    python -m http.server 8000
    # open http://localhost:8000 in Chrome on Android (or desktop) with
    # the device powered up and advertising "Trimix-Analyzer".

For phone testing, use Chrome DevTools → Remote devices, or expose the
local server via `adb reverse tcp:8000 tcp:8000` then load
`http://localhost:8000` on the phone.

## Deploy

Any HTTPS static host works (GitHub Pages, Netlify, Vercel, Cloudflare
Pages). Push the contents of `pwa/` to the host of your choice. Web
Bluetooth is gated on HTTPS in production.

## Wire format

UUIDs and binary layout live in [main/ble/ble_uuids.h](../main/ble/ble_uuids.h)
and [main/ble/ble_live.h](../main/ble/ble_live.h). The JS side mirrors
them in `transport-ble.js` — keep both in sync if either changes.
