<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Students integration — the `tuition` campaign type (kiosk / card-present)

> **One line:** when a campaign's type is **`tuition`**, the kiosk tile does **not** run its own
> donation flow. It becomes a thin shell around the **OpenMasjid Students** app: a parent taps the
> tile, types their **child's name + PIN** on the tablet, we verify + fetch the balance from Students
> over the Fabric, they pay the whole balance or pick which months, they tap/insert the card on the
> **Reader M2**, and we record the payment back into the Students ledger. **Students owns everything
> inside the tuition tile** — the label, the lookup, the balance, the allocation, the recording. The
> kiosk only renders the shell and drives the reader.

The contract is **`students/billing` v1**, defined verbatim in the Students repo:
`OpenMasjidStudentManager/docs/FABRIC_BILLING_CONTRACT.md` (§11) — the source of truth for every
request/response shape below. If it and this brief disagree, the contract wins. Every response carries
`"v": 1`.

---

## 0. What the parent sees at the kiosk (the required flow)

A `tuition` tile runs **exactly this**, nothing more:

1. Tap the **tuition tile** (labelled from `info.schoolName` / `info.tagline`).
2. **Two fields on the tablet:** *Student name* and *PIN*. Nothing else — no amount pad up front.
3. Tap **Find my balance** → kiosk server calls `lookup` (name + PIN).
   - Not found → one friendly line (“We couldn’t find that — please check the name and PIN, or ask the
     office”). **No hint about which part was wrong** (Students returns a uniform `found:false`).
4. **Verified** → show the **family label**, the **current balance due**, and the **open invoices**
   (one row per month/term, each with its own amount + due date).
5. **Pay:** two choices —
   - **Pay the full balance** (the whole `balanceCents`), or
   - **Choose what to pay** — tick one or more invoices (e.g. one or two months) and pay just those.
6. **Present card on the Reader M2** (card-present PaymentIntent). On approval → we record it into
   Students and print/show a receipt that says **“payment”**, never “donation”. Done.

No account, no login — the same anonymous, walk-up model as every other kiosk tile.

---

## 1. Manifest — declare that we consume the capability

Add to `manifest.yaml` (without it every broker call is `403 not_granted`):

```yaml
fabric:
  consumes:
    - capability: billing
      provider: students     # the provider app id the OS broker routes us to
```

(Exact key spelling follows `OpenMasjidAPPS/docs/BUILDING_AN_APP.md` + the OS work order
`FABRIC_APP_LINK_AND_TUNNEL.md`; the capability name is `students/billing`.) We already inject
`OPENMASJID_BASE_URL` + `OPENMASJID_APP_SECRET`.

---

## 2. Transport — kiosk **server** → OS broker (the tablet never holds the secret)

The `OPENMASJID_APP_SECRET` lives on the **kiosk server only**. The tablet calls the kiosk server; the
kiosk server calls the OS broker. **Never ship the app secret to the tablet.**

```
POST ${OPENMASJID_BASE_URL}/api/fabric/app/students/billing/<method>
Header:  X-OpenMasjid-App-Secret: <OUR OWN app secret>     # proves who we are to the OS
Body:    application/json, { "v": 1, ... }, ≤ 256 KB, respond < 10 s
```

The OS core verifies **our** secret, checks our manifest declares `fabric.consumes: [students/billing]`,
then proxies to Students (adding proof-of-platform + `X-OpenMasjid-Caller-App: kiosk`). We never hold
the Students app’s secret and never reach it directly.

**Errors — always fail soft:**
- App errors: HTTP status + `{ "error": { "code", "message" } }`.
- Broker errors: `{ "fabric_error": { "code", "message" } }` — `target_not_installed`,
  `target_unreachable`, `timeout`, `not_granted`, `rate_limited`. On ANY of these: hide the tuition
  tile (or show “tuition is temporarily unavailable”). Never wedge the kiosk.

---

## 3. The methods (see the contract for full shapes)

### `info` — should the tuition tile show at all?
```jsonc
{ "v": 1 }
→ { "v": 1, "enabled": true, "schoolName": "An-Noor Weekend School",
    "currency": "usd", "tagline": "Pay tuition with your child's name and PIN" }
```
`enabled:false` (school not set up / external payments off) → **hide the tuition tile**. Poll on the
same cadence you refresh campaigns.

### `lookup` — name + PIN → family + balance (step 3→4)
```jsonc
{ "v": 1, "name": "Yusuf Ismail", "pin": "482913" }
// found:
→ { "v": 1, "found": true,
    "matchedStudent": { "id": "stu_1" },
    "family": { "id": "fam_x1", "label": "Ismail family",
      "students": [{ "firstName": "Yusuf", "lastInitial": "I" }],
      "balanceCents": 35000, "currency": "usd",
      "openInvoices": [{ "id": "inv_9", "label": "Tuition — Jul 2026",
                         "dueDate": "2026-07-01", "balanceCents": 15000 }] } }
// not found (identical shape + latency whatever mismatched):
→ { "v": 1, "found": false }
```
Show the balance from `family.balanceCents`; render one selectable row per `openInvoices[]` (the
“pick months” list). **Never display more than the contract returns** — no full last names, DOB, or
contact info. Hold `family.id` + `matchedStudent.id` on the kiosk server for the pay step; the tablet
only needs display fields.

