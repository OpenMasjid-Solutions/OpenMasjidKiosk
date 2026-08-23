<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Changelog

## Unreleased
_Development builds ahead of 0.11.0. This section is on the `dev` branch only and carries the full
detail of every change — it is distilled into a major-changes-only entry when 0.12.0 is released._

- **Groundwork for a second app: OpenMasjid Mobile Donations.** A handheld app for a volunteer's own
  phone, for taking donations at a fundraising event — an ordinary unlocked phone, not a
  wall-mounted kiosk locked to the giving screen. This build carries the plumbing to hand it out;
  the app itself follows in the next dev builds.
  - The setup page at **/new** now covers both apps and asks which one you are installing, showing
    the chooser only when the server actually has both to give. An app that isn't bundled is never
    offered — the same rule the kiosk download already followed, so nobody is shown a button that
    cannot do anything.
  - It is distributed exactly like the kiosk app: bundled inside the server image and downloaded
    from your own server. No app store, nothing to sign up for.
  - Because /new and pairing already work over a public address, a volunteer will be able to open
    your masjid's remote link on their own phone, install, pair with a 6-digit code and start
    taking donations — without ever joining the masjid's Wi-Fi. That needed no change here; it is
    what Remote access already allows.
  - **Internal, no behaviour change:** the tablet app has been split into a shared `:core` library
    and the kiosk app on top of it, so the mobile app can be built on the same foundation instead of
    a copy of it. Nothing about the kiosk app changes — the split moved files between build units
    without editing a line of their source.
  - The mobile app now exists as a real build target and is compiled and signed on every change,
    alongside the kiosk app. **It is not offered on /new yet**, and will not be until it can
    actually take a donation — the setup page only ever shows an app the server can hand over.
  - It can now **pair with your masjid**: type the address and a 6-digit code from Devices, give
    the phone a name the masjid will recognise, and it appears in your Devices list like any other
    device. Pairing works over your public address as well as on the masjid's Wi-Fi, so a volunteer
    can set their phone up from anywhere.
  - It can now **connect a Stripe Reader M2**, over Bluetooth or USB. The phone asks for Bluetooth
    and location access when you press Find my reader — and says why first, including that location
    is required by the card-reader software and that the app never tracks where you are. If someone
    declines permanently, there is a button straight to the phone's permission settings rather than
    a prompt Android will silently refuse to show again.
  - **It can take donations.** Pick the fund, tap a preset or type any amount, hand over the reader,
    done — then straight on to the next person. It is built for repetition rather than for a
    stranger walking up to a wall: no attract screen, no details step, and the result clears when
    the volunteer says so rather than on a timer that could move mid-sentence.
  - As on the kiosk, **a donation is only ever recorded after the masjid's own server has confirmed
    it with Stripe**. The phone reports what the reader did and is told the outcome; it never
    decides that money moved. If the server can't be reached at that exact moment, the app says so
    plainly and tells the volunteer NOT to take the card again before checking the Donations page.
  - Monthly giving is deliberately not offered here — it needs a name and an email, and nobody
    fills in a form at a fundraising table. It stays on the kiosk.
  - **It is now on your setup page.** Open **/new** on a phone, choose **Mobile donations**, and
    install it. Both apps ship inside this build, so the version always matches your server, and
    there is a short guide at `docs/MOBILE_DONATIONS.md`.
- **The kiosk now tells you when a WhatsApp alert may not have arrived.** A masjid's WhatsApp
  connection can quietly sign itself out — the way WhatsApp Desktop does — and until recently
  everything carried on reporting messages as sent while nothing was being delivered. OpenMasjidOS
  now spots that (needs 0.51.1-dev.12) and tells each app which period was affected.
  - **Settings → Notifications** shows the period plainly: when the connection was down and how many
    of this app's messages fell inside it. The alerts involved are marked, so a row no longer shows a
    reassuring tick for a message that may never have arrived.
  - **Nothing is resent, deliberately.** These alerts describe a moment that has passed — a
    card-reader warning arriving a day late would send someone to check hardware that is working
    perfectly. The useful thing is knowing which period to check, and the Donations and Devices
    pages cover it. **Email alerts were never affected.**
  - Dismiss the notice once you've had a look.
  - It now says **why** the connection dropped, and what to do about it — "WhatsApp signed itself
    out", "needs linking again", or "the gateway rejected its credentials" each need a different
    response, and two of them need you to go and do something (needs OpenMasjidOS 0.51.1-dev.13).
  - The exact messages affected are identified rather than guessed at from timings, so the alerts
    marked as doubtful are the right ones.
  - Fixed before anyone saw it: a message still *waiting* to go was being marked as doubtful along
    with the ones already sent. Those are the opposite case — OpenMasjidOS holds a message while the
    connection is down and delivers it once you reconnect, so it arrives perfectly well. Only
    messages actually reported as sent are questioned now.
  - **A message that is waiting is now chased for a week rather than a day.** OpenMasjidOS can hold
    messages while the connection is down and release them once you reconnect, so one can legitimately
    wait far longer than it used to — and giving up after a day would have left it reading "queued"
    for ever when it had in fact gone out.

- **Notifications is now one table: who you want to tell, and what each of them hears about.** It
  used to be a block per alert, each with room for exactly one email address and one phone number —
  so a masjid with a treasurer *and* a caretaker had to choose, and the same address had to be
  retyped into every alert it wanted. Now you add a person once and tick the alerts they should get.
  - **Add as many as you need** — email addresses, WhatsApp numbers, or both. Adding someone grants
    them no access to the app whatsoever; they only receive the alerts you tick.
  - **Give each one a name** ("Treasurer", "Ustādh Bilāl") so the table reads like your team rather
    than a list of addresses.
  - **New recipients start on the alerts that cost money or hide a problem**, and not on the chatty
    one. "A payment couldn't be started" fires every time a card is refused, so on a bad afternoon
    it is dozens of messages — it is there to tick, not to be opted into by surprise.
  - **Your existing settings are carried over exactly.** Every address you had saved becomes a
    recipient, subscribed to precisely the alerts it was already on. An address you had used for
    three alerts becomes **one** row with those three ticked, not three copies. A phone number that
    was sitting in a box with WhatsApp switched *off* stays off — turning it on for you would be a
    change you didn't ask for. Nothing to do after updating.
  - The bottom row shows where each alert actually ends up, and says **"nowhere"** in plain words for
    any alert nothing is ticked for.
- **Send to a WhatsApp group, not just to numbers.** Pick from the groups you approved in
  OpenMasjidOS → Settings → WhatsApp → Groups. One message reaches everyone in the group, which is
  both faster and far safer for your number than messaging ten people one at a time — so if you
  want a handful of people told, a group is the better way to do it.
  - **You choose, per group, whether donor names are included.** Two alerts name a person — "a
    donation was refunded" and "a donor stopped their monthly donation". Off (the default for a new
    group) they still say the amount, the kiosk and the fund, just not who. That default is
    deliberate: **everyone in a WhatsApp group can see every other member's phone number**, so a
    refund notice in a parents' group tells the whole group who asked for their money back. For a
    three-person trustees group you may well want the name — hence the switch. Individual numbers
    and email addresses are unaffected and still include names, exactly as before.
  - A group that you un-approve in OpenMasjidOS is refused with a clear reason rather than failing
    quietly, and the screen distinguishes "you haven't approved any groups yet" from "we couldn't
    read your groups just now" — one is a thing to go and do, the other is a thing to retry.
- **Phone numbers are entered properly now: pick the country, type the number.** The number formats
  itself as you type — `(555) 010-1234` — and examples throughout are American. Choosing the country
  from the list means the country code is always right, which was the one thing the old single box
  would refuse a number for, and only told you after you pressed save. Your existing numbers are
  unchanged and are shown back to you formatted.
- **You decide how many WhatsApp messages the kiosk may send — per hour and per day.** The old limit
  was one message per kind of alert every **thirty minutes**, which was far too tight: a card reader
  flapping on a Friday would tell you once and then go quiet. The new defaults are **20 an hour and
  100 a day**, and both are yours to change in Settings → Notifications, along with how long to wait
  before repeating the same alert (2 minutes by default, and you can turn that off).
  - The screen shows how many have gone this hour and today, so the numbers you pick are informed.
  - **There is still a ceiling, and it is on purpose.** WhatsApp goes through the masjid's own
    number, a ban attaches to that number, and it cannot be undone — it is the one thing here nobody
    can fix afterwards. Anything held back is counted and reported on the next message that goes, so
    it is never silent. A test message is never held back.
  - **Email and OpenMasjidOS alerts are not limited and never were.** They carry no such risk.
  - The count now survives a restart. It was previously kept in memory, which was fine for a
    half-hour gap and would have made a *daily* limit close to meaningless.
- **You can see what happened to each recipient's last WhatsApp**, on their own row — sent, queued,
  or refused with the reason in plain words. Previously there was one status for the whole alert,
  which stopped meaning anything as soon as an alert could go to more than one place.
  - Fixed before it reached anyone: when *every* WhatsApp for an alert was refused, the next message
    that did get through would have claimed some had been "held back to protect your number" —
    blaming the limit for messages the gateway had actually rejected. Refusals are reported on their
    own rows, with the real reason, and are no longer counted as anything being held back.

