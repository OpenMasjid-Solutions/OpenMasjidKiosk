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
PIN**. Staff reach the maintenance screen by tapping the giving screen's background **10 times
within 3 seconds** (anywhere that isn't a button) → the PIN pad. The PIN is verified on the
tablet even if the network is down, so guard it.

**Then work down the checklist on the tablet — no computer:**

Open the maintenance screen (10 taps on the background → PIN) and find
**Permissions & lockdown**. It lists everything the kiosk asks the tablet for, whether each
one is currently set, and a button that opens exactly the right dialog or settings page. Work
down it until it reads *"n of n set"*. It covers:

| Item | What it's for |
|---|---|
| Install apps from this kiosk | So the kiosk can **update itself** — it downloads the new version from your own server and hands it to Android. Android calls this "install unknown apps". |
| Nearby devices (Bluetooth) | Finding a Stripe Reader M2 wirelessly. Skip it for a USB reader. |
| Location access | Stripe's reader software requires it before it will look for **any** reader, USB included. It is never used to track the tablet. |
| Location turned on | The tablet's own location switch, needed alongside the permission. |
| Bluetooth turned on | Only for a wireless reader. |
| Home app | Home returns to the giving screen, and the kiosk restarts itself after a reboot. |
| Shade lock (Accessibility) | Optional backstop that shuts the notification shade if it's ever pulled down. |
| Full kiosk lock (device owner) | Status only — see the ADB step below. Not required. |

Each button steps the kiosk out of the way, opens the right screen, and picks the kiosk back up
when you return — so nothing has to be done twice. If a button needs a permission you haven't
granted yet (self-update is the usual one), granting it and coming back finishes the job rather
than starting over.

**The app no longer uses Android's screen pinning.** It was only ever there to block the Back,
Home and Recents buttons, which hiding the navigation bar (below) does properly. Pinning also
stopped a pinned app from opening *any* other app, silently — so Android Settings, the permission
prompts and the self-updater all looked broken from the tablet. If you previously turned on
"Screen pinning" or "Ask for PIN before unpinning" in **Settings → Security**, you can leave them
on or off; the kiosk ignores both.

**Hiding the two system bars.** The maintenance screen states this too:

- **Bottom navigation bar** — **Settings → Display → Navigation bar** (or **System → Gestures**)
  → choose **Gesture navigation** / **Swipe gestures**. That removes the Back, Home and Recents
  buttons. Naming is OEM-specific; some tablets add a pin icon that keeps the bar hidden.
- **Top notification bar** — Android gives an ordinary app **no way** to remove this, and no
  tablet setting hides it. The shade lock closes it the moment it is pulled down. Removing the bar outright needs **device owner** (below), which the
  kiosk then does for you automatically.

That's a strong, self-contained kiosk with nothing but the tablet.

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

The app then enters true **Lock Task Mode** automatically — the only mode that makes the
notification shade genuinely unreachable.
This is optional — the soft-kiosk steps above are enough for most masjids.

## 4. Keep it running
- Keep the tablet **plugged in**; the Devices page flags "not charging".
- It relaunches after a reboot and self-heals after a crash.
- **To move it to another server or after revoking:** open the maintenance screen (10 taps →
  PIN) → **Re-pair**.

### Getting out of kiosk mode

There are two ways out, and both keep working on a device-owner tablet:

1. **Paired kiosk** — 10 taps on the giving screen → **exit PIN** → **Exit kiosk**. This is the
   normal route and needs the PIN you set in **Devices**.
2. **Unpaired tablet** — the setup screen is deliberately **never locked** and carries a plain
   **Exit and leave setup** button. Until a kiosk is paired there is no configuration, no donor
   flow and no exit PIN to check, so withholding an exit would protect nothing and would strand
   a tablet that was never paired (or one you have just revoked) with no way back short of ADB.

So **revoking from Devices is a complete remote undo**: the tablet drops to the setup screen,
releases its lock, and can be handed back or re-paired from there.

To remove device-owner altogether (the tablet stops being a managed device):

```
adb shell dpm remove-active-admin org.openmasjidos.kiosk/.KioskAdminReceiver
```

Note that this app registers as a home launcher, so after **Exit kiosk** the system may reopen
it if it's the only launcher installed — the exit sends you to the Home-app picker so you can
choose another one.
