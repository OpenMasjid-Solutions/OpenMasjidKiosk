<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Students integration — the `tuition` campaign type (kiosk / card-present)

> **One line:** when a campaign's type is **`tuition`**, the kiosk tile does **not** run its own
> donation flow. It becomes a thin shell around the **OpenMasjid Students** app: a parent taps the
> tile, types their **child's Student ID** on the tablet, confirms the name we echo back, we fetch the
> balance from Students over the Fabric, they pay the whole balance or pick which months, they
> tap/insert the card on the **Reader M2**, and we record the payment back into the Students ledger.
> **Students owns everything inside the tuition tile** — the label, the lookup, the balance, the
> allocation, the recording. The kiosk only renders the shell and drives the reader.

The contract is **`students/billing` v2**, defined verbatim in the Students repo:
`OpenMasjidStudentManager/docs/FABRIC_BILLING_CONTRACT.md` (§11) — the source of truth for every
request/response shape below, and copied into this repo as
[`docs/FABRIC_BILLING_CONTRACT.md`](FABRIC_BILLING_CONTRACT.md). If it and this brief disagree, the
contract wins. Responses carry `"v": 2`.

**What changed at v2 (Students 0.39.0, §11.0) — and what did not:**

- **PINs are gone.** `lookup` no longer takes `name` + `pin`; it takes the **Student ID** alone
  (`YUS1234` — three letters from the first name + four digits, printed on the statement). A v1-shaped
  lookup now **400s**, so this is not optional: an un-upgraded kiosk's tuition screen simply breaks.
- **`identify` replaced the PIN.** We resolve the typed ID to a first name, the parent confirms "yes,
  that's my child", and only then do we call `lookup`. That confirmation catches the realistic failure
  (a mistyped ID) that a PIN never did.
- **Bills are per child.** `lookup` reports a balance per student as well as the household total, and
  every open invoice says which child it belongs to.
- **The money path is untouched.** `info`, `record-payment` and `check` are byte-identical between v1
  and v2; we deliberately still send them as `"v": 1` (the provider accepts both) so a recorded payment
  never depends on this upgrade. Only a charge carrying a v2-era breakdown (`students[]`, `lines[]`)
  announces `"v": 2`.

**Added since, additively — no version bump, and nothing breaks if a school is on an older Students:**

- **0.41.0 (§11.0a) — paying ahead and credit.** `info.allowAdvance` + `info.minAmountCents`, and a
  `creditCents` beside every `balanceCents` in `lookup`. A derived balance of `0` is ambiguous — square,
  paid ahead, or "you can't pay here" — and these are what tell them apart.
- **0.43.0 (§11.0b) — itemised bills.** Each `openInvoices[]` entry now carries `items[]`: the lines the
  bill is made of (`{ id, label, kind, amountCents, balanceCents }`, `kind` = `tuition` | `charge` |
  `credit`). A February bill is routinely £200 of tuition plus a £50 book fee, and a parent asking to
  pay one of the two could not be served while a bill was one label and one number. `record-payment`
  takes the matching `lines[]`. **Absent on an older Students, and then everything behaves exactly as
  it did** — one label, one number, one tick.

---

## 0. What the parent sees at the kiosk (the required flow)

A `tuition` tile runs **exactly this**, nothing more:

1. Tap the **tuition tile** (labelled from `info.schoolName` / `info.tagline`).
2. **One field on the tablet:** the child's *Student ID*. Nothing else — no PIN, no amount pad up front.
3. Tap **Continue** → kiosk server calls `identify` (the ID alone).
   - Not found → one friendly line (“We couldn’t find that — please check the Student ID, or ask the
     office”). **No hint about what was wrong** (Students returns a uniform `found:false` for an
     unknown, withdrawn or locked ID).
4. **Confirm the child:** “Is this **Yusuf I.**?” — *Yes, show the balance* / *No — try another ID*.
   **No balance is fetched or shown until they say yes.** This step is required by §11.2, not a nicety.