- **Ask the kiosk how it's doing from WhatsApp.** OpenMasjidOS can now take admin commands sent to
  the masjid's own WhatsApp number, and the kiosk answers three of them. That matters for a kiosk
  more than for most apps: it is unattended hardware in a lobby, and when a card reader stops
  responding the person who can fix it is usually not in the building. Message the masjid's number
  with `!kiosk` and pick from the menu:
  - **What's been given** — today, this week, this month and all time, after refunds, with the
    number of gifts and the average. If you run more than one kiosk it then offers to break it down:
    just reply with a kiosk's name, or "all". **No need to type another command** — the reply is
    read as your answer. Get the name wrong and it tells you the options and lets you try once more.
  - **Are the kiosks working** — every tablet, whether it has checked in, what its card reader is
    doing and which app version it's on, led by a count of how many need attention. This is the one
    worth sending when someone says the reader isn't taking cards.
  - **The last few donations** — amount, time, kiosk and fund for the five most recent, so you can
    see at a glance whether money is still coming in.
  - **Donor details are never sent.** No name, no email, no card — a WhatsApp thread keeps a copy
    forever on at least two phones. Amounts, times, kiosks and funds only.
  - **Nothing can be changed from WhatsApp** — every one of these only reads. Turn it on in
    OpenMasjidOS → Settings → WhatsApp → Commands, and add the people you trust.
  - **It is refused from the internet.** This is where your takings live, so the handler answers
    only on the masjid's own network — even on a server that has Remote access turned on. That
    needed a real fix rather than a review: the rule that keeps the admin panel off the internet
    only ever examined `/api` addresses, and this new handler does not live under `/api`, so it
    would have been reachable the day it shipped.
  - **It cannot be run without OpenMasjidOS having issued this app its credential**, and it refuses
    rather than assuming when it has not been — a server not linked to OpenMasjidOS answers "not
    linked yet" instead of accepting an empty password from anyone on the network.
  - A command that fails can never put technical detail — a payment reference, a file path — into a
    WhatsApp message, and one that takes too long says "still working, ask again in a moment"
    instead of leaving the sender with no reply at all.
- **Light mode is properly light now.** Choosing the light theme lightened the panels but left the
  background dark, so the admin panel was half one thing and half the other — and the page titles,
  the top bar and the clock stayed pale because they had to sit on that dark backdrop. The whole
  page is light now, taken from OpenMasjid Students where it was already right.
  - **Your wallpaper is still your wallpaper.** Each one has a light version that keeps its color —
    Ocean is still blue, Forest still green, Berry still pink — so the panel looks like the same
    choice, just in daylight.
  - **Text follows whatever is actually behind it.** If you use your own background image, the
    kiosk still reads the image and picks the readable ink for it, in either theme. A dark photo
    with light mode on keeps light text, which is the combination that would otherwise disappear.
  - Every combination of theme and wallpaper was checked for contrast against the accessibility
    standard, and one that had never met it — the Sunset wallpaper in **dark** mode, where page
    titles sit on its brightest orange — is very slightly deeper so that it now does.
  - Switching between light and dark also got lighter on the browser: the color fade used to be
    attached to every element on the page, including ones that never change color.
- **Decide who gets told what, in Settings → Notifications.** Until now every alert this app raises
  went wherever OpenMasjidOS was set to send it — one place, one address, for all of them. Each
  alert now has its own row, and can go to any combination of three places:
  - **OpenMasjidOS**, exactly as before — it forwards by email or webhook as you've set it up there.
    **This stays on for everything**, so nothing changes for you unless you want it to.
  - **An email address of your choosing**, per alert. "The card reader is offline" can go to whoever
    walks past the kiosk while "a donation was refunded" goes to the treasurer.
  - **WhatsApp**, to a number you enter — **off by default, and off for every alert** until you turn
    it on. It needs WhatsApp set up on your OpenMasjidOS; the screen tells you if it isn't and what
    to do about it.
  - The three are independent: turning one on never turns another off, and a channel that fails
    never stops the others. An alert with nothing switched on is flagged **"goes nowhere"** so it
    can't quietly stop reaching anyone.
  - **Send test message** now follows those same settings and tells you which channels it went by,
    so it proves your actual setup rather than just that the server is up.
  - A phone number must include its country code (`+44 7700 900123`, `+1 555 010 1234`). Leaving it
    off is refused rather than guessed at — guessing would eventually message a stranger abroad —
    and a rejected number never overwrites the one you already had saved.
- **Donors are still never messaged.** WhatsApp reaches only the numbers you type into these
  settings. There is no phone field anywhere in the giving flow, and none is planned.
  **A note on WhatsApp generally:** messages go through the masjid's own number and OpenMasjidOS
  paces them deliberately to protect it, so one can take anywhere from seconds to a few minutes.
  It's for things worth interrupting someone about; email remains the reliable channel.
- **Refunding part of a donation gave back a hundredth of what you typed.** Choosing "Refund only
  part of it" on a $100 donation and typing `50` refunded **50 pence**, not $50 — and the box
  underneath suggested you type `10000` instead. The confirmation line did show the real figure, so
  an admin reading carefully would have caught it, but nothing else would: Stripe accepted the small
  refund, the donation showed as partly refunded, and the totals were right about the wrong number.
  Full refunds were never affected. Neither were donations themselves — this was only ever the
  refund box in the admin panel.
  - It happened because the panel worked out "how many pence is $1" by looking at how a zero
    formatted and checking for a decimal point — and amounts are written `$0`, never `$0.00`, so
    the answer was always "one". Currencies with three decimal places (Kuwaiti dinar, Bahraini
    dinar, Omani rial) were out by a thousand, in the same direction.
  - The amount now comes from your currency itself, the way every other figure in the app already
    did, and a test refunds every kind of currency to prove it.
- **A refund could stop working once a donation was a week old** — but only for an appeal you had
  pointed at its own Stripe account. The server forgot which account an older donation had settled
  to, tried the main one, and Stripe correctly said it had never heard of that payment. There was
  no way past it from the screen. It now remembers for as long as the donation exists, which is the
  case that matters: someone asking for their money back a month later is completely ordinary.
- **Refunds are recorded in the audit trail.** Every other admin action that reaches outside the app
  was already logged — ending someone's monthly plan, removing a kiosk, changing the exit PIN — but
  giving money back, the only one that moves money *out*, was not.

- **The setup page no longer tells volunteers that pairing isn't built yet.** The public page a
  volunteer reads while standing at the tablet ended its "Pair it with this server" step with
  "Pairing arrives in the next update" — a sentence left over from before pairing shipped, sitting
  in front of every new kiosk since.

- **Every test now runs in CI, and nothing publishes if one fails.** They never had. The build
  checked that the code compiled and stopped there, so the tests that exist precisely because
  something has already gone wrong once — the address trick that exposed the admin panel, the
  WhatsApp handler refusing to work without a credential, the version rule behind a permanent false
  "update available" — could all have gone red without stopping a release. Pull requests now get
  checked too; before this they got nothing.
  - The tests themselves were also never type-checked, which had quietly let four errors accumulate
    in them. They are checked now, and that check found one the same afternoon it was added.

- **Light mode follow-ups**, both in the half that handles *your own* background image:
  - A background image the panel cannot read (some hosts refuse it) fell back to assuming a dark
    picture. In light mode that meant white text on a white page — the titles simply vanished. It
    now assumes the theme you are actually using.
  - The veil that sits over a background image to keep text readable followed the theme while the
    text color followed the image, so on a dark photo in light mode they worked against each other.
    They now move together.
- **Three things in the admin panel were styled with names that don't exist**, so they rendered as
  nothing at all: the busy spinner on the Email receipts buttons (pressing "Send me a test" looked
  like it had done nothing), the refunded amount in a donation's detail window, and the explanatory
  notes on the Notifications screen.

- **WhatsApp:** "the last few donations" listed a refunded gift at its full amount, as though the
  money were still there — every other figure the app reports is already netted. It now says so.
  And a command that failed left no trace anywhere: the reply is deliberately vague so nothing
  technical reaches a phone, but nothing was writing the real reason to the log either.
- **A donation that Stripe took but the server then failed to record left no trace either.** That is
  the worst version of this class of bug, and it was silent on both ends — the donor's tablet said
  "that didn't complete" and there was nothing in the log or the kiosk's own history to find later.
- **Branded receipts now fall back to Stripe's when your OpenMasjidOS is unreachable.** There is a
  safety catch that stops sending our own receipts after a run of failures, so donors get Stripe's
  instead of none — and it counted every kind of failure except the most likely one.

- **Removed things that were doing nothing.** A second, laxer copy of the amount check sitting
  beside the real one; an unused animation library in the admin panel; the Stripe card SDK still
  being compiled into the tablet app months after typed entry moved to a different mechanism, along
  with a previews-only Compose library that shipped in the release build; a scaffold string that
  could say "this kiosk is not ready to take donations yet"; and a few constants and styles nothing
  read.
- **The card-reader screen stopped sending volunteers on a wild goose chase.** With no reader
  connected it told them to switch on "Allow manual card entry" in the admin panel. There is no such
  switch, and typed entry is always offered anyway — so the advice sent someone hunting through
  settings, at the exact moment their reader had stopped working.

- **Security housekeeping.** A build no longer hands the tablet-app job credentials it has no use
  for, including one with write access to another repository. Stray secrets in a working copy can no
  longer reach the image — which matters because the folder the app is served from is one of the few
  the internet can see. And a dependency advisory in the admin panel's build tooling is cleared.
- **Documentation sweep.** The README now covers WhatsApp — both asking the kiosk questions and
  choosing where each alert goes. A number of statements that had drifted from the code are
  corrected, including a few that would have misled someone building against it: how often a tablet
  checks in, how it decides whether to pin a certificate, which addresses are reachable from the
  internet, what the setup screen actually shows, and where the maintenance gesture is. The claim
  that the tablet's wording is fully translatable is corrected — the setup and maintenance screens
  are, the giving flow is not yet.