### The charge (our job — Stripe Terminal / Reader M2, card-present)
On the Stripe account the reader is registered to (see §4), create a **card-present** PaymentIntent for
the full `balanceCents` or the sum of the ticked invoices, then collect + process on the reader with
the existing kiosk Terminal flow (connection token → `collectPaymentMethod` → `processPayment`). Put
the **§11.3 metadata on the PaymentIntent**:
```
purpose             = students-billing        (REQUIRED — the reconciliation discriminator)
omos_app            = kiosk
students_family_id  = fam_x1                   (REQUIRED, from lookup)
students_student_id = stu_1                     (optional, matchedStudent.id)
```
Description: `School balance — <family label>`. **Never** put the PIN or the typed name in metadata,
description, receipt, or any log — metadata is visible in the Stripe dashboard + exports.

### `record-payment` — book it in the Students ledger (idempotent)
After the reader approves and the PaymentIntent succeeds:
```jsonc
{ "v": 1,
  "idempotencyKey": "pi_3PabcDEF",        // the Stripe PaymentIntent id
  "familyId": "fam_x1",
  "studentId": "stu_1",                   // optional
  "amountCents": 15000, "currency": "usd",
  "channel": "kiosk",
  "occurredAt": "2026-07-15T18:03:22Z",
  "externalRef": { "stripePaymentIntentId": "pi_3PabcDEF", "stripeChargeId": "ch_...", "stripeAccountId": "acct_..." },
  "allocations": [{ "invoiceId": "inv_9", "amountCents": 15000 }],   // OMIT for “pay full balance” → auto oldest-due-first
  "payerNote": "paid at the front desk" }  // optional, ≤200 chars
→ { "v": 1, "recorded": true, "paymentId": "pay_71", "duplicate": false }
```
- **Full balance** → omit `allocations` (Students auto-allocates oldest-due-first; surplus → credit).
- **Specific months** → one `allocations[]` entry per ticked invoice (its `id` + the amount charged for
  it). Students validates them.
- Idempotent on `idempotencyKey` (= the PI id); a replay returns the original `paymentId` with
  `duplicate:true`.

### `check` — outbox retry (matters more on a kiosk)
A kiosk can lose connectivity right after the card approves. **Never let that lose the record.** Keep a
persistent server-side outbox: after approval, enqueue the `record-payment`; if it doesn’t confirm,
retry, and poll `check`:
```jsonc
{ "v": 1, "idempotencyKey": "pi_3PabcDEF" } → { "v": 1, "recorded": true, "paymentId": "pay_71" } | { "v": 1, "recorded": false }
```
Students’ **daily reconciliation** scans succeeded `purpose=students-billing` PIs and is the final
backstop — so as long as the PI was on the right account (§4), **money is never lost**, only delayed.

---

## 4. Which Stripe account? — a reader is bound to ONE account, and it must be the tuition account

A Stripe Terminal reader is registered to **one** Stripe account (its connection tokens + Terminal
Location are account-scoped). So card-present tuition can only be charged on the account the kiosk’s
reader is already tied to. For reconciliation + correct routing of tuition money:

> **The kiosk’s Stripe account MUST be the same OpenMasjidOS-vault account the school picked in
> OpenMasjid Students → Settings → Payments.**

Because:
- The money should land in the school’s tuition account.
- Students’ reconciliation safety net scans **that** account for `purpose=students-billing` PIs; a PI on
  a different account would never be reconciled if our push call was missed.

If the masjid wants tuition on a *different* Stripe account than its general kiosk donations, that
requires a second reader bound to that account — out of scope here. Surface a clear setup note: *“To
accept tuition at the kiosk, use the same Stripe account as OpenMasjid Students.”* When `info` says
`enabled:true` but the kiosk’s account differs from the school’s, warn the admin rather than silently
charging the wrong account.

---

## 5. Wording + tax (§11.3 — non-negotiable)

- The receipt (printed + on-screen) says **“payment”**, never **“donation.”** Tuition is generally not
  tax-deductible.
- **Exclude** `purpose=students-billing` payments from donation totals, kiosk metrics, and year-end tax
  letters. They are not gifts.

---

## 6. Security (§14)

- The **app secret stays on the kiosk server**, never on the tablet (§2).
- **Rate-limit the lookup** on the kiosk server (it takes a PIN). Students also locks a PIN after
  repeated failures and returns a uniform `found:false`, but the kiosk must not be the open relay that
  lets someone grind PINs at the front desk — cap attempts per session/device.
- The PIN is **inert input**: it lives only in the lookup request body — **never** in a URL, a log line,
  Stripe metadata, the receipt, or the Terminal display. Store nothing about the lookup after the tile
  closes.
- Treat every `lookup` field as hostile text; render family/student data as text, never HTML.
- On `found:false`, same message + timing regardless — no enumeration.
- Clear the entered name/PIN + the looked-up family from the tablet when the tile is closed or times
  out (walk-up device — don’t leave one family’s balance on screen for the next person).

---

## 7. Definition of done

- `manifest.yaml` declares `fabric.consumes: [students/billing]`; the broker call returns 200 (not
  `not_granted`) once the OS grants it.
- The tuition tile renders the **name + PIN** shell (no amount pad), verifies via `lookup`, shows the
  balance + per-month invoices, and offers **pay-all** and **pick-months**.
- A card-present approval calls `record-payment` (allocations for picked months; omitted for full
  balance), idempotent on the PI id; a dropped confirmation is retried from a persistent outbox +
  `check`.
- The tuition tile charges the reader’s account, which is the **school’s tuition Stripe account** (§4);
  a mismatch warns the admin.
- Receipt says **“payment”**; tuition is excluded from donation totals + year-end letters.
- Everything **fails soft** when Students is unreachable / `enabled:false` / a `fabric_error` arrives.
- The app secret never reaches the tablet; the lookup is rate-limited; the PIN never appears in logs,
  the receipt, the reader display, or metadata; name/PIN/family cleared on tile close.