5. **Confirmed** → kiosk server calls `lookup` with the same ID → show the account **child by child**:
   the family label and household total up top, then a section per sibling with **that child's** own
   balance or credit and **that child's** bills. Each bill shows its own amount and due date, and where
   the school itemises (0.43.0) the lines it is made of, under the month as a heading.
6. **Pay:** the choices —
   - **Pay the full balance** (the whole household `balanceCents`) — the default, one tap; or
   - **Choose what to pay** — tick whole bills, or individual **lines** ("just the book fee"); or
   - **Add money for a child** — type an amount towards one child, which is also the only way to pay
     when nothing is due (a term up front). Offered only when `info.allowAdvance` says so.
   With nothing due the screen still **says so first** — the balance, the credit, or "Nothing due" —
   and the amount pad is something the parent chooses, never what they land on.
6b. **If — and only if — the school passes Stripe's cut to the payer** (`info.fee.enabled`, 0.51.0),
   an extra screen appears before the reader is armed, showing the itemised total and saying whose
   money the extra is:

   > **Tuition** $100.00
   > **Card processing fee** $3.30
   > **Total charged** $103.30
   >
   > This fee does not go to the madrasah — it is what Visa, Mastercard and American Express charge to
   > accept a card, and it goes straight to the payment processor. Paying by cash or cheque at the
   > office avoids it.

   This is a **requirement** (§11.4), not a nicety, and it is deliberately before the reader is armed:
   a total that first appears on the card reader is what generates phone calls to the office. Almost
   every school absorbs the fee and never sees this screen at all.

   **The tablet holds no rate and does no arithmetic.** Every figure comes from the server's reply to
   the PaymentIntent it just created, so the total shown is by construction the total the card is
   asked for. That is also why the fee rate is absent from `tuition/info` and `tuition/lookup` — there
   is nothing for a device to get wrong.

7. **Present card on the Reader M2** (card-present PaymentIntent). On approval → we record it into
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
Body:    application/json, { "v": 2, ... }, ≤ 256 KB, respond < 10 s
         # "v": 2 on identify + lookup; "v": 1 on info / record-payment / check (unchanged shapes)
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
→ { "v": 2, "enabled": true, "schoolName": "An-Noor Weekend School",
    "currency": "usd", "tagline": "Pay tuition with your child's Student ID" }
```
`enabled:false` (school not set up / external payments off) → **hide the tuition tile**. Poll on the
same cadence you refresh campaigns.

### `identify` — Student ID → the child's name (step 3→4)
```jsonc
{ "v": 2, "studentCode": "YUS1234" }        // normalised there too, so "yus-1234" is fine
// found — a first name + last initial and NOTHING else:
→ { "v": 2, "found": true, "student": { "studentCode": "YUS1234", "firstName": "Yusuf", "lastInitial": "I" } }
// not found (unknown / withdrawn / locked ID, or tuition switched off):
→ { "v": 2, "found": false }
```
**Call this first.** It carries no balance, no invoices, no siblings and no family id — which is what
makes it safe to answer *before* the parent has confirmed anything. Show the name, ask “is this your
child?”, and only call `lookup` on a yes.

### `lookup` — a confirmed Student ID → family + balance (step 5)
```jsonc
{ "v": 2, "studentCode": "YUS1234" }         // v2: no `name`, no `pin` — a v1 body 400s
// found:
→ { "v": 2, "found": true,
    "matchedStudent": { "id": "stu_1", "balanceCents": 20000 },
    "family": { "id": "fam_x1", "label": "Ismail family",
      "students": [{ "studentId": "stu_1", "studentCode": "YUS1234", "firstName": "Yusuf",
                     "lastInitial": "I", "balanceCents": 20000 }],
      "balanceCents": 35000, "creditCents": 0, "currency": "usd",
      "openInvoices": [{ "id": "inv_9", "studentId": "stu_2", "label": "Tuition — Jul 2026",
                         "dueDate": "2026-07-01", "balanceCents": 15000,
                         // 0.43.0: what the bill is MADE OF. sum(items[].balanceCents) === the bill.
                         "items": [{ "id": "iti_1", "label": "Monthly tuition", "kind": "tuition",
                                     "amountCents": 10000, "balanceCents": 10000 },
                                   { "id": "iti_2", "label": "Book fee", "kind": "charge",
                                     "amountCents": 5000, "balanceCents": 5000 }] }] } }