- **A school can now ask the payer to cover the card fee** (needs OpenMasjid Students 0.51.0). It is
  **off unless the school turns it on**, and off means nothing whatsoever changes — which is what
  almost every school will see.
  - When it is on, the kiosk shows the parent an itemized total **before the card reader is armed**:
    tuition, the processing fee, and what will actually be charged — plus a plain sentence saying the
    fee is **not the madrasah's**. It is what Visa, Mastercard and American Express charge to accept a
    card and it goes straight to the payment processor, and paying at the office avoids it. A total
    that first appears on the reader is what generates phone calls to the office.
  - **The school's ledger is still credited the tuition, never the total.** Crediting the fee to the
    family would read as an overpayment and quietly eat into their next bill, month after month.
  - The amount comes from the school, not from any rate this app assumes — and it is worked out the
    way Stripe actually charges, so the school ends up with the full tuition rather than a few cents
    short. A few cents short is not a rounding curiosity: it leaves the invoice open and the family
    showing as unpaid indefinitely.
  - The figures on the screen come from the server, so the total a parent agrees to is by construction
    the total their card is asked for.
  - Cash and any manual payment never attract a fee — there is no processor taking a cut to pass on.
  - Walking away at that screen cancels cleanly, like every other step; nothing is charged.
- **WhatsApp alerts: you can now see what happened to them, and the kiosk paces itself.** Needs
  OpenMasjidOS 0.51.1, which fixed a fault on the platform side that made this app look unreliable:
  one held-up message could block every message from every app for half an hour, and the queue was
  thrown away whenever the platform restarted. If your WhatsApp alerts have been arriving late, out
  of order, or not at all, that is very likely why.
  - **A refused message now says why.** Under each alert in Settings → Notifications you can see what
    became of the last one: sent, queued, or refused with the reason in plain words — the group has
    not been approved, the number is missing its country code, or you have entered the masjid's own
    WhatsApp number. Until now a refused message and a lost one looked exactly the same, which is a
    poor thing to discover when the alert you were relying on is the one that did not arrive.
  - **At most one WhatsApp per kind of alert every half hour**, and the next one tells you how many
    were held back. This is new, and it is deliberate: the platform used to space messages out for
    us and has stopped. Without it, a card processor outage during a busy prayer could raise one
    alert per attempted donation — dozens of messages in an hour, from the masjid's own number.
    A WhatsApp ban attaches to the number itself and cannot be undone, so the kiosk now protects it.
  - **Your email and OpenMasjidOS alerts are never paced** and never have been. They carry no such
    risk, and nothing about them changes.
  - **Send test message is never held back** either — you pressed it and you are waiting for it.
  - **A message that fails late is now caught too.** The kiosk checks a minute and ten minutes after
    sending, and then keeps checking every quarter of an hour for a day. Before, anything that failed
    after the first ten minutes sat in the panel reading "queued" for ever — which is the same
    "sent it and heard nothing" problem in a smaller form. (This became worth doing once OpenMasjidOS
    started keeping each app's own history for a full day, and stopped counting these checks against
    the same budget as actually sending.)
  - None of this makes WhatsApp reliable enough to depend on: it is still "handed over", never
    "delivered", and nothing that matters for signing in will ever be sent that way. Email remains
    the channel to trust.
- **American spelling and dollar amounts throughout.** Wording across the app, the setup pages and
  the documentation now uses American spelling, and examples are written in dollars. Your own
  currency setting is unaffected — a masjid collecting in pounds, rupees or dirhams still sees its
  own symbol everywhere, exactly as before.

## 0.11.0
**Monthly giving works properly for the first time, and a donation can now be refunded from the
admin panel. Update your tablets after installing** — several of these fixes are in the tablet app.

- **Fixed: monthly donations took the money but never set up the standing order.** This affected
  **every** monthly gift, on every card and every reader. Saving a donor's card for the following
  month has to be requested at the moment the payment is set up, and we never asked — then looked
  for the saved card afterwards and of course never found one. Monthly now works end to end, on the
  reader and on typed cards. If a donor was told their monthly giving was set up before this
  release, it was not: they were charged once and nothing recurs.
- **Refund a donation from the Donations page.** Open any donation and press **Refund** — the whole
  gift or part of it, with a reason recorded in Stripe. The donor gets a branded refund note if they
  left an email, you get a **"A donation was refunded"** alert, and **every total is netted**, so
  today / this week / this month / all time show what the masjid actually kept. The donation stays
  in the log, struck through and badged, and the CSV gains Refunded, Net and Refund ID columns.
  Refunding a monthly payment does **not** cancel the plan — end it on the Recurring page.
- **Donors are emailed when their monthly giving starts, with their own link to stop it.** The
  message confirms the amount and the date of the next payment and carries a **"Stop my monthly
  donation"** button; it tells them to keep it, because that link appears nowhere else. One press
  ends it and you get an alert. A link for a donation that has already stopped says so. It works
  from anywhere via your OpenMasjidOS remote address — and without remote access turned on the email
  asks them to contact the masjid rather than printing a link they could not open.
- **The card reader now works for appeals that pay into a second Stripe account.** Previously only
  your main account could take a card on the reader and the rest quietly fell back to typing the
  card in — which also made monthly giving impossible on those appeals. The kiosk now moves the
  reader onto whichever account the appeal pays into, the moment someone donates to it. Your main
  appeal is unaffected and just as fast.
- **Fixed: a monthly donation could be missing from the Recurring page.** A plan could show as
  Monthly in Donations while Recurring said "No recurring plans yet" — nothing to pause or cancel,
  even though Stripe was still collecting. Every plan this app sets up is now remembered and always
  listed, including ones created before this release.
- **Fixed: "Open Android Settings" and the permission buttons did nothing on a locked kiosk.** The
  kiosk used Android's screen pinning, which blocks a pinned app from opening *any* other app and
  says nothing when it refuses — so Settings, the permission prompts and the self-updater all looked
  dead. Pinning is gone; hiding the navigation bar does the same job properly. Nothing to change on
  your tablets, and the "Screen pinning" item has left the setup checklist.
- **Updating the tablet app no longer needs a browser.** "Update app" downloads the new version over
  the kiosk's own secure connection and hands it to Android, without leaving the lockdown.
- **Fixed: payments could fail to start.** "Sorry, we couldn't start the payment" with a donor's card
  already out — often for monthly, now and then for one-offs. The tablet was giving up after eight
  seconds while the server was still talking to Stripe, and a stale connection after a quiet spell
  could lose a donation outright. Both fixed, and failures now record the real reason in
  **Devices → Logs**.
- **The campaign editor is a full page in its own browser tab.** The live kiosk preview and the
  settings both get real room, the address is shareable and survives a refresh, and several appeals
  can be open side by side.
- **An on-screen pointer to your card reader**, optional and set per tablet in **Devices → Reader
  side**: a pulsing contactless symbol with arrows on the edge where your reader is mounted — left,
  right, top or bottom — turning green when the payment goes through.
- **Card-reader firmware updates are shown on the giving screen**, with a progress percentage and a
  "leave it switched on" note. From the floor an updating reader used to look like a broken one, and
  unplugging it mid-update is the one thing that can leave it needing a repair.
- **Monthly donations are no longer set up as a "free trial."** They read as Active with a real next
  invoice date — here, in Stripe, and in the donor's own Stripe emails. Nothing about the money
  changes.
- **Campaign colors accept a typed hex code**, so a masjid can enter its exact brand color instead
  of hunting for it by eye.
- **Campaign tabs have an adjustable size** — Small / Medium / Large / Extra large in
  **Campaigns → Kiosk settings**. Medium is the original size, so nothing changes until you pick one.
- **Security: no other site can put this app in a frame.** The admin panel and the donor's cancel
  page can no longer be loaded invisibly inside someone else's page to trick a click out of you.
## 0.10.2
- **Nothing changes on your kiosks in this release.** No new donor-facing features, no admin
  changes, no tablet update needed. It is worth installing anyway for the build-safety fix below,
  but there is no hurry.
- **Fixed: a build without the app-signing key could have shipped an unusable app.** If the signing
  secrets were ever missing, the pipeline fell back to a test-signed Android app and published it
  anyway. Android refuses to install an update signed with a different key, so every tablet would
  have shown "App not installed", and the only way out would have been uninstalling the app on each
  one — losing its pairing and needing a physical re-pair. The build now refuses to publish anything
  but a properly signed app, and says exactly why if it can't.
- **New: a development channel, for testing before a release reaches masajid.** OpenMasjidOS now has
  an Update Channel toggle; leaving it on **stable** is what a masjid should do and is unchanged.
  Switching a test server to **dev** gets the newest development build, tablet app included, so a
  change can be tried on real hardware before anyone else sees it. Dev builds label their version
  with `-dev` so a test tablet can never be mistaken for a live one.
- The README now describes the whole product rather than the first week of it, and documents two
  known gaps found while writing it: branded receipt emails currently fall back to Stripe's own
  receipt, and the stored "allow manual card entry" setting does nothing (typed entry is always
  offered). Both are fixes for a future release.

## 0.10.1
- **Security: the admin panel could be reached from the internet by a remote kiosk's address.** If
  you had turned on Remote access in OpenMasjidOS *and* "Allow remote adoption" here, the rule that
  keeps the admin side of this app on your local network could be stepped around by writing part of
  the web address in a different but equivalent way. Your admin password still had to be entered, so
  nobody could see donations, donors or plans without it — but the sign-in page itself was reachable
  from outside, and it should never have been. It is now closed, and there is a test that keeps it
  closed. **If you use remote adoption, change your kiosk admin password.** If you have never turned
  it on, you were never affected.
- **New: an activity record for the things that reach outside the app.** Canceling, pausing or
  rescheduling someone's monthly donation, removing a kiosk, or changing the exit PIN are now written
  down with what happened and when. Stripe only ever records "canceled by this masjid", so if two
  people share the admin login there was previously no way to tell who stopped a donor's standing
  order.
- **Card reader and card form security tightened.** The typed-card screen can no longer be navigated
  away from to anything but Stripe, so a locked kiosk can't be turned into a web browser. Card
  authentication with your donor's bank still works exactly as before.
