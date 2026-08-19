<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->
<p align="center">
  <img src="assets/Kiosk - rounded corners (1).png" alt="OpenMasjid Kiosk" width="280"/>
</p>

<h1 align="center"><b>OpenMasjid Kiosk</b></h1>

<p align="center">
  <a href="#the-giving-flow">Giving</a> |
  <a href="#tuition--school-fees">Tuition</a> |
  <a href="#campaigns--the-designer">Campaigns</a> |
  <a href="#payments--stripe">Payments</a> |
  <a href="#the-tablet">The tablet</a> |
  <a href="#install">Install</a> |
  <a href="#develop--build">Develop</a>
</p>

<div align="center">
  <a href="https://github.com/OpenMasjid-Solutions/OpenMasjidKiosk/releases">
    <img src="https://img.shields.io/github/v/release/OpenMasjid-Solutions/OpenMasjidKiosk?style=flat-square&color=blue" alt="Latest Release" />
  </a>
  <a href="https://github.com/OpenMasjid-Solutions/OpenMasjidKiosk">
    <img src="https://img.shields.io/github/stars/OpenMasjid-Solutions/OpenMasjidKiosk?style=flat-square&color=blue" alt="Stars" />
  </a>
  <a href="https://discord.gg/MpPDbyQfaF">
    <img src="https://img.shields.io/badge/Discord-Join-blue?style=flat-square&logo=discord" alt="Discord" />
  </a>
</div>

<h5 align="center">
Leave a star if you like the project! ⭐️
</h5>

---

