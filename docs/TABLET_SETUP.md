<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Setting up a kiosk tablet

You need: an Android tablet (Android 8 / API 26+), on the **same network** as your
OpenMasjidOS, with **outbound internet** (the reader talks to Stripe directly). A wall
mount that keeps it **plugged in** is strongly recommended.

## 1. Install the app
1. On the tablet's browser, open your kiosk's setup page: **`https://<your-server>:<port>/new`**
   (find the address by pressing **Open** on the Kiosk app in OpenMasjidOS).
2. Tap **Download the kiosk app**, allow "install from this source" when asked, and open
   the downloaded file to install **OpenMasjid Kiosk**.

## 2. Pair it
1. In the admin panel, go to **Devices → Add kiosk** — you'll get a **6-digit code** (valid
   10 minutes). No camera or QR needed.
2. Open the kiosk app on the tablet, type the **server address** and the **6-digit code**,
   and tap Pair. The app pins the server's certificate on this first connection
   (trust-on-first-use) and won't talk to anything else afterward.
3. The kiosk appears in **Devices** with live status (battery, charging, reader, version).

## 3. Lock it down (kiosk mode)
The app runs as the tablet's **home screen**. For a *fully* locked-down kiosk (no status
bar, no way out but the PIN), provision it as **device owner** — a one-time step on a
**factory-reset** tablet with **no Google or other accounts added**:

```
adb shell dpm set-device-owner org.openmasjidos.kiosk/.KioskAdminReceiver
```

The app then enters true **Lock Task Mode** automatically. Without device-owner it falls
back to **screen pinning** (a one-time system confirmation) + full-screen immersive mode —
the maintenance screen shows a banner when the tablet isn't fully locked down.

Set the **exit PIN** in **Devices** (Admin) — staff type it (10 taps in the top corner →
PIN pad) to reach the maintenance screen. The PIN is verified on the tablet even if the
network is down.

## 4. Keep it running
- Keep the tablet **plugged in**; the Devices page flags "not charging".
- It relaunches after a reboot and self-heals after a crash.
- **To move it to another server or after revoking:** open the maintenance screen (10 taps →
  PIN) → **Re-pair**.

### Removing the kiosk
Revoke it from **Devices** (the tablet returns to the pairing screen). To fully leave
kiosk mode on a device-owner tablet you must remove device-owner:

```
adb shell dpm remove-active-admin org.openmasjidos.kiosk/.KioskAdminReceiver
```

(“Exit kiosk” in the maintenance screen stops the lock, but while this app is the only home
launcher the system relaunches it — install another launcher or remove device-owner to
fully exit.)