- Pairing a tablet is now protected against guessing from many devices at once, not just from one.
- Updated the web-serving library to close four published vulnerabilities, and cleared every other
  known advisory in both parts of the app. Nothing about how the kiosk looks or behaves changes.
- Housekeeping: a memory leak in the sign-in throttle, stricter browser security headers, and every
  build step pinned to an exact verified version so the app you install is the app we built.

## 0.10.0
- **New: a Recurring page for monthly donations.** Until now a monthly gift set up at a kiosk
  disappeared into Stripe and you had to go to the Stripe dashboard to see or change it. There's now
  a **Recurring** section in the panel listing every plan: the donor's name and email, the amount and
  how often, which campaign it came from, **how much that plan has raised in total**, when it started,
  the last and next charge, the card and last four digits, and the status in plain words — "Active",
  "Paused", "Payment failed", "Ended".
- **Open a plan to manage it.** Pause it (nothing is collected while paused, and nothing piles up to
  land on the donor when you resume), cancel it — at the end of the period the donor has paid for, or
  immediately behind a confirmation — or give it an end date, or tell it to stop after a set number of
  further payments.
- **Invoice history per plan**: every renewal with its date, amount, status, how many attempts Stripe
  made, and the reason a payment failed when it did, so you can tell a donor their card expired
  instead of guessing.
- Everything is read **live from Stripe** each time you open the page, so it can't show you a plan
  that was canceled elsewhere or a status that's out of date.
- Plans created before this release still appear, but can't say which campaign they belonged to, and
  their totals leave out the first payment taken on the reader (that one is in Donations). Both are
  marked on screen rather than quietly guessed at.

## 0.9.36
- **Fixed: a child's bills couldn't be paid when a sibling was in credit.** If one child was paid
  ahead and another owed, the school's household total nets the two out — so a family with $340 of
  credit on one child and $160 owed on another showed "$180 paid ahead", listed the $160 of unpaid
  bills, and offered no way to pay any of them. The kiosk now works from what the **bills** come to
  rather than that netted total: "Balance due $160" at the top, the bills tickable, and a "Pay $160"
  button. Any credit on the family is still shown, underneath, where it can't be mistaken for having
  nothing to pay.
- **A "Leave" button on the balance screen.** It used to be a small text link at the very bottom of
  the screen, and with nothing payable it was the only control there at all.
- **The balance screen now closes itself.** A family's names, bills and arrears can no longer sit on a
  wall-mounted tablet indefinitely: the screen returns to the Student ID prompt after three minutes
  regardless of whether anyone is touching it, on top of the existing 45-second inactivity reset.
- **The countdown ring tells the truth again.** Once you moved past the first screen it was drawing a
  stale, already-finished timer, so the one signal that the kiosk is about to reset was wrong.
- Paying part of what's owed is no longer mistaken for paying ahead when a sibling's credit nets the
  family to zero, and the Fees tab keeps the school's name in its heading after a timeout.
- **(Requires updating the tablet app.)**

## 0.9.35
- **"What's new" in the account menu.** The admin panel can now tell you what changed. Open the
  account menu at the top right and there's a **What's new** entry with the release notes, newest
  first, and the version you're running marked. It reads the notes that shipped inside this build,
  so it always describes the app in front of you — nothing is fetched from the internet.
- **A gold dot when there's something to read.** When OpenMasjidOS updates the kiosk app, the account
  button gets a small gold dot until you've opened the notes. It's per browser, and it never appears
  on a fresh install.

## 0.9.34
- **The tuition screen is now laid out child by child.** A family with three children used to get one
  condensed list where every row said "Tuition — Feb 2027" and nothing said who owed what. Each child
  now has their own section: their name, their own **balance due**, **credit** or **"Nothing due"**, and
  their own bills underneath.
- **Add money for one child.** Where a family has more than one child, "pay a different amount" is now
  a button per child — **"Add money for Maryam"** — so the money lands on that child's account. Paying
  ahead for one child while another still owes now works properly, and the smallest payment is still $1/$1.
- **Nothing due no longer opens a keypad.** A parent who owes nothing was previously dropped straight
  onto a number pad, which reads as being asked for money. The kiosk now says what the account is first
  — the credit on it, or simply "Nothing due" — and offers to take a payment only if they want to.
- **Pay one thing off a bill.** A February bill is often $200 of tuition **plus** a $50 book fee, and a
  parent asking to pay just the book fee couldn't be served. With **OpenMasjid Students 0.43.0** the
  kiosk lists what a bill is made of and lets them tick the lines they want — and the school's ledger
  settles exactly those lines, not the oldest bill instead. Lines already paid are shown as done, and a
  bursary or discount is shown for information. "Full balance" is still the default, still one tap.
  On an older Students nothing changes: a bill stays one line with one tick.
- **(Requires updating the tablet app.)**

## 0.9.33
- **Fixed the "Unlock" button on the PIN pad**, which was splitting across two lines ("Unlo / ck")
  since the type got bigger in 0.9.30. Delete and Unlock now share the keypad's own width beside the
  "0" key, and neither label can ever break mid-word again.
- The **One-time / Monthly** and **Full balance / Choose what to pay** switches are held to one line
  for the same reason. Same wording as before.
- **(Requires updating the tablet app.)**

