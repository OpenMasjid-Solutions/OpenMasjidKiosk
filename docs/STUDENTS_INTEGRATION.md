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
request/response shape below. If it and this brief disagree, the contract wins. Responses carry
`"v": 2`.

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
  never depends on this upgrade.

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
5. **Confirmed** → kiosk server calls `lookup` with the same ID → show the **family label**, the
   **current balance due**, and the **open invoices** (one row per month/term, each with its own
   amount, due date and — when there are siblings — whose bill it is).
6. **Pay:** two choices —
   - **Pay the full balance** (the whole household `balanceCents`), or
   - **Choose what to pay** — tick one or more invoices (e.g. one or two months) and pay just those.
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
      "balanceCents": 35000, "currency": "usd",
      "openInvoices": [{ "id": "inv_9", "studentId": "stu_2", "label": "Tuition — Jul 2026",
                         "dueDate": "2026-07-01", "balanceCents": 15000 }] } }
// not found (identical shape + latency whatever mismatched):
→ { "v": 2, "found": false }
```
Show the balance from `family.balanceCents`; render one selectable row per `openInvoices[]` (the
“pick months” list), and label each row with the child it belongs to (`studentId` → that child's first
name from `family.students[]`) when the family has more than one — bills are per student at v2, so two
children produce two identically-labelled rows otherwise. **Never display more than the contract
returns** — no full last names, DOB, or contact info. Hold `family.id` + `matchedStudent.id` (and the
internal `studentId`s) on the kiosk server for the pay step; the tablet only gets display fields.

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
  "payerNote": "paid at the front desk" }  // optional, ≤200 chars
→ { "v": 1, "recorded": true, "paymentId": "pay_71", "duplicate": false }
```
- **Full balance** → omit `allocations` **and** `students` (Students auto-allocates oldest-due-first
  across the family; surplus → that child's credit). That is exactly what "pay everything" means.
- **Specific months** → one `allocations[]` entry per ticked invoice **and** a `students[]` breakdown
  grouping those invoices by child, summing exactly to `amountCents`.

  > **Send `students[]` — this is not optional in practice.** Students 0.39.0 derives the ledger split
  > from `students[]`; when it is absent it walks the *whole family's* open invoices oldest-due-first.
  > Its Fabric `record-payment` **parses `allocations[]` but does not use it** (`recordSplit` takes only
  > the per-child shares). So with two children, ticking Maryam's July bill and sending allocations
  > alone books the money against Yusuf's older bill instead — the charge and the household balance are
  > right, the per-child ledger is not. We send both: `students[]` for the split that actually lands,
  > `allocations[]` because the contract still documents it and a later Students may honour it again.
  > **Flagged upstream:** §11.2 still presents `allocations[]` as honoured — contract and implementation
  > disagree there, and the implementation is what runs.

  Within one child's share, Students applies oldest-due-first among *that child's* invoices, so ticking
  their August bill while July is open pays July down first. The child and the amount are right; which
  of their own months clears is Students' call.
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
  child's name via `identify`, then fetches the balance + per-month invoices via `lookup` and offers
  **pay-all** and **pick-months**. Invoices are labelled with the child when there are siblings.
- A card-present approval calls `record-payment` (for picked months: `allocations[]` **plus** the
  per-child `students[]` split; both omitted for full balance), idempotent on the PI id; a dropped
  confirmation is retried from a persistent outbox + `check`, with the split stored so a retry after a
  restart still attributes the same way.
- The tuition tile charges the reader’s account, which is the **school’s tuition Stripe account** (§4);
  a mismatch warns the admin.
- Receipt says **“payment”**; tuition is excluded from donation totals + year-end letters.
- Everything **fails soft** when Students is unreachable / `enabled:false` / a `fabric_error` arrives.
- The app secret never reaches the tablet; identify + lookup share one rate-limit bucket; the Student ID
  never appears in logs, the receipt, the reader display, or metadata; ID/name/family cleared on tile
  close.