**Turn an Android tablet and a [Stripe Reader M2](https://stripe.com/terminal) into a
beautiful tap-to-donate station for your masjid.** An app for
[OpenMasjidOS](https://github.com/OpenMasjid-Solutions/OpenMasjidOS).

A passer-by taps an amount, taps their card, and is thanked — in well under ten seconds,
with no instructions and nobody standing next to them. Behind it sits one admin page on
your OpenMasjidOS: run several appeals at once, take monthly giving, email receipts,
collect school fees, and manage a fleet of tablets across more than one site.

> **Status: v0.11.0 — running in masajid, actively developed.**
> See [`CHANGELOG.md`](CHANGELOG.md) for the full history.

---

## Contents

- [The giving flow](#the-giving-flow) · [Tuition & school fees](#tuition--school-fees)
- [Campaigns & the designer](#campaigns--the-designer) · [Kiosk-wide settings](#kiosk-wide-settings)
- [Payments & Stripe](#payments--stripe) · [Receipts, alerts & notifications](#receipts-alerts--notifications)
- [Ask the kiosk from WhatsApp](#ask-the-kiosk-from-whatsapp)
- [Donations & reporting](#donations--reporting) · [Recurring plans](#recurring-plans)
- [Devices & fleet management](#devices--fleet-management) · [The tablet](#the-tablet) · [Card readers](#card-readers)
- [Admin panel](#admin-panel) · [Security](#security) · [OpenMasjidOS integration](#openmasjidos-integration)
- [Install](#install) · [Requirements](#requirements) · [Develop & build](#develop--build)

---

## The giving flow

- **Boots straight into giving.** No attract screen to tap through — the tablet opens on
  your main appeal's amount grid.
- **Six one-tap amounts**, auto-sized to the screen and laid out for portrait or landscape,
  each with a "Donate" band.
- **"Choose your own amount"** — a big number pad with a minimum and maximum you set.
- **One-time or monthly**, as a toggle. Monthly is declined kindly when no reader is
  connected, since a reusable card can only come from a card-present tap.
- **The details step is skipped when it isn't needed.** A donor only sees name/email if you
  ask for them, if they chose monthly, or if the appeal offers fee-covering — otherwise it's
  amount → card in one tap.
- **Optional name and email**, each independently set to *off*, *optional* or *required*.
- **Cover the card fee.** Donors can add the estimated fee so the masjid nets the full gift. It
  is offered as a choice on one-time gifts. **Zakat appeals always cover it** — including monthly
  ones, where the grossed-up amount is what recurs, so the zakat arrives whole every month.
- **A gentler route for large gifts.** Above a threshold you set, the kiosk can suggest a
  cheaper alternative — your bank or Zelle details, with an optional QR image.
- **"Tap or insert your card"**, with live reader prompts and a "hold your card on the reader for
  at least 5 seconds" hint — the most common reason a good payment looks like a failure. (If a
  card can only be read by swiping, the reader says so itself.)
- **An on-screen pointer to your reader**, optionally: a pulsing contactless symbol with arrows,
  on whichever edge the reader is mounted — left, right, top or bottom — turning green when the
  payment goes through.
- **Typed card entry**, always available as a fallback and used automatically when a kiosk
  has no reader. The card goes into Stripe's own form inside the app — never a browser, so
  it works on a fully locked tablet — and is tokenised on the device.
- **A processing step, then a thank-you** naming the amount, using the message you wrote.
- **Fireworks**, optionally, above an amount threshold you choose — and skipped when the
  tablet has reduced-motion turned on.
- **Errors are never raw.** One warm line and a retry, with declines worded neutrally.
- **A donation is only ever celebrated after the server has verified it with Stripe.**
- **Abandoned donations reset themselves**, and the kiosk returns to the main appeal after
  45 seconds of no touches, shown as a silent countdown ring that any touch resets. It never
  interrupts a payment in progress.

## Tuition & school fees

If you also run [OpenMasjid Students](https://github.com/OpenMasjid-Solutions/OpenMasjidStudents),
any appeal can be a **Tuition** tile:

- A parent types their child's **Student ID** and confirms **"is this your child?"** by first
  name — a check that catches a mistyped ID, which the old PIN never did.
- The family account is shown **child by child**, each with their own balance, credit and
  bills — not one condensed list.
- They can pay the **whole balance**, **tick individual bills**, **tick individual lines
  within a bill** (the book fee but not the month's tuition), **type any amount**, or
  **add money for one named child**.
- **Pay ahead** when nothing is due, if the school allows it. The school holds it as that
  child's credit and takes it off the next invoice.
- The screen says what the account actually *is* — "Balance due", "£X paid ahead", or
  "Nothing due" — instead of showing an ambiguous zero.
- **A sibling's credit never blocks paying another child's bills**, and payments land on the
  **right child's ledger**.
- A **minimum payment floor** on every route, never below the school's own minimum.
- **Privacy timeouts**: an abandoned Student ID is wiped, and a family's balance can't stay
  on a wall indefinitely — there's a hard ceiling plus an always-available **Leave** button.
- **If the school passes on the card fee**, the kiosk says so before the card is taken: tuition, fee
  and total on separate lines, with a sentence explaining the fee is not the madrasah's and that
  paying at the office avoids it. It is **off unless the school turns it on**, the amount comes from
  the school (never a rate this app guesses), and the school's ledger is still credited the tuition —
  not the total. Cash and manual payments never attract one.
- It is recorded as a **payment, never a donation** — kept out of donation totals, receipts
  and year-end letters — and pushed to the school's ledger with a retry queue if the school
  app is briefly unreachable.
- The tile hides itself when the school app isn't there, and recovers on its own after a
  hiccup rather than getting stuck on "unavailable".

## Campaigns & the designer

Each appeal is its own tab across the top of the kiosk, with its own everything.

- **Multiple appeals** — General Fund, Zakat, Building Fund — reorderable, each live or
  hidden, with one always-shown **main** appeal.
- **A two-pane designer**, opening as a **full page in its own browser tab**, with a
  **true-to-device live preview** of both the portrait and landscape giving screens as you type.
  The address is shareable and survives a refresh, so several appeals can be compared side by side.
- **Design tab** — eight one-tap colour-theme presets, a primary and an accent colour (picker,
  or a typed **hex code** so a masjid can enter its exact brand colour; each resettable), and
  three image slots with upload: **background**, **cover** and **logo**.
- **Amounts tab** — up to six suggested amounts, custom-amount on/off with a minimum and
  maximum, and a monthly toggle.
- **Type & fees tab** — **Donation**, **Zakat** or **Tuition**. The type drives the fee rule
  automatically: Zakat always covers the fee, Donation makes it the donor's choice, Tuition
  leaves it to you.
- **Payments tab** — settle this appeal to a **different Stripe account**, with the card reader
  working there too: the kiosk moves the reader onto that account the moment someone donates to
  the appeal, so the first tap takes a few seconds longer and everything else is unchanged. If
  the reader can't be moved, the kiosk falls back to typed entry rather than failing the gift.
- **Kiosks tab** — target which tablets show this appeal (all of them by default).
- **Message tab** — a description and a per-appeal thank-you message.
- Text colour is **calculated from the background you actually chose**, so headings and small
  print stay readable on light, dark or strongly-coloured appeals.

## Kiosk-wide settings

Shared by every appeal:

- The **attract headline** and the **masjid name** shown on the kiosk.
- A **footer tagline** under the amounts.
- **Name policy** and **email policy** — off / optional / required.
- A default **thank-you message**.
- **Large-gift threshold**, the note to show, and an optional image (e.g. a bank QR code).
- **Fireworks** on/off and the amount threshold that earns them.
- **Force maximum screen brightness** — a wall kiosk should be as bright as it can be.
- **Per-kiosk screen rotation** (0° / 90° / 180° / 270°), set from the web, applied by the
  tablet itself so it works even on tablets that ignore orientation requests.
- The **kiosk exit PIN** (4–8 digits), set, rotated or removed here.

## Payments & Stripe

- **The Stripe account is picked from OpenMasjidOS**, not pasted here. Your keys live in the
  platform's vault; this app fetches them per process start and holds the secret key **in
  memory only**.
- **Standalone key entry** as a fallback when the platform isn't there, with live verification
  that Stripe accepts the key.
- **TEST MODE badge** whenever a test key is in use, and a **Test connection** button that
  proves Stripe *and* Terminal end to end by minting a real connection token.
- **Stripe Terminal Location** management — list existing locations or create one from your
  masjid address.
- **Currency** selection with correct minor units, including **zero-decimal** (JPY, KRW…) and
  **three-decimal** (BHD, KWD, OMR…) currencies.
- **Amounts are always validated server-side** against that appeal's presets and bounds — the
  tablet can never dictate a price.
- **Cover-fee is computed on the server**, not taken from the tablet.
- **Idempotency keys on every Stripe create**, so a network retry can't double-charge.
- **Capture-and-verify**: the server retrieves the PaymentIntent from Stripe, captures it, and
  records a donation only once Stripe says it succeeded.
- **Monthly giving** is set up from the card tapped on the reader — the first month is that
  tap, and the subscription's first automatic charge is one month later, never doubled. Plans are
  created as ordinary active subscriptions, not "free trials".
- **Refunds** from the Donations page — full or partial, with a Stripe reason, the donor emailed
  and the admin alerted. Every total is netted, so a refund stops counting the moment it is given.

## Receipts, alerts & notifications

- **Stripe's own email receipts** for any donor who gives an email.
- **A branded receipt designer** — your logo, your subject, heading and wording, an accent
  colour, and the amount/date/card/fund filled in automatically, with a live preview and a
  send-me-a-test button. It is escaped against injection and can never double-send.
- **A retry queue** for receipts, so a transient email failure still lands.
- **A refund note** to the donor, in the same branding, when you give a donation back.
- **A "your monthly donation is set up" email** carrying the donor's own cancel link.
- **Donation notifications** to your OpenMasjidOS dashboard.
- **Six admin alerts**: the **card reader goes offline** (debounced and latched, so a blip doesn't
  page you), a **payment can't be started**, a **monthly plan couldn't be set up** (the gift was
  taken once and nothing recurs — so somebody should tell the donor), a **donor stopped their
  monthly donation**, a **donation was refunded**, and a **test** you can fire from the app.

### Who gets told what — Settings → Notifications

The platform's own alert settings send everything to one address. A masjid usually needs more than
that: "the foyer reader is offline" should reach whoever walks past the foyer, while "a donation was
refunded" should reach the treasurer. So **each alert has its own row**, and can go to any
combination of three places — they are **additive**, and one failing never stops the others:

| Channel | Default | What it does |
|---|---|---|
| **OpenMasjidOS** | **on** | Forwards by email or webhook per your OpenMasjidOS alert settings — exactly as before. |
| **Also email** | off | A second address of your choosing, sent through your OpenMasjidOS email provider. |
| **WhatsApp** | **off** | A message to a number you enter. Needs WhatsApp set up in OpenMasjidOS. |

- **Nothing changes on upgrade** — every alert starts with OpenMasjidOS on and WhatsApp off.
- An alert with nothing switched on is badged **"goes nowhere"**, and WhatsApp switched on with no
  number is called out too, so a channel can't quietly stop reaching anyone.
- **Send test message** follows these same settings and names the channels it actually went by, so
  it proves your configuration rather than just that the server is up.
- A phone number must carry its **country code** (`+44 7700 900123`). Leaving it off is refused
  rather than guessed at — a guess would eventually message a stranger abroad — and a rejected
  number never overwrites the one already saved.

## Ask the kiosk from WhatsApp

A kiosk is unattended hardware in a lobby, and when the reader stops taking cards the person who can
fix it is usually not in the building. If your OpenMasjidOS has **WhatsApp admin commands** turned
on, message the masjid's own number with `!kiosk` and pick from the menu:

- **What's been given** — today, this week, this month and all time, after refunds, with the number
  of gifts and the average. With more than one kiosk it then offers a breakdown: **just reply with a
  kiosk's name** or "all" — no second command to remember. A name it doesn't know gets you the list
  and one more try.
- **Are the kiosks working** — every tablet: online or not, what its reader is doing, and its app
  version, led by a count of how many need attention.
- **The last few donations** — amount, time, kiosk and fund for the five most recent.

**Everything about this is deliberately narrow:**

- **Read-only.** Nothing can be changed from WhatsApp. That is what makes the follow-up question
  safe — the conversation can end without warning, and a question that only reads has nothing
  half-applied to leave behind.
- **No donor details, ever** — amounts, times, kiosks and funds only. No name, no email, no card. A
  WhatsApp thread keeps a copy forever on at least two phones.
- **Refused from the internet**, even with Remote access on. This is where your takings live, so it
  answers only on the masjid's own network.
- **Refused unless OpenMasjidOS issued this app its credential** — a server that isn't linked
  answers "not linked yet" rather than accepting an empty one.
- A failure can never put technical detail — a payment reference, a file path — into a message, and
  something slow answers "still working, ask again in a moment" rather than timing out silently.

**Donors are never messaged.** WhatsApp reaches only the numbers you typed into Settings →
Notifications. There is no phone field anywhere in the giving flow. And because messages go through
the masjid's own number, OpenMasjidOS paces them deliberately to protect it — delivery is seconds to
minutes, so it's for things worth interrupting someone about. Email stays the reliable channel.

## Donations & reporting

- **A full log** — amount, kiosk, time, one-time vs monthly, campaign, donor if given, and
  status, newest first, with a detail window per donation that can also **refund** it.
- **Totals** for today, this week, this month and all time, plus a **per-kiosk breakdown**, all
  **netted of refunds** so they show what the masjid actually kept. Refunded donations stay in
  the log, struck through and badged, rather than disappearing.
- **CSV export** of the entire history — including **Refunded**, **Net** and **Refund ID**
  columns — escaped against spreadsheet formula injection and behind admin sign-in because it
  contains donor details.
- Totals count **succeeded donations in your current currency** only, so mixed currencies are
  never silently added together.

## Recurring plans

Every monthly plan, **read live from Stripe** on each open — there are no webhooks here, so a
cached status on the screen you use to cancel someone's standing order would be a liability.

- Donor name and email, amount and frequency, which campaign, **total raised so far**, start
  date, last and next charge, **card brand and last four**, and the status in plain words —
  Active, Paused, Payment failed, Ended.
- **Pause and resume** — nothing is collected while paused, and nothing piles up to land on
  the donor when you resume.
- **Cancel** at the end of the period they've already paid for, or immediately.
- **Schedule an end** — a date, or a fixed number of remaining payments.
- **Invoice history** per plan: every attempt with date, amount, status, how many tries Stripe
  made, and *why* a payment failed, so you can tell a donor their card expired.
- Writes can only touch subscriptions this kiosk created, and the plan is re-read from Stripe
  afterwards so the screen shows what Stripe actually did.
- Plans created before this feature existed still appear; they just can't name their campaign
  and say so rather than guessing.
- **The donor gets their own way out.** When a plan is set up they're emailed a confirmation with
  a **"Stop my monthly donation"** link — the email tells them to keep it, because that link
  appears nowhere else. One press ends it, you get an alert, and a link for something that has
  already stopped says so instead of offering a button that would do nothing. It works from
  anywhere via your OpenMasjidOS remote address; with remote access off, the email asks them to
  contact the masjid rather than printing a link they couldn't open. The link is a long random
  code stored only as a hash, and the single thing it can do is stop that one donation.

## Devices & fleet management

- **Pair with a 6-digit code** typed on the tablet — no camera, no QR, because wall tablets
  usually have neither. Single-use, 10-minute expiry, and rate-limited both per device and
  across the whole network.
- The pairing screen shows the **exact address to type** with a Copy button, and warns you if
  you're viewing the panel on localhost (which a tablet can't reach).
- **Remote adoption** — pair a tablet at another site over your OpenMasjidOS **Cloudflare
  tunnel**, with no VPN or port-forwarding. Off by default and gated twice.
- **Live fleet list**, auto-refreshing: online/offline with last-seen, how long since pairing,
  battery and charging, reader status in plain words, reader serial and reader battery, app
  version, and which campaigns that kiosk is showing.
- Offline is detected in about **35 seconds** (check-ins are every 10).
- **Rename**, **rotate the screen**, **Identify** (the tablet flashes a bold gold wash so you
  can find it across a building), and **remove** a kiosk — which kills its token immediately.
- **Per-kiosk activity log** in a draggable window — payments, reader events and the real
  Stripe error codes, so a stubborn reader is diagnosable.
- **Out-of-date app warnings** with the steps to update.
- **Config is pushed by version** — change anything and paired kiosks pick it up on their next
  check-in and re-render, no reinstall.

## The tablet

- **A real kiosk.** The app is the tablet's Home launcher and starts itself on boot.
- **Device-owner mode** (a one-time ADB step) gives true **Lock Task Mode** — the status bar,
  notification shade, recents and Home are all gone.
- **Soft kiosk with no computer at all**: being the Home app, a dead Back button, a bounce-back
  watchdog that reopens the kiosk if it's sent to the background, hidden system bars, and an
  **opt-in accessibility helper** that closes the notification shade the instant it's pulled. The
  maintenance screen walks a volunteer through the one-time setup. (Android's **screen pinning**
  was used for this until 0.11.0 and has been removed — it blocked the Back/Home/Recents buttons,
  which hiding the navigation bar does properly, while silently forbidding the app from opening
  Android Settings, the permission prompts or the self-updater.)
- **Screen stays awake**, bars stay hidden, and the app self-recovers after a crash.
- **Getting out:** **10 rapid taps on the background** of the giving screen → your **exit PIN** →
  the maintenance screen. (Anywhere that isn't a button — not a particular corner, since on a
  multi-appeal kiosk the corner is a campaign tab.) The PIN is verified **on the tablet**, so it
  works with the server down, and is rate-limited with a lockout. **Set one** — see Known gaps: with
  no PIN set the gesture opens maintenance without asking.
- **Maintenance screen** — a ten-reading diagnostics panel (battery, power, reader,
  connection, app version, certificate, device id, server, last check-in, uptime), the card
  reader panel, **update the app**, **re-pair**, **Android settings**, **Return to kiosk** and
  **Exit kiosk** (which really leaves, handing the Home role back to the tablet's own
  launcher).
- **In-app updates** — the tablet downloads the new version over its own pinned connection and
  hands it to the system installer, without ever leaving the lockdown for a browser.
- **Built-in on-screen keyboard** that rotates with the screen, with a number strip, caps lock,
  and phone-style key feedback that lifts the character above your finger.
- **Dark, fixed brand theme**, wall-sized type, every step scrolls rather than clipping,
  reduced-motion respected, and **right-to-left layouts** supported (`supportsRtl`), so an Arabic or
  Urdu system locale mirrors the screens correctly. Your own wording — appeal titles, descriptions,
  thank-you messages, the attract headline — is whatever you type in the admin panel, in any
  language. **The app's own donor-facing wording is still hardcoded English**: the setup, pairing
  and maintenance screens are in `strings.xml` and translatable, but the giving flow is not yet, so
  translating the kiosk itself is a future change rather than a settings one.
- **Backups are disabled**, so the pairing secret never leaves the tablet.

## Card readers

- **Stripe Reader M2 over Bluetooth *and* USB.**
- **Automatic reconnection** — on boot and whenever the connection drops, plus a background
  health check that catches silent drops.
- **Firmware updates** handled in the app, with battery and charging reported to the panel. An
  update in progress is shown **on the giving screen** with a percentage and a "leave it switched
  on" note — from the floor an updating reader used to look like a broken one, and unplugging it
  mid-update is the one thing that can leave it needing a repair.
- Transient Bluetooth failures are retried with a clean re-scan, and errors come with the
  **actual fix** ("don't pair it in Android's own Bluetooth settings", "charge it past 50%").
- A **simulated reader** for testing without hardware.
- The tablet only ever holds a **short-lived connection token** — never a Stripe key.

## Admin panel

Six sections — **Dashboard · Devices · Campaigns · Donations · Recurring · Settings** — plus:

- **Single sign-on** with your OpenMasjidOS account, and a **local admin password** that can
  never brick the panel if the platform is unreachable.
- The panel **inherits the dashboard's** light/dark, accent colour and wallpaper, with a
  per-session light/dark override of your own.
- **"What's new"** in the account menu — the release notes that shipped inside the running
  build, with a gold dot until you've read them, and no call to the internet.
- A **public `/new` setup page** that hands out the Android app matched to the server version.

## Security

**Card numbers never touch this app.** The reader and the Stripe Terminal SDK handle card data
end to end; typed cards go straight into Stripe's own form and are tokenised on the device. Our
code only ever sees connection tokens, PaymentIntent client secrets and the publishable key.

- The Stripe **secret key** is fetched from OpenMasjidOS at start-up and held **in memory
  only** — never sent to a tablet or browser, never logged, never written to disk.
- **Every payment is verified server-side** before a donation is recorded.
- **Device tokens are hashed at rest** and revocable; the tablet pins the server's certificate
  on first pair (trust-on-first-use) on the LAN, and uses real system-CA validation with
  hostname checking for remote sites. It never falls back to plain HTTP.
- Over the tunnel, **only the kiosk surface is reachable** — the admin panel, sign-in and
  session routes, the Fabric relay and the WhatsApp command handler are all refused on internet
  requests.
- The **WhatsApp command handler** is the one route OpenMasjidOS calls on *us*, so it is the one
  place this app checks a credential rather than presenting one. It requires two independent facts:
  the app secret the platform issued us, and a caller header that no app id can hold. Holding no
  secret **fails closed** rather than letting an empty one match.
- Brute-force protection on sign-in and on pairing (per device *and* fleet-wide).
- An **append-only audit trail** of actions that reach outside the app — cancelling, pausing
  or rescheduling a plan, removing a kiosk, changing the exit PIN. Readable at
  `GET /api/admin/audit`; it has no screen in the panel yet.
- Security headers on every response — including a **framing denial** (`frame-ancestors 'none'`
  plus `X-Frame-Options: DENY`), so no other site can embed the admin panel or the donor's cancel
  page to trick a click — automatic HTTPS upgrade for browser visits, request-size limits, and
  CSV/HTML escaping against injection.

A full audit lives in [`docs/audit/`](docs/audit/).

## OpenMasjidOS integration

Declares `sso`, `stripe`, `https`, `notifications`, `email`, `whatsapp` and `domain`/`tunnel`; six
`alerts` (`reader-offline`, `payment-failed`, `monthly-failed`, `monthly-cancelled`,
`donation-refunded`, `test`); three read-only `commands` (`takings`, `kiosks`, `recent`); and
consumes the `students/billing` capability. There are **no install settings** — everything is
configured in-app. Nothing platform-derived is ever written to disk, so a restore onto a new machine
just works.

### Update channels

| Channel | Version | Image installed |
|---|---|---|
| **stable** (default) | `X.Y.Z` | `:<version>@sha256:<digest>` — what a masjid should run. |
| **dev** | `X.Y.Z-dev.N` | `:X.Y.Z-dev.N`, rebuilt on every push to `dev`. Testing only. |

**Both channels are versioned and both install an immutable image**; they differ only in how — a
digest on stable, a per-build version tag on dev. A dev build's version (`0.11.1-dev.3`) sorts
above the last release and below the next, so a test tablet can never be mistaken for a production
one and OpenMasjidOS can offer each dev build as a real update. `:dev` and `:dev-<sha>` are also
published as conveniences for `docker pull`, but neither is what the catalog installs.

## How it works

```
 Android tablet (kiosk app) ──Bluetooth/USB──▶ Stripe Reader M2 ──▶ api.stripe.com
        │  pinned HTTPS (device token)
        ▼
 OpenMasjid Kiosk server (one container: API + admin web + SQLite + bundled APK)
        ├─ HTTPS (outbound) ──▶ api.stripe.com     (secret key: in memory only)
        └─ LAN ──▶ OpenMasjidOS Fabric             (SSO · Stripe vault · email · alerts
                                                    · OpenMasjid Students, for tuition)
```

**Nothing inbound, no webhooks.** Both the tablet and the server make only *outbound* calls.

## Install

Install from the **App Store in your OpenMasjidOS dashboard** — one click, nothing to
configure. Press **Open**, then **Devices → Add kiosk**, which shows the address to type on the
tablet and a 6-digit code.

## Requirements

- **OpenMasjidOS** on a Raspberry Pi or mini-PC (arm64 or amd64). Container port `8080`,
  published on host `7878` by default; the platform serves it over HTTPS.
- **A Stripe account** with Terminal enabled — plus online card payments enabled if you want
  typed entry.
- **An Android tablet**, Android 8.0 (API 26) or newer, with outbound internet.
- **A Stripe Reader M2** (optional — typed entry works without one).
- **OpenMasjid Students 0.43.0+** for tuition, and an OpenMasjidOS email provider for branded
  receipts. Both optional.

## Not included

No webhooks and no inbound ports — the tablet and the server both make only outbound calls.
Refunds are issued from the admin panel, never from a kiosk. No Gift Aid, donor accounts, printed
receipts, iOS app, offline payments, or Play Store distribution.

**Known gaps:**

- **Set an exit PIN on every kiosk.** Until you do, the 10-tap gesture opens the maintenance screen
  without asking for one. **Exit kiosk** stays hidden — but **Android settings** and **Re-pair** do
  not, and Android settings drops the lockdown. It is deliberate that a PIN-less kiosk isn't locked
  out of its own reader setup; it is not deliberate that those two are reachable. Setting a PIN
  (Devices → the kiosk → exit PIN) closes it completely. See
  [`docs/audit/ACTION_REQUIRED.md`](docs/audit/ACTION_REQUIRED.md) §9.
- **A typed-card donation is captured on the tablet rather than by the server.** Reader payments are
  authorised on the tablet and only *captured* by the server after it re-checks with Stripe, so the
  money never moves on the tablet's word. Typed entry — the automatic fallback when no reader is
  connected — settles immediately instead, so a connection lost at the wrong moment can leave Stripe
  holding a payment this app has no record of, while the donor is told it will be refunded. Rare, and
  the money is in your Stripe account either way, but it will not appear in your totals. §10.
- **The local admin password can't be changed once set** — there is no route or screen for it. If you
  sign in with OpenMasjidOS this doesn't affect you. §11.
- The stored **"allow manual card entry"** setting is inert — typed entry is always offered as a
  fallback, and there is no admin control for it.
- The **audit trail** of admin actions that reach outside the app is recorded and readable at
  `GET /api/admin/audit`, but has no screen in the panel yet.
- **Donation totals use UTC day boundaries.** The container sets no timezone, so "today" rolls
  over at UTC midnight rather than the masjid's — a treasurer in California sees the day's total
  reset at 5pm. The figures are right; only the day boundary is.
- The container **runs as root** (with no Linux capabilities at all and `no-new-privileges`).
  Dropping to an unprivileged user needs a coordinated one-time migration of the data volume,
  since dropping it alone would break every existing install. See
  [`docs/audit/ACTION_REQUIRED.md`](docs/audit/ACTION_REQUIRED.md).

## Develop & build

All development happens on the **`dev`** branch — see the Branching policy at the top of
[`CLAUDE.md`](CLAUDE.md).

```bash
# server (API + static host)
cd server && npm install && npm run build && npm test

# admin web (Vite dev server proxies /api, /healthz + /download to the server on :8080)
cd web && npm install && npm run dev

# Android kiosk app (needs JDK 17+ and the Android SDK)
cd android && ./gradlew assembleDebug

# the whole app as the App Store runs it
docker compose up -d      # → http://localhost:7878
```

Local dev uses Stripe **test keys** and the Terminal **simulated reader**, so the whole flow
runs without hardware.

**Docs:** [tablet setup](docs/TABLET_SETUP.md) · [reader setup](docs/READER_SETUP.md) ·
[architecture](docs/ARCHITECTURE.md) · [remote adoption](docs/REMOTE_ADOPTION.md) ·
[Students integration](docs/STUDENTS_INTEGRATION.md) · [security audit](docs/audit/)

Contributions are welcome and require signing the [CLA](CLA.md) — see
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## Acknowledgements

Created by **Hasan Ismail**, with immense help from **Qari Ijaz** and **Osman Sayed**.

<div align="center">
  <table>
    <tr>
      <td align="center">
        <a href="https://github.com/hasan-ismail">
          <img src="https://github.com/hasan-ismail.png?size=100" width="100px;" alt="Hasan Ismail"/><br />
          <sub><b>Hasan Ismail</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://github.com/ijazshare">
          <img src="https://github.com/ijazshare.png?size=100" width="100px;" alt="Qari Ijaz"/><br />
          <sub><b>Qari Ijaz</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://github.com/osayed0001">
          <img src="https://github.com/osayed0001.png?size=100" width="100px;" alt="Osman Sayed"/><br />
          <sub><b>Osman Sayed</b></sub>
        </a>
      </td>
    </tr>
  </table>
</div>

Resources for this project were generously sponsored by **[An-Noor Institute](https://www.annoorusa.org/)**, **[Rihlatul Ilm Foundation](https://rifusa.org/)**, and **[AsmaTec Inc.](https://asmatec.com/)**.

<div align="center">
  <table>
    <tr>
      <td align="center">
        <a href="https://www.annoorusa.org/">
          <img src="https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/assets/An-noor2.png" width="120px;" alt="An-Noor Institute"/><br />
          <sub><b>An-Noor Institute</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://rifusa.org/">
          <img src="https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/assets/RIFbetter.png" width="120px;" alt="Rihlatul Ilm Foundation"/><br />
          <sub><b>Rihlatul Ilm Foundation</b></sub>
        </a>
      </td>
      <td align="center">
        <a href="https://asmatec.com/">
          <img src="https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidOS/master/assets/Asmatec.png" width="120px;" alt="AsmaTec Inc."/><br />
          <sub><b>AsmaTec Inc.</b></sub>
        </a>
      </td>
    </tr>
  </table>
</div>

May Allah reward everyone who made it possible.

---

## Source & license

Source code: <https://github.com/OpenMasjid-Solutions/OpenMasjidKiosk>

**License: [AGPL-3.0-only](LICENSE).** © 2026 OpenMasjid-Solutions.