## 0.9.32
- **Keys react like a phone's.** Press a key on the kiosk keyboard and it lights up in your accent
  color and lifts a big copy of the letter **above your finger**, so you can see what you typed even
  though your hand is covering the key. Space, shift, backspace and Done highlight too (no bubble —
  they're wide enough to read around a finger).
- **Student ID stays in capitals.** The ID keypad is now locked to capitals, so the keys show `YUS1234`
  as you type it instead of lower-case letters that quietly changed on the way into the box.
- **(Requires updating the tablet app.)**

## 0.9.31
- **Parents can pay tuition ahead at the kiosk.** If a family wants to hand over a term — or the whole
  year — before it's billed, the kiosk now takes it. Where the balance screen used to be a dead end for
  a family with nothing outstanding, there's a keypad: **"Pay towards the next bill"**. OpenMasjid
  Students holds the money as that child's credit and takes it off their next invoice automatically.
  Needs **OpenMasjid Students 0.41.0** and a school that has advance payments switched on — otherwise
  the kiosk behaves exactly as before and says nothing is due.
- **The screen now says what the account actually is.** A zero balance used to look the same whether a
  family was square or had already paid ahead. The kiosk now shows **"Balance due $X"**, **"$X paid
  ahead — it comes off the next bill automatically"**, or **"Nothing due"**, and each child in the
  family is listed with their own figure.
- **Pay a different amount against a balance.** Alongside "Full balance" and "Choose what to pay",
  a parent can type any amount — part of what's owed, or more than it. Anything beyond the bill becomes
  credit rather than being lost.
- **No sub-$1/$1 payments.** Every route to the reader — full balance, picked months, or a typed amount
  — is floored at the school's own minimum and never below a pound/dollar, since a smaller charge costs
  more in card fees than it collects. The kiosk shows the minimum on the keypad, and the server enforces
  it independently of the tablet.
- **(Requires updating the tablet app.)**

## 0.9.30
- **Much bigger, easier-to-read writing everywhere.** Every screen — the giving screen, the number
  pad, details, tuition, the thank-you, the volunteer screens — steps up about a third in size and a
  weight bolder, so the kiosk reads from across the foyer instead of at arm's length. Buttons, the
  keyboard keys, the PIN pad and the tap-to-type boxes all grew to match, and any screen that runs
  out of room now scrolls instead of cutting a button off.
- **Text now contrasts with whatever colors you set.** The kiosk works out the text color from the
  campaign background it's actually painted on, rather than assuming, so headings and small print stay
  readable on a light, dark or strongly-colored campaign. Secondary lines (subtitles, hints, "Due …")
  are no longer a faint gray.
- **"Hold your card on the reader for at least 5 seconds"** now appears on the payment screen, in the
  accent color under the tap prompt. Lifting the card early is the most common reason a payment looks
  like it failed.
- **The keyboard only opens when you tap a box.** It used to open by itself on the details and tuition
  screens, which made people think a name, email or ID was required before they could carry on. Empty
  boxes now say "Tap here to type", and when name and email are optional the screen says you can just
  continue.
- **(Requires updating the tablet app.)** Server and admin panel are unchanged.

## 0.9.29
- **Paying for one child now lands on that child's bill.** With OpenMasjid Students billing per child
  (0.39.0), a family with more than one child could tick *Maryam's* month at the kiosk and have the
  money booked against a sibling's older bill instead — the amount charged and the family balance were
  always right, but the school's per-child ledger wasn't. The kiosk now tells Students exactly how much
  of the payment belongs to each child, and that split is kept safe until the payment is confirmed, so
  a retry after a dropped connection attributes it the same way. **Paying the full balance is
  unchanged** (Students still clears the oldest bills first). Admin panel + server only — no tablet
  update needed beyond 0.9.28.

## 0.9.28
- **Tuition: no more PIN — just the Student ID.** OpenMasjid Students **0.39.0** dropped student PINs,
  so the kiosk's tuition screen now asks for the child's **Student ID** (the `YUS1234` code on your
  statement) and nothing else. The kiosk then shows **"Is this your child?"** with the child's first
  name, and only once the parent taps **Yes** does the balance appear. That confirmation catches a
  mistyped ID — which a PIN never did — and takes one field off the keypad.
  **Requires OpenMasjid Students 0.39.0 or newer, and a tablet app update:** on 0.39.0 the old
  name + PIN lookup is rejected outright, so an un-updated kiosk's tuition tile can't fetch a balance.
- **Invoices say whose they are.** Students now bills **per child**, so when a family has more than one
  child at the school, each month in "Choose what to pay" is labeled with the child it belongs to.
- Paying, receipts and the Students ledger are **unchanged** — an in-flight payment, a retry from the
  outbox, and every other campaign type behave exactly as before.

## 0.9.27
- **Much stronger soft kiosk — no computer needed.** Without the (optional) device-owner setup, the
  kiosk now locks down far harder, all from the tablet:
  - **Screen pinning, held.** The app pins itself and re-asserts it on resume and focus-change, so
    the **notification shade and the Home/Recents buttons are blocked** (this closes the
    recents → app-info → Settings escape). With a screen lock + "ask before unpinning," getting out
    by hand needs your device PIN. Your **exit PIN** still opens maintenance and leaves normally.
  - **Back does nothing.** The system Back button can no longer navigate out of the giving flow.
  - **Shade lock (optional helper).** An opt-in accessibility helper closes the notification shade
    the instant it's pulled down while locked — a backstop for moments pinning isn't active.
  - **Update from inside the app — no browser.** "Update app" now downloads the new version over the
    kiosk's own secure connection and hands it to the system installer, so updating never breaks the
    lockdown by opening Chrome.
  - The maintenance screen walks you through the one-time setup (Set as Home app → Screen pinning +
    a screen lock → shade lock), and `docs/TABLET_SETUP.md` covers optional nav-bar hiding. No ADB,
    no cable, no PC. **(Requires updating the tablet app.)**

## 0.9.26
- **Tighter kiosk lockdown.** The hidden maintenance gesture now needs **10 rapid taps** (was 7) to
  reach the exit-PIN, so it's even harder to trigger by accident. On a **device-owner** tablet the
  status bar (notification shade) and navigation bar are removed entirely, and they're now re-hidden
  the moment Lock Task starts so they can't flash into view. **(Requires updating the tablet app.)**
  *For a truly un-leavable kiosk with no notification shade at all, provision the tablet as device
  owner — the one-time ADB step in `docs/TABLET_SETUP.md`. Without it, Android only lets us hide the
  bars (a swipe still briefly reveals them); with it, they're gone completely.*

## 0.9.25
- **Email receipts + admin alerts (new).** Donors who give their email can now get a **branded,
  Stripe-style receipt** — your logo, a thank-you you write, and the amount/date/card/fund — sent
  through your **OpenMasjidOS email provider** (set up once in OpenMasjidOS → Settings → Email).
  Turn it on in **Settings → Email receipts**, design it with a live preview, and send yourself a
  test. Until email is set up, Stripe's own receipt is used, so a donor is never left without one.
- **Admin alerts.** OpenMasjidOS can now warn you when the **card reader goes offline** or a
  **payment can't be started** (bad/expired Stripe keys, or Stripe down), delivered to your email
  or webhook per your OpenMasjidOS → Settings → Alerts choices. Admin-panel + server only — no
  tablet update needed.

## 0.9.24
- **Tuition payments (new).** A campaign can now be a **Tuition** appeal powered by **OpenMasjid
  Students**: on the kiosk a parent taps the tile, enters their child's **name + PIN**, sees the
  family's balance and open invoices, pays the **full balance or picks specific months** on the card
  reader, and gets a **"payment"** receipt (never counted as a donation). Set a campaign's type to
  Tuition in the admin. Requires OpenMasjid Students installed with tuition enabled, the kiosk on the
  same Stripe account the school uses, and a tablet app update.
- **Tuition, made robust.** A parent's typed name + PIN are cleared automatically if they walk away
  (nothing lingers for the next person), the amount shows immediately on the card screen, and the
  tuition tile recovers on its own after a brief hiccup reaching the school — never stuck "unavailable".

## 0.9.23
- **New app icon.** The OpenMasjid Kiosk brand mark (crescent + minaret + a contactless-tap symbol) now
  appears in the App Store, the OpenMasjidOS dashboard, and as the Android launcher icon (a white
  adaptive icon). Requires a tablet update for the launcher icon; the store/dashboard icon updates on
  its own.

## 0.9.22
- **Fixed the campaign live preview.** It now sits full-width at the top of the editor and reliably
  shows both the portrait and landscape giving screens (it was rendering broken before).
- **More readable giving screen** — larger text, and a darker, higher-contrast secondary text color on
  the bright background (kiosk + preview).
- **Bigger "Choose your own amount" button** — a bold, filled pill instead of a thin outline.
- **Better on-screen keyboard** — the number row is now a compact strip (not a second bank of letter
  keys), and double-tapping ⇧ toggles CAPS LOCK (tap ⇧ again to turn it off).
- Kiosk-side changes (giving screen, keyboard) need a tablet app update; the preview fix is admin-only.

## 0.9.21
- **Remote adoption — completed on the tablet.** A tablet at another site can now finish pairing over
  your OpenMasjidOS Cloudflare tunnel: it validates the real (public) certificate with standard system
  trust + hostname checking, so there's no certificate warning to accept and the cert can renew freely.
  Kiosks on your own network keep the existing self-signed trust-on-first-use pinning. The tablet picks
  the right mode automatically from the address you enter. **(Requires updating the tablet app.)**

## 0.9.20
- **Remote kiosk adoption (server + admin half).** A tablet at another site can be paired over your
  masjid's OpenMasjidOS **Cloudflare tunnel** — no VPN or port-forwarding. In **Devices → Add a kiosk**
  there's a new **Remote (another site)** tab: turn on Remote access in OpenMasjidOS and expose the
  kiosk, then flip **Allow remote adoption** (off by default) and it shows the tablet's public address +
  a pairing code.
- **Only the kiosk surface is exposed.** The server is now base-path aware; over the tunnel it serves
  only the setup page, the app download, and the device connection — the **admin panel stays on your own
  network** (admin/login/session routes are refused on internet requests). Turning remote access on does
  not change anything on your LAN.
- *The tablet app update in the next release completes remote pairing end-to-end (pairing over the real
  Cloudflare certificate).* Admin-panel changes here need no tablet update.

## 0.9.19
- **Clearer "Add a kiosk" screen.** It now shows the exact **server address** to type on the tablet
  (this admin page's own address) with a one-tap Copy button — and warns you if you're viewing it on
  localhost (which a tablet can't reach). The pairing code is now clearly labeled too, so it's obvious
  what goes in each field on the tablet. Admin-only; no tablet update needed.

## 0.9.18
- **Reimagined campaign designer.** The editor is now a roomy two-pane window: tabbed settings
  (Design · Amounts · Type & fees · Payments · Kiosks · Message) beside a **live, true-to-device
  preview of both the portrait and landscape giving screens**. The preview now mirrors the tablet
  exactly — real two-tone tiles, colors, per-orientation columns, and bright/dark scenes.
- **Per-kiosk campaign targeting, both ways.** Each campaign's new **Kiosks** tab sets exactly which
  kiosks show it (new campaigns go to **all kiosks** by default; turn that off to pick specific ones);
  the **Devices** page now lists which campaigns each kiosk is currently showing.
- Admin-panel only — no tablet app update is needed for this release.

## 0.9.17
- **Bigger, easier on-screen keyboard.** The kiosk keyboard now has taller, thumb-friendly keys and a
  **number row** across the top, so donors can type a name or email quickly. (Requires updating the
  tablet app.)

## 0.9.16
- **On-screen keyboard fixed for rotated kiosks.** When you rotate the screen, the donor name/email
  step now uses the kiosk's **own** on-screen keyboard, which rotates with the giving screen — the
  system keyboard used to appear sideways because it's a separate part of the tablet that doesn't
  rotate with the app. (Requires updating the tablet app.)

## 0.9.15
- **Screen rotation that actually works on any tablet.** The kiosk now **rotates its own UI** by the
  angle you choose, instead of asking the tablet to rotate — many tablets ignore that request, which is
  why the setting did nothing before. In **Admin → Devices**, “Rotate screen” now offers **0° / 90° /
  180° / 270°**; pick whichever makes the screen upright on your mount. (Requires updating the tablet
  app to this version.) The giving screen also re-flows to two columns when the rotated result is
  portrait.

## 0.9.14
- **Typed card entry is card-only now.** Entering a card by hand no longer shows the “Link” / bank-
  account (ACH) option — just the card number, expiry and CVC. (Requires updating the tablet app.)
- **More reliable web-set orientation.** The screen orientation you choose in Admin → Devices is now
  applied and re-asserted at the app level, so it takes hold and sticks. **Note:** orientation is a
  tablet-app feature — a kiosk must be updated to this version for the web control to move it.

## 0.9.13
- **Portrait-friendly kiosk.** The giving screen now adapts to a portrait tablet — the amount tiles
  re-flow into two tall columns and everything scales to fit (landscape still uses the wide layout).
- **Set the screen orientation from the web.** In **Admin → Devices**, each kiosk has an
  **Orientation** control (Auto / Landscape / Portrait / flipped 180°). The tablet is forced to that
  orientation regardless of its own auto-rotate, so a wall mount always sits upright.
- **Choose which kiosks show a campaign.** Each campaign can be set to show on **all kiosks** or only
  **specific** ones (Admin → Campaigns → “Show on which kiosks”). Your main campaign always shows
  everywhere.
- **Color themes.** The campaign editor now has one-tap **color presets** (a primary + accent that
  go well together). Picking one just fills the color fields — you can still fine-tune either.

## 0.9.12
- **Campaign type (Donation / Zakat / Tuition).** Every campaign now has a required **Type** that sets
  the card-fee rule (matching OpenMasjid Donations):
  - **Donation** — you can *offer* donors the option to cover the card fee (their choice on the tablet).
  - **Zakat** — the fee is *always* covered by the donor, so the full Zakat reaches the masjid; the
    kiosk tells the donor it's added because it's Zakat.
  - **Tuition** — you choose whether to *require* the payer to cover the fee.

## 0.9.11
- **Much bigger, bolder amounts.** The donation numbers now fill the tile — large and heavy — so
  they're easy to read across the room, and the **“Donate”** button band is taller with bigger text
  so it's the obvious thing to tap.
- **Color-coded, bigger tabs.** Each campaign tab is now tinted with that campaign's own color and
  is larger and bolder, so it's clear which appeals you can switch between.
- **No more cut-off descriptions.** Campaign titles and descriptions now have a character limit (with
  a live counter in the editor), and the giving screen fits a fuller description without clipping.

## 0.9.10
- **Two colors: a primary and an accent.** Each campaign now has a **Primary color** (a soft wash
  behind the giving screen) and an **Accent color** (the “Donate” band on each amount tile and the
  buttons) — like the reference design. Set both in Admin → Campaigns.
- **Bigger, bolder amounts + a touch of glass.** The amount numbers are now large and heavy black on
  clean white tiles with a subtle glass sheen, so they read at a glance from across the room.
- **Fireworks on a gift.** Turn on **“Celebrate donations with fireworks”** in Kiosk settings and a
  short, joyful fireworks animation plays on the thank-you screen — for every gift, or only for gifts
  at or above an amount you choose. (Respects the tablet’s reduced-motion setting.)
- **Campaign logo now shows.** The logo you set on a campaign now appears at the top of that
  campaign’s giving screen.
- **Bluetooth reader:** longer auto-discovery window so a slow/asleep reader is found more reliably on
  each reconnect attempt (on top of the v0.9.9 background health checks).

## 0.9.9
- **Bigger, bolder amount buttons.** The six giving amounts are now much larger and use a two-tone
  design — a big amount on the tile with a solid colored **“Donate”** band beneath — so they read
  instantly across a room.
- **Seamless “Enter card details”.** Tapping to type a card no longer flashes a “Sorry — that didn’t
  go through” message for a moment before the card form opens; it now goes straight to a calm
  “Opening card entry…” and then the card page.
- **More reliable card reader.** The kiosk now keeps the reader connected with regular background
  checks: if the reader ever drops silently (a cable knock, a Bluetooth blip, waking from sleep) the
  kiosk notices within seconds and reconnects on its own, and corrects its status display to match.

## 0.9.8
- **Zakat: require covering the card fee.** A new campaign switch, **“Require donors to cover card
  fees (only for Zakat)”** (Admin → Campaigns), always adds the card fee to a Zakat gift and tells the
  donor on the kiosk that the fee is added *because it’s Zakat*, so the full Zakat reaches the masjid.
- **A gentler option for large gifts.** In **Kiosk settings** you can set a **large-donation
  threshold** plus a note and an image (e.g. a Zelle/bank-transfer QR code). When someone chooses a
  gift at or above that amount, the kiosk first suggests the cheaper way to give — they can still tap
  **“Give by card”** and continue, knowing card fees are higher on large amounts.
- **Cleaner, flat giving screen.** Removed the glassy look — the amount buttons and the typed-card
  screen are now solid, flat and easy to read (GiveALittle-style), in both the bright and dark themes.

## 0.9.7
- **Fixed the typed-card screen.** The card form was overflowing off the top of the screen (only the
  Pay/Cancel buttons showed) and sat see-through over the giving screen — so a donor couldn’t actually
  enter a card. It’s now a clean, opaque, full-screen card page that scrolls if needed, with Stripe’s
  card fields clearly shown. This also fixes keyed payments failing because the card couldn’t be typed.
- **Countdown-to-menu during a donation.** Once a donation is started, the same small countdown ring
  appears in the corner and returns to the menu after inactivity (with a longer, patient window while
  the card form is open, so a slow typer is never cut off).
- Softer, cleaner glass on the amount buttons.

## 0.9.6
- **Nicer donation buttons.** The amount buttons now have a proper liquid-glass look — a soft
  rim-light edge and a gentle sheen instead of the flat, hard border.
- **Editable bottom tagline.** The small line at the bottom of the giving screen (previously always
  “OpenMasjid Solutions”) can now be changed — or hidden — in **Admin → Campaigns → Kiosk settings →
  Bottom tagline**.
- **Clearer “cover the fee” note.** When a donor is offered to cover the card fee, it now explains
  that this is the **Visa / Mastercard / Amex** card fee — not a platform fee — and that OpenMasjid
  Solutions is free, unlimited, forever.

## 0.9.5
- **Redesigned the giving screen to the full-screen layout you wanted.** The masjid name + tagline
  sit across the top, then a big, edge-to-edge grid of donation buttons (three across) — each with a
  large amount, a “Donate” label and an accent bar — a small “Choose your own amount”, and a subtle
  footer. The buttons have a touch of glass transparency. Replaces the cramped centered card.

## 0.9.4
- **Typed card entry rebuilt to actually work on a locked kiosk.** Keyed card payments now use
  Stripe’s own card form (Payment Element) inside the app — the same technology as OpenMasjidDonations
  — so the card’s security check happens *in the app* and never needs the external browser that a
  fully-locked (device-owner) tablet blocks. Enter the card, pay, done. (The card number goes straight
  into Stripe and is never seen by our app or server.)
- **Nicer giving screen.** A polished liquid-glass card with **six big, easy-to-read amount buttons**
  and a **small “Other amount”** — a blend of GiveALittle and the OpenMasjidDonations look.
- **“Cover the card fee” moved to the details step.** After you pick an amount, the option to cover
  card fees sits next to the name/email, and shows the **exact extra it adds** (e.g. “+$0.60”).
- Bigger campaign editor and click-through donation details from the previous update carry over.

## 0.9.3
- **Fix — typing a card now works on a locked-down kiosk.** Keyed card entry couldn’t complete on a
  device-owner (fully locked) tablet because the card’s security check (3-D Secure) needs to briefly
  open the browser, and lock-task mode was blocking it. The kiosk now allows that secure browser step
  (it has no address bar and returns automatically, so the kiosk stays locked), and keyed payments are
  card-only for a cleaner, more reliable form. Tap-to-pay was always fine.
- **Brighter, bolder giving screen.** The kiosk now shows big, full-screen, frosted-glass amount
  tiles (GiveALittle-style) on a vibrant, bright background, and the tablet is forced to **maximum
  brightness**. Each campaign’s **Appearance** (Bright / Dark / Auto) and the **Force maximum screen
  brightness** switch are configurable in the admin panel.
- **Bigger campaign editor.** The campaign editor is now a roomier, more spacious window.
- **Donation details.** Tap any donation in the Donations log to open a details window (amount, date
  & time, donor name & email, campaign, kiosk, payment id).

## 0.9.2
- **Manual (typed) card entry is now always available when paying.** Every card screen shows an
  **“Enter card details”** button — with or without a reader connected — so a donor can always pay
  even if the reader is being fussy. (It’s no longer hidden behind a setting; the old toggle is gone.)
  Note: your Stripe account must have **online card payments enabled** — being set up for the
  in-person reader isn’t enough. If keyed entry ever fails, the exact reason shows in Devices → Logs.
- **The hidden maintenance gesture (7 taps) works everywhere again.** Tap 7 times anywhere on the
  screen background — on any screen — to reach the PIN unlock. (Tapping amount buttons or the number
  pad won’t trigger it by accident.)
- **Removed the Cancel button from the main giving screen.** Cancel now only appears once a donation
  is under way (after you choose an amount).

## 0.9.1
- **Fix — the app failed to start after updating to 0.9.0 on an existing install** (“no such column:
  campaign_id”, container restart-looping). The new donations “campaign” columns were being indexed
  before they’d been added to an already-existing database. Fixed the upgrade to add the columns
  first; upgrading now migrates cleanly and your existing donations are preserved.

## 0.9.0
- **Multiple giving campaigns, shown as tabs.** The kiosk no longer starts on a “Tap to donate”
  screen — it opens straight on your **main campaign’s** giving screen (amounts, one-time/monthly).
  Add more appeals (e.g. Zakat, Building Fund) in the new **Campaigns** admin tab; each becomes its
  own tab across the top of the kiosk, with **its own color, background image, logo, amounts,
  monthly option, cover-fees option and thank-you message**. The first tab is your always-shown main
  campaign.
- **Auto-return to the main campaign.** When a donor opens another appeal and then walks away, the
  kiosk returns to the main campaign after 45 seconds of no touches — shown as a small, wordless
  countdown ring. Any touch resets it, and it never interrupts a donation in progress.
- **Per-campaign Stripe accounts.** A campaign can settle to a different Stripe account. Note: the
  physical card reader is tied to your primary account, so a campaign pointed at a *different* account
  is taken by **keyed (typed) card entry** rather than the reader — the admin panel says so clearly.
- **Cover the card fee (optional).** Turn this on for a campaign and donors can choose to add the
  estimated card fee so your masjid receives their full gift.
- **Manual card entry, improved.** When **no reader** is connected the kiosk now automatically takes
  cards by keyed entry; when a reader **is** connected, an admin toggle decides whether the “Enter
  card details” button appears on the card screen.
- **Bluetooth reader — connection hardened.** The app now fully stops scanning and binds to the
  freshest reader before connecting (the common cause of “Bluetooth unexpectedly disconnected during
  operation”), retries a transient drop with a clean re-scan, and logs the exact Stripe error **code**
  to Devices → Logs so a stubborn reader is finally diagnosable.
- Donations are now tagged by campaign in the log and CSV export.

## 0.8.2
- **Fix — “Exit kiosk” really leaves now, even when the kiosk is the tablet’s Home app.** On a
  locked-down (device-owner) tablet the kiosk *is* the launcher, so simply going Home came straight
  back to it. Exit kiosk now hands the Home role to the tablet’s **own** launcher, so it drops you out
  to the normal Android home screen. Re-opening the kiosk app makes it the launcher again.
- **New — “Open Android settings” in the maintenance screen.** After unlocking with the exit PIN you
  can jump straight to the tablet’s Android settings (Wi-Fi, launcher, etc.); the kiosk re-locks itself
  as soon as you come back.

## 0.8.1
- **Manual card entry: the real failure reason is now shown.** When a keyed payment can't even start,
  the exact Stripe reason is written to **Devices → Logs** (`payment_create_failed`) instead of a
  generic message. The most common cause is that **online card payments aren't switched on for your
  Stripe account** — being set up for the in-person reader (Terminal) is separate. Enable it in the
  Stripe Dashboard → **Settings → Payment methods → Cards**, then retry. (The keyed-payment setup was
  also aligned to Stripe's recommended configuration.)
- **Fix — “Exit kiosk” now actually leaves to the tablet’s normal launcher.** On a device-owner
  tablet it hands the Home role back to the device’s own launcher; otherwise it opens Android’s
  Home-app picker so you can switch. (Before, Home just reopened the kiosk.)

## 0.8.0
- **Donations log + totals + CSV export (new “Donations” tab).** See every donation your kiosks have
  taken — amount, kiosk, time, one-time vs monthly, donor (if given) and status — newest first, with
  running totals for **today / this week / this month / all time**, a **per-kiosk breakdown**, and a
  one-click **Export CSV**. The dashboard’s Donations tile now shows your real all-time total. (Only
  successful donations count toward totals; monthly *renewals* are charged by Stripe and shown in your
  Stripe dashboard, not here — these figures are what the kiosks collected directly.)
- The CSV is safe to open in Excel/Sheets: donor-supplied fields are escaped against spreadsheet
  formula injection, and the export (which contains donor details) requires an admin sign-in.

## 0.7.5
- **Fix — manual card entry now works** (it was showing “that didn’t go through”). Stripe’s card form
  wasn’t being set up in time; the tablet now initialises it up front (from the publishable key sent
  with your settings), so the form opens and takes the card. If a manual payment ever does fail, the
  exact reason is now written to **Devices → Logs** so it can be diagnosed.
- **Fix — updating the kiosk from the tablet now actually works.** Because the kiosk is the tablet’s
  Home app, it couldn’t reach the browser before. Now **7 taps → PIN → Update app** first **leaves
  kiosk mode**, then opens the new app in the browser to download and install; it relaunches into
  kiosk on the new version. The admin panel’s remote “Update” button (which couldn’t reliably work)
  is gone — the **Update available** note now shows these step-by-step tablet instructions instead.

## 0.7.4
- **Manual card entry (type the card, no reader needed).** Turn on **“Allow manual card entry”** in
  **Admin → Giving screen** and donors can pay by typing their card into Stripe’s secure form —
  either as a fallback beside the reader (an **“Enter card details”** option on the payment screen)
  or as the only way to pay when the kiosk has **no reader** at all. The card is entered into Stripe’s
  own form and tokenised on the device, so your server never sees the card number (same as the
  reader). Every payment is still verified with Stripe before it’s recorded. Manual entry is one-time
  only (monthly still needs the reader). *Note: keyed cards cost a little more and carry more fraud
  risk on an unattended kiosk, so it’s off by default.*
- **Reader setup: the “Test reader” option is gone**, and there’s clear guidance for running with **no
  reader** (use manual card entry). USB and Bluetooth readers are unchanged.

## 0.7.3
- **Bluetooth readers now stay connected on their own — just like USB.** Once you connect a
  Bluetooth M2 in the tablet's settings, the kiosk remembers it and **reconnects it automatically on
  boot and whenever it drops** (a Bluetooth blip, the reader sleeping, a reboot). No more re-pairing
  by hand each time.
- **Clearer help for the “Bluetooth unexpectedly disconnected” error.** This almost always has one of
  two simple causes, so the kiosk now says exactly what to do: (1) **don't** pair the reader in the
  tablet's own Bluetooth settings — if you did, tap **Forget** there — and connect it only from the
  app; (2) **charge the reader to at least 50%** (its first connection may install a required update).

## 0.7.2
- **Fix — the Giving-screen editor now actually reaches the tablets, and the Monthly option shows.**
  The kiosk was fetching your saved giving screen but then dropping the amounts, monthly setting,
  name/email choices and thank-you message before saving them locally — so edits never appeared and
  the One-time/Monthly toggle never showed. The tablet now stores and applies the whole giving
  screen, and pulls it fresh on every launch, so your changes show within seconds (and after an app
  update, right away).
- **Fix — pressing Home no longer lets someone leave or switch launcher.** The kiosk now asks to be
  the tablet’s default Home app (there’s also a **“Set as Home app”** button in the tablet’s
  settings), so Home returns straight to the giving screen with no chooser. On a **device-owner**
  tablet it’s fully locked — Home, recents and the notification shade are all disabled; you can’t
  even press Home.
- **Fix — a kiosk shows offline much faster.** Tablets now check in every ~10 seconds and are marked
  offline after ~35 seconds (about three missed check-ins), and the Devices page refreshes every ~10
  seconds — instead of taking a couple of minutes.

## 0.7.1
- **Fix — updating the app no longer says “App not installed”.** The app is now signed with a
  permanent key, so future updates install straight over the old app with nothing lost. (Until now
  each build was signed with a throwaway key, which Android refuses to update over.) **One-time step:**
  because the signing key has changed, *this* update needs the current app **uninstalled first**, then
  install v0.7.1 from the setup page and re-pair. Your donation history is safe — it lives on the
  server, not the tablet — so you won’t lose analytics. Every update after this one is seamless.
- **Fix — the kiosk can no longer be left by pressing Home or Recents.** It now works like a proper
  single-app kiosk: leaving instantly drops you back into the giving screen, and it reopens on boot.
  (It no longer uses Android’s escapable “screen pinning”.) For a *fully* locked tablet — with the
  notification shade blocked too — set the app as the default Home app and use the one-time
  device-owner setup in docs/TABLET_SETUP.md; the app tells you this in its settings.

## 0.7.0
- **Design your giving screen (new “Giving” tab).** Set the masjid name and headline, the six preset
  amounts, custom-amount on/off with a min & max, monthly on/off, whether to ask for a name/email
  (off / optional / required), and the thank-you message — with a **live preview** of the tablet as
  you type. Saving pushes the changes to every paired kiosk within a few seconds (no reinstall).
- **USB card readers connect on their own.** Plug a USB Stripe reader into the tablet and it pairs
  automatically on startup — no setup screen — and **reconnects itself the moment it drops** (a
  knocked cable, a power blip). Bluetooth readers are still set up by hand in the tablet’s settings.
- **A truly locked kiosk (on a device-owner tablet).** When the tablet is set up as *device owner*
  (one-time ADB step, see docs/TABLET_SETUP.md), the kiosk now blocks the **notification shade**, the
  navigation buttons and the Home escape, and re-opens itself if Home is pressed — it can only be
  left with the **exit PIN**. Screen-pinning (the non-device-owner fallback) can’t fully prevent
  those, and the app now says so clearly and points you to the device-owner setup.

## 0.6.0
- **Monthly donations!** The giving screen now has a **One-time / Monthly** toggle (when you enable
  monthly in the app). A monthly donor taps their amount, enters name + email (required), and taps
  their card once: that first month is charged on the reader, and an ongoing **monthly subscription**
  is set up from that same card — the next charge is a month later (never double-charged), and Stripe
  emails the receipts automatically. If a card can't be reused for recurring giving, the one-time gift
  still counts and the donor is told kindly. You can see active subscriptions in your Stripe dashboard.
- **The tablet now clearly confirms a donation.** After the card is read it shows a **"Processing…"**
  step, then a thank-you that names the **amount given** (and, for monthly, "set up") — so a
  successful tap is unmistakable. Payment success/failure is also logged more clearly (Devices → Logs).
- **Update a kiosk from the admin panel — for real this time.** When a kiosk is out of date, press
  **Update** on its card: the tablet opens the newest app in its own browser to download and install
  (the same way you first installed it). There's step-by-step help right on the card, and the same
  **Update app** button is in the tablet's 7-tap maintenance screen. (Android won't let an app update
  itself without a person tapping "Install", so this opens that install for them.)
- **Light-mode tablets are readable again.** The kiosk is a dark-by-design giving station, so it now
  always renders dark — a tablet set to a light system theme no longer shows unreadable settings.
- **Fix — the activity-log window no longer overlaps the cards behind it.** It now floats above a
  properly dimmed page (it was being trapped inside a panel).

## 0.5.5
- **Removed the "push update to the tablet" button.** Android doesn't allow an app to update itself
  without a person tapping "Install", and inside kiosk mode even that is blocked — so a remote,
  hands-off update isn't possible on an ordinary tablet (only on ones provisioned as *device owner*).
  Rather than a button that can't deliver, the Devices page and the kiosk's own settings now just
  show **"Update available"** with clear instructions: download the latest app from your setup page
  and reinstall it on the tablet. (Automatic updates for device-owner tablets can come later.)

## 0.5.4
- **Open kiosk settings with 7 quick taps.** Tap the giving screen 7 times fast (anywhere) to bring
  up the exit-PIN, then the maintenance/settings screen — reader setup, install app updates, kiosk
  stats (now including **uptime**), and leaving kiosk mode. (Was a hidden corner tap; now it's
  anywhere on the screen.)
- **Reader firmware visibility.** When a reader needs a firmware update to connect, that's now
  logged (Devices → Logs) and shown on-screen with progress. A first connect after the reader was
  used elsewhere often triggers this — it needs the reader **charged to ≥50%** and can take a few
  minutes; keep it powered and nearby.

## 0.5.3
- **The activity log is now a proper draggable window** — bigger, centered on screen, and you can
  drag it around by its title bar. Removed the (non-functional) green "full-screen" light; the red
  light closes it.

## 0.5.2
- **Push app updates to a kiosk from the admin panel.** When a kiosk is running an older version
  than the server, an **Update to vX.Y.Z** button appears on its card (Devices). Tapping it tells
  the kiosk to download the new app and start installing on its next check-in. The kiosk also shows
  an **Install update** button in its maintenance screen when a newer version is available.
  Note: Android only lets an app update itself silently on tablets provisioned as **device owner**;
  otherwise a volunteer taps "Install" once on the tablet (same limitation as remote reboot).

## 0.5.1
- **Fix — the Dashboard now shows the real number of paired kiosks** (it was always showing 0).
- **Fix — a kiosk's activity log now opens as its own window** (dimmed backdrop, macOS-style
  traffic-light close) instead of overlapping the cards behind it.
- **Reader troubleshooting.** When a reader won't connect, the exact reason is now written to the
  kiosk's log (Devices → Logs) — most often "Payments aren't set up yet" (choose a Stripe account
  and create a card-reader location in Settings → Payments first) or the reader's own error. Scan,
  connect and connection-token steps are all logged.

## 0.5.0
- **Take donations!** The kiosk now runs the full giving flow on the tablet: tap **Tap to donate**,
  pick one of six amounts (or **Other** on a big number pad), optionally add a name/email for a
  receipt, then tap/insert/swipe on the reader. A warm thank-you shows and it resets for the next
  giver. Amounts are validated on the server and every payment is verified with Stripe before it's
  recorded — the tablet's word is never trusted, and card data goes reader → Stripe only.
- The giving screen (amounts, custom min/max, name/email prompts, thank-you message) is read from
  the app's settings; a visual designer for it comes next.

## 0.4.5
- **Removed the "Restart" button.** Android doesn't let an app reboot the tablet unless the tablet
  is set up as a device owner, and the fallback (restarting just the app) was unreliable and looked
  like a crash. Rather than ship something that doesn't do what it says, it's gone. To restart a
  kiosk, power-cycle the tablet. (A proper device-owner-only reboot can return later if there's
  demand.)

## 0.4.4
- **Restart a kiosk remotely** (Admin → Devices → **Restart**): the tablet restarts on its next
  check-in — a full device reboot on tablets set up as device owner, or an app restart otherwise.
- **Removed the battery indicator** from the Devices page. Kiosk tablets are wall-powered, so the
  battery %/“not charging” line was just noise (and many tablets report “not charging” at 100%
  while plugged in). Reader status and app version remain.

## 0.4.3
- **Fix — the OpenMasjidOS theme AND wallpaper now reliably pass through.** The panel now always
  mirrors the dashboard's light/dark, accent and wallpaper on every open and refresh (it used to
  only sync when it *thought* it was running under the platform, and a light/dark toggle switched
  syncing off entirely — so a refresh fell back to defaults). A manual light/dark choice still
  holds for your current session. (Set an `https://` image URL in OpenMasjidOS → Settings.)