// not found (identical shape + latency whatever mismatched):
→ { "v": 2, "found": false }
```
**Group by child, don't flatten.** Bills are per student at v2, so a household list is two identically
labelled "Tuition — Jul 2026" rows with no way to tell them apart, and a household total cannot say
which child is in credit. The kiosk server therefore returns the invoices already grouped into a
`family.students[]` section per child — name, that child's `balanceCents`/`creditCents`, and their own
bills — and the tablet renders one section each.

**Rendering the lines.** A bill with a single line stays a single row, exactly as before. With several,
show the month as a heading and the lines beneath it; offer only the ones with a balance, show settled
ones as done, and show a `credit` line (a bursary) as information — never as something payable. Treat
`kind` as an **open set**: render an unknown kind as a plain line rather than dropping it, or the lines
stop adding up to the bill.

**Never display more than the contract returns** — no full last names, DOB, or contact info. Hold
`family.id` + `matchedStudent.id` and the internal `studentId`s on the kiosk **server** for the pay
step; the tablet gets display fields plus opaque handles (a session id, invoice/item ids, and a
positional `key` per child, `s0`/`s1`/…) — never a school id.

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
Description: `School balance — <family label>`. **Never** put the Student ID or a child's name in
metadata, description, receipt, or any log (§11.3) — metadata is visible in the Stripe dashboard +
exports.

### `record-payment` — book it in the Students ledger (idempotent)
After the reader approves and the PaymentIntent succeeds. Unchanged at v2 and still sent as `"v": 1`,
so the money path never depends on the lookup upgrade (v2 adds an optional per-child `students[]`
breakdown we don't need — omit it and Students derives the split itself, oldest-due-first):
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
  "feeCents": 330,                        // 0.51.0, optional: Stripe's cut IF the payer covered it
  "payerNote": "paid at the front desk" }  // optional, ≤200 chars
→ { "v": 1, "recorded": true, "paymentId": "pay_71", "duplicate": false }
```
**`amountCents` is the TUITION — the gross never goes there.** This is the one mistake in the whole
fee feature that corrupts data rather than merely annoying somebody, and the contract calls the two
failure directions deliberately lopsided:

| Mistake | Cost |
| --- | --- |
| Forget `students_fee_cents` on the PaymentIntent | Reconciliation credits the full charge — a small credit on one family's account. |
| Put the **gross** in `amountCents` | The ledger is wrong until a human notices: Stripe's cut is credited to the family as an overpayment, silently eating into their next bill, compounding for as long as the setting is on. |

**So when in doubt, send the tuition.** Our outbox stores the two separately (`amount_minor` is the
tuition, `fee_minor` the cut) precisely so the wrong one cannot be reached for by accident.
**Exactly one breakdown, never two.** The provider prefers `lines` > `allocations` > `students`, so
sending more than one is the wire saying two different things about the same money. What we send:

- **Full balance** → no breakdown at all (Students auto-allocates oldest-due-first across the family;
  surplus → that child's credit). That is exactly what "pay everything" means.
- **Ticked lines, or whole bills that are itemised** → `lines: [{ itemId, amountCents }]`, summing
  exactly to `amountCents`, and **nothing else** (`"v": 2`).

  > **`lines` is honoured, not merely accepted** (0.43.0): the choice is stored with the payment and
  > re-applied whenever Students recomputes its allocations, so the book fee a parent deliberately paid
  > still reads settled on next month's statement. It is also strict — every `itemId` must come from a
  > lookup in the same session and belong to that family, or the call is a `422 invalid_allocation`.
  > That is why a partial `lines[]` is never sent: our server only builds one when it covers the whole
  > charge to the penny, and falls back to the shape below when it can't.

- **Whole bills from a school that doesn't itemise** → `allocations[]` per ticked invoice **and** a
  `students[]` breakdown grouping them by child, summing exactly to `amountCents` (`"v": 2`).

  > **Why both.** `allocations[]` was in the contract from v1 but was parsed and **ignored** until
  > 0.43.0 — a consumer asking for a particular bill got oldest-due-first with nothing to say so. It
  > works from 0.43.0, normalised into the same line mechanism, but is a **hint**: what a named invoice
  > can't absorb (the office took cash between our lookup and our record) is recorded as ordinary money
  > on that child rather than rejected, because by then the card is captured. `students[]` is what an
  > older Students actually splits by, so sending both keeps the per-child ledger right on every
  > provider version.

- **A typed amount for one child** ("add money for Maryam", or paying ahead) → a one-entry
  `students[]`, so the surplus becomes **that child's** credit rather than being walked across the
  household. `students_student_id` on the PaymentIntent names the same child.

  Within one child's share, Students applies oldest-due-first among *that child's* invoices, so ticking
  their August bill while July is open pays July down first — unless `lines` named the line, which is
  the whole point of it. The child and the amount are right either way.
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
- **Rate-limit `identify` and `lookup` on ONE shared bucket** on the kiosk server (20 / 60 s per peer,
  counted whether or not the call succeeds). A Student ID is not a secret — it is printed on statements
  and its letters come from the child's first name — but it is the whole credential for "see a balance
  and pay it", and 4 digits is ~10k guesses per prefix. Students locks a code after 6 failed probes an
  hour (`identify`, `lookup` and its own parent registration share that bucket, so a sweep can't launder
  failures by switching endpoints); the kiosk must not be the open relay that lets someone grind IDs at
  the front desk. Splitting our budget per endpoint would defeat it the same way.
- The Student ID is **inert input**: it lives only in the identify/lookup request body — **never** in a
  URL, a log line, Stripe metadata, the receipt, or the Terminal display. Store nothing about the lookup
  after the tile closes.
- **Never skip the confirmation step.** `lookup` is called only after the parent confirms the name from
  `identify` (§11.2). That is what stops a mistyped ID from paying a stranger's bill.
- Treat every `identify`/`lookup` field as hostile text; render family/student data as text, never HTML.
- On `found:false`, same message + timing regardless — no enumeration.
- Clear the entered Student ID, the confirmed name + the looked-up family from the tablet when the tile
  is closed or times out (walk-up device — don’t leave one family’s balance on screen for the next
  person).

---

## 7. Definition of done

- `manifest.yaml` declares `fabric.consumes: [students/billing]`; the broker call returns 200 (not
  `not_granted`) once the OS grants it.
- The tuition tile renders the **Student ID** shell (one field, no PIN, no amount pad), confirms the
  child's name via `identify`, then fetches the account via `lookup` and shows it **child by child** —
  each sibling's own balance or credit and their own bills — offering **pay-all**, **pick what to pay**
  (whole bills, or individual lines where the school itemises), and **add money for a child**.
- With nothing due, the screen says so — the credit, or "Nothing due" — **before** offering an amount
  pad. The pad is never the landing screen.
- A card-present approval calls `record-payment` with **exactly one** breakdown — `lines[]` for a
  ticked/itemised charge, `allocations[]` + `students[]` for a non-itemised one, a one-entry
  `students[]` for a per-child typed amount, none for a full balance — idempotent on the PI id; a
  dropped confirmation is retried from a persistent outbox + `check`, with the breakdown stored so a
  retry after a restart still attributes the same way.
- The tuition tile charges the reader’s account, which is the **school’s tuition Stripe account** (§4);
  a mismatch warns the admin.
- Receipt says **“payment”**; tuition is excluded from donation totals + year-end letters.
- Everything **fails soft** when Students is unreachable / `enabled:false` / a `fabric_error` arrives.
- The app secret never reaches the tablet; identify + lookup share one rate-limit bucket; the Student ID
  never appears in logs, the receipt, the reader display, or metadata; ID/name/family cleared on tile
  close.
