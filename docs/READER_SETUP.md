<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Setting up the card reader (Stripe Reader M2)

The kiosk takes payments with a **Stripe Reader M2**, connected to the tablet over **Bluetooth**
or **USB**. All of this is done from inside the kiosk app's **maintenance screen**, which is
protected by the exit PIN — donors never see any of it.

> **Before you start**, an admin must finish **Payments** setup in the OpenMasjidOS admin panel
> (Settings → Payments): pick your Stripe account and create/choose a **card-reader location**.
> The reader can't connect without a location, and the kiosk will tell you so.

---

## 1. Get the reader ready

- **Charge it.** Hold the M2's power button until the light comes on.
- **Bluetooth:** just power it on and keep it within a meter of the tablet. No pairing in Android
  Settings — the kiosk app finds it directly.
- **USB:** plug the M2 into the tablet with a USB-C/USB cable. Android will ask for permission to
  use the USB device the first time — tap **OK**.

## 2. Open the maintenance screen

1. On the kiosk's giving screen, tap the background **10 times** within 3 seconds (anywhere that
   isn't a button).
2. Enter the **exit PIN** (set in the admin panel, Devices → this kiosk).
3. You're now on the maintenance screen. Find the **Card reader** section.

## 3. Connect

1. **A USB reader needs nothing here — plug it in and it connects itself.** The rest of this
   section is for a **Bluetooth** reader, which is the only option the picker offers.

   (There is no three-way "Bluetooth / USB / Test reader" chooser; this step used to describe one.
   USB connects on its own, and the simulated reader was taken out of the shipped app — it is a
   development tool, and a "Test reader" button on a wall kiosk is a way for a real donation to be
   silently not taken. Simulated readers are still available in local development.)

   **No reader at all?** The kiosk offers typed card entry automatically. Donations keep working.
2. Tap **Find a reader**. The first time, Android asks for Bluetooth/Location permission — allow it
   (Location must also be turned on in the tablet's quick settings; the SDK needs it to scan, even
   for a USB reader).
3. When your reader appears, tap **Connect**.
4. If the reader needs a firmware update, the app installs it automatically — **keep it powered and
   nearby**; this can take a few minutes. Don't unplug it.
5. Once it says **Reader connected**, you'll see its battery level. Tap **Return to kiosk**.

The reader stays connected and reconnects automatically if it briefly drops out. Its status,
serial and battery show on the **Devices** page in the admin panel so you can spot a flat or
disconnected reader remotely.

---

## Troubleshooting

- **"Finish Payments setup…"** — set your Stripe account **and** a card-reader location in the admin
  panel first (Settings → Payments).
- **No readers found (Bluetooth)** — make sure the M2 is on and charged, that the tablet's
  **Location** is turned on, and that you granted the Bluetooth permission. Move it closer.
- **No readers found (USB)** — reseat the cable and accept the Android USB permission prompt. Some
  cheap cables are charge-only; use a data cable.
- **Keeps disconnecting** — charge the reader; a low battery drops the connection. Keep it within a
  meter for Bluetooth.
- **Reader problem / won't connect** — disconnect, then find and connect again. If it still fails,
  restart the reader (hold power ~8 seconds) and retry.

---

## What the tablet can and can't see

The tablet **never** handles card numbers and **never** holds your Stripe secret key. The reader
encrypts card data and sends it straight to Stripe. The tablet only ever receives a short-lived
**connection token** (fetched by the server) and the payment's client secret — never a card number,
never a secret key. See the project README for the full security posture.