- The About/status now reports whether the app can see OpenMasjidOS, which makes "why isn't it
  inheriting?" easy to diagnose (it means the platform's address reached the app).

## 0.4.2
- **Fix — the OpenMasjidOS wallpaper now really inherits.** Choosing light/dark in the panel used
  to quietly switch off *all* appearance syncing, so after a refresh the panel fell back to the
  default background. Now the wallpaper and accent always follow OpenMasjidOS while the app is
  opened through it; only the light/dark choice stays as you set it. (Set an `https://` image URL
  in OpenMasjidOS → Settings.)

## 0.4.1
- **Fix — the OpenMasjidOS wallpaper now shows in the admin panel.** It now inherits the
  dashboard's custom wallpaper image exactly the way the other OpenMasjid apps do — the image URL
  you set in OpenMasjidOS is used directly (make sure it's an `https://` link). This also removes
  the internal image-proxy entirely, so the previous proxy's security hardening is no longer
  needed. (Named preset wallpapers + accent color already inherited.)
- **Fix — "Identify" (flash to locate a kiosk) now actually stands out.** Tapping *Identify* in
  Admin → Devices makes the tablet pulse a bold gold wash for several seconds — easy to spot on a
  wall. Kiosks also now check in every 15s (was 45s), so Identify, config changes and online
  status show up much faster. (Devices with animations turned off get a strong steady wash.)

## 0.4.0
- **Card reader (Stripe Reader M2).** Set up and manage the reader from the kiosk's PIN-protected
  maintenance screen: choose **Bluetooth**, **USB**, or the built-in **Test reader**, find it,
  connect it to your card-reader location, and it handles firmware updates automatically. The
  reader auto-reconnects if it briefly drops, and its status, serial and battery now show on the
  **Devices** page so you can spot a flat or unplugged reader remotely.
- The reader talks to Stripe with a short-lived **connection token** the server mints on demand —
  the tablet never holds your Stripe secret key, and card data goes reader → Stripe only.
- New guide: **docs/READER_SETUP.md** (charging, Bluetooth vs USB, permissions, troubleshooting).
- Reader polish: denying a Bluetooth/Location permission now explains how to fix it (instead of the
  Find button doing nothing); scanning can't collide with an in-progress connection; and leaving
  kiosk mode now always requires a verified exit PIN (it can't be bypassed in the brief window
  after you set a PIN but before it reaches the tablet).
- **Security hardening of the wallpaper proxy** (also fixes the same issue introduced in 0.3.2):
  the server only fetches images from your OpenMasjidOS or a public address — never loopback,
  private, or cloud-metadata addresses, even via redirects — caps and times out the download so a
  bad image host can't wedge it, and refuses SVG (so a wallpaper can never run code on the admin
  page).
