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

## 3. Lock it down (kiosk mode) — no computer needed

**First, set the exit PIN.** In the admin panel go to **Devices** and set the kiosk **exit
PIN**. Staff reach the maintenance screen by tapping **the top corner 10 times** → the PIN
pad. The PIN is verified on the tablet even if the network is down, so guard it.

**Then harden the tablet itself — all on the tablet, no computer:**

1. **Make the app the Home screen.** Open the maintenance screen (10 taps → PIN) and tap
   **Set as Home app**, choosing OpenMasjid Kiosk. Now pressing Home returns to the kiosk.
2. **Turn on Screen pinning + a screen lock.** From the maintenance screen tap **Open tablet
   Settings (for Screen pinning)**, then:
   - **Security → Screen pinning** (some tablets: **App pinning**) → turn **ON**, and turn on
     **"Ask for PIN/pattern before unpinning."**
   - Set a **screen lock** (PIN or pattern) if the tablet doesn't have one.
3. **Turn on the shade lock (optional but recommended).** From the maintenance screen tap
   **Turn on shade lock (Accessibility)** and enable **OpenMasjid Kiosk — shade lock**. This
   accessibility helper closes the notification shade the instant it's pulled down while the
   kiosk is locked (it reads no screen content and does nothing when unlocked/unpaired). It's a
   backstop for the moments screen pinning isn't active.
4. Return to the kiosk. It now **pins itself**: the **notification shade is blocked**, the
   **Home/Recents buttons are blocked**, the **Back button does nothing**, and getting out by
   hand needs the device PIN. The app still opens the maintenance screen and exits normally
   behind **your** exit PIN.

**If your tablet supports it, also:** hide the navigation bar / use gesture navigation
(**Settings → Display / System → Navigation bar**), and turn off lock-screen notifications.
These are OEM-specific and optional — screen pinning already blocks the buttons — but they make
the lock cleaner on tablets that allow it.

That's a strong, self-contained kiosk with nothing but the tablet. The maintenance screen shows
a reminder with these exact steps until they're done.

**Updating the app** is now in-app: when an update is available, open the maintenance screen →
**Update app**. The tablet downloads the new version over the same secure connection and hands it
to the system installer — no browser, no leaving the kiosk. (You allow "install unknown apps" for
OpenMasjid Kiosk once, the same as the first install.)

### Even stronger (optional — needs a computer once)
For an *absolutely* un-leavable kiosk (the notification shade can't even be swiped in),
provision the tablet as **device owner** — a one-time step on a **factory-reset** tablet
with **no Google or other accounts added**:

```
adb shell dpm set-device-owner org.openmasjidos.kiosk/.KioskAdminReceiver
```

The app then enters true **Lock Task Mode** automatically (no screen-pinning setup needed).
This is optional — the soft-kiosk steps above are enough for most masjids.

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