- Taking donations with the reader arrives in the next update.

## 0.3.2
- **Fix — the OpenMasjidOS wallpaper now shows even when the image URL is "unusual".** The
  proxy that brings your OS wallpaper onto the kiosk's secure page used to require the image
  host to label the file as an image; many hosts (and uploaded files) serve images as a
  generic download type, so the wallpaper silently failed. It now identifies the image from
  its actual contents (and, if needed, the file extension), sends a browser-like request so
  picky hosts don't refuse it, resolves uploaded/relative image paths against your OS, and
  waits a little longer for large images.

## 0.3.1
- **Fix — pairing now works.** The tablet was reading responses at the top level but the
  server wraps them in a `{ data }` envelope, so pairing (and every kiosk call) failed with
  "something went wrong" even though the server had already created the device. The kiosk
  app now unwraps the envelope.
- **Fix — "Remove" hides a kiosk.** Revoked devices are excluded from the Devices list, so
  removing a kiosk makes it disappear (its token still dies, so the tablet returns to
  pairing on its next heartbeat).
- **HTTP → HTTPS.** Insecure browser visits are upgraded to HTTPS automatically (the app
  learns its HTTPS address from the platform proxy) so no one lands on a non-secure page.
  (The tablet already refuses anything but pinned HTTPS.)

## 0.3.0
- **Pair a tablet & manage your kiosks** (Admin → Devices): generate a single-use **6-digit
  pairing code** (no camera/QR) and type it into the kiosk app; then see each kiosk's live
  status (online, battery + a "not charging" warning, reader, app version), rename, identify
  (flash it), view its logs, and revoke it. Set the kiosk **exit PIN** here — staff type it
  to leave the giving screen; it's verified on the tablet even offline.
- **Android kiosk app:** pairs over **pinned HTTPS** with trust-on-first-use certificate
  pinning + a device token; runs as a Lock-Task launcher (device-owner) with a screen-
  pinning fallback and keep-awake; a hidden 5-tap corner gesture opens the PIN-protected
  maintenance screen (diagnostics, re-pair, exit); WorkManager + a foreground loop send
  heartbeats. (The card reader + the giving flow are the next updates.)
- Security: device tokens are HMAC-hashed at rest and revocable; pairing codes are single-
  use, 10-minute, and rate-limited; the exit PIN is a portable scrypt hash.

## 0.2.1
- **Fix: the OpenMasjidOS wallpaper now shows in the kiosk.** Custom wallpaper *images* are
  proxied through the app's own HTTPS origin (`/api/public/wallpaper`) — the platform serves
  them over plain HTTP, which a secure page otherwise blocks as mixed content; this also
  fixes on-image text readability (canvas luminance). Named preset wallpapers + the accent
  color already inherited. Note: the OS **"ambient" video** backdrop is a per-device local
  setting and is deliberately not shared over the Fabric, so it can't be inherited — pick a
  preset or a wallpaper image in OpenMasjidOS for the kiosk to match.

All notable changes to **OpenMasjid Kiosk**. The version here, `VERSION`, `manifest.yaml`,
the `server/`+`web/` `package.json`, and the git tag `vX.Y.Z` all move together — bump them
on every published build so OpenMasjidOS offers a normal **Update** (no reinstall).

## 0.2.0
- **Payments setup** (admin → Settings → Payments): pick your Stripe account from
  OpenMasjidOS via the Fabric (in-app account picker, no keys pasted), or enter keys
  manually when running standalone.
- **Stripe Terminal Location** management — create a location from your masjid address, or
  pick an existing one (readers must connect to a location).
- **Currency** selection, a **TEST MODE** badge whenever test keys are in use, and a
  **Test connection** button that mints a Terminal connection token to confirm Stripe +
  the reader path work end-to-end.
- Masjid name + address collected in-app (the platform injects no profile).
- Under the hood: Stripe Terminal server SDK (pinned API version), keys held in memory only
  (never sent to the tablet/browser, never persisted).

## 0.1.0
- Initial release. OpenMasjidOS app: one container (Fastify + SQLite + React admin),
  digest-pinned multi-arch image, AGPL-3.0.
- **OpenMasjidOS Fabric:** single sign-on with a local-password fallback, live
  theme/wallpaper inheritance (including custom wallpaper images), restore-resilience,
  best-effort notifications.
- **OpenMasjidOS-style admin shell:** bottom dock (Dashboard / Devices / Analytics /
  Settings), a profile menu (light-dark toggle, Settings, Sign out, version).
- **`/new` tablet setup page** serving the bundled Android APK; **6-digit** pairing model
  (no camera/QR).
- Android kiosk app shell (Kotlin + Compose), CI to GHCR + APK bundling.
