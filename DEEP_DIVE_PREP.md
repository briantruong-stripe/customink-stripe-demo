# CustomInk × Stripe Connect — Deep Dive Prep
**Internal · Solutions / SA Team · Do not share externally**

---

## How to use this doc

Each section maps to a topic that's likely to surface in a technical deep dive. For every question, there's a **short answer** (what to say in the room) and a **full answer** (what's behind it, if they push). Objections include a response you can give on the spot — no "let me get back to you."

---

## Part 1 — Connect Architecture & Account Types

### "Why Express and not Standard or Custom?"

**Short answer:** Express is the only account type where Stripe hosts KYC and the org dashboard without Custom Ink having to build or own either. Standard gives orgs too much control (they see full Stripe, can change payout settings). Custom means Custom Ink builds the entire onboarding and dashboard UI themselves — that's exactly the work we're selling them out of.

**Full answer:**
| | Standard | Express | Custom |
|---|---|---|---|
| KYC hosted by | Stripe | **Stripe** | Custom Ink |
| Dashboard | Full Stripe dashboard (org sees everything) | **Lightweight Express portal** | Custom Ink builds it |
| Onboarding | Stripe-hosted | **Stripe-hosted** | Custom Ink builds it |
| Platform control | Minimal | **High** | Total |
| Build burden | Low | **Low** | Very high |

For Custom Ink specifically: orgs don't need to see raw Stripe data or manage their Stripe settings. They need to verify identity, connect a bank, and see their payout history. Express does exactly that. Standard would expose too much (orgs could change their own payout schedules, see Custom Ink's platform data). Custom would require Custom Ink to build W-9 collection, KYC flows, and a payout portal — the entire problem they have today.

---

### "What's the difference between destination charges and direct charges?"

**Short answer:** With destination charges, the charge is on Custom Ink's Stripe account. Custom Ink owns the buyer relationship, the receipt, and the Radar fraud rules. A portion automatically transfers to the org. With direct charges, the charge would be on the org's account — they'd own the receipt, the dispute liability, and the fraud surface. That's wrong for this use case.

**Full answer:** There are three charge types in Connect:

1. **Destination charges** — charge hits Custom Ink platform, `transfer_data.destination` automatically moves net amount to org at settlement. Custom Ink's Radar rules apply. Custom Ink issues the receipt. Custom Ink handles disputes. **This is what we recommend.**
2. **Direct charges** — charge hits org's account. Org handles disputes. Org's Radar (or none). Custom Ink collects via application fee. Wrong here — Custom Ink needs to own fraud and buyer relationship.
3. **Separate charges + transfers** — charge hits platform, transfer is a separate manual call. More flexibility but more ops complexity. Best for the POD partner split (Online Stores) where the transfer happens at fulfillment, not at charge time.

For fundraising: destination charges. Org gets the net, Custom Ink takes an application fee (0% for nonprofits, configurable). For GOF: destination charges with delayed transfer (escrow until fulfillment). For Stores POD: separate charges + transfers.

---

### "Can Custom Ink hold funds before paying out?"

**Short answer:** Yes. This is native to Connect. `transfer_data.destination` doesn't move funds to the org immediately — the transfer happens when Custom Ink calls `transfers.create`. Until then, the money sits in Custom Ink's platform balance. Custom Ink controls the release trigger.

**Full answer:** For fundraising campaigns, the flow is:
1. Donor pays → charge hits Custom Ink's Stripe balance (destination charge, org is set as transfer destination)
2. Campaign closes → Custom Ink webhook fires `transfers.create({ amount: netAmount, destination: orgAcctId })`
3. Stripe disburses T+2 to org's bank

There's no automatic payout to the org until Custom Ink explicitly initiates the transfer. This is how escrow works for GOF too: buyer pays, funds sit, Custom Ink releases after fulfillment confirmation.

Platform Controls also let Custom Ink set `delay_days` on payouts or pause a connected account's payouts entirely for fraud review — without touching the charge itself.

---

### "What happens if an org fails KYC or gets restricted by Stripe?"

**Short answer:** Custom Ink gets a webhook (`account.updated` with `requirements.disabled_reason`). Payouts to that account are paused by Stripe automatically. Custom Ink can surface a message in the fundraising dashboard: "Action needed — re-verify your account." The org goes back through the hosted flow.

**Full answer:** Stripe monitors connected accounts continuously. If requirements come due (e.g., Stripe needs updated docs for a larger-volume account), `requirements.currently_due` populates and there's a deadline. If not resolved, `charges_enabled` or `payouts_enabled` flips to false. Custom Ink handles this with:
- Webhook listener on `account.updated`
- Check `requirements.currently_due` and `requirements.past_due`
- Generate a new `accountLinks.create({ type: 'account_onboarding' })` link and direct the org there
- No funds are lost — they sit in Custom Ink's balance until the account is re-enabled

This is the same flow that handles the Tipalti "abandoned registration" problem today. Instead of a finance person manually chasing the org, the webhook triggers an automated re-verification email with a fresh Stripe-hosted link.

---

## Part 2 — Payout Mechanics & Timing

### "How do the payouts actually work — what's T+2?"

**Short answer:** T+2 is the standard Stripe Connect payout schedule — funds from charges settled today hit the connected org's bank account two business days later. It's configurable — Custom Ink can set T+7 for higher-risk accounts. The weekly manual cycle (Mon/Tue/Wed) goes away entirely; timing is determined by when Custom Ink fires the transfer.

**Full answer:** Stripe's payout timeline for connected accounts:
- Charge is created → `pending` in Stripe
- Card network settles (typically next business day) → `available`
- Custom Ink calls `transfers.create` → funds move from Custom Ink's balance to connected account balance
- Stripe initiates payout to org's bank on their payout schedule (default T+2 rolling)

Custom Ink controls two things:
1. **When to transfer** — they can hold in platform balance until campaign close, fulfillment, or any other business event
2. **Payout schedule per account** — `stripe.accounts.update(orgId, { settings: { payouts: { schedule: { interval: 'weekly', weekly_anchor: 'monday' } } } })`

For Online Stores this matters: some stores want weekly payouts, some monthly. This is a per-account API call, not a platform-level setting. Each store's preference can be stored in Custom Ink's DB and synced to Stripe.

---

### "What about the $60K PayPal batch limit — how does Stripe handle large payouts?"

**Short answer:** There is no batch limit in Stripe. A single `transfers.create` call can be for any amount. And unlike PayPal mass-pay CSV, each transfer is tied to a specific connected account with audit history — no manual reconciliation.

**Full answer:** The PayPal $60K/batch limit is a PayPal-specific constraint that requires Custom Ink to split large campaign disbursements into multiple CSV uploads. This is operational overhead with no business reason behind it. In Stripe:
- `transfers.create({ amount: 500000, currency: 'usd', destination: 'acct_...' })` — no upper limit per call (subject to Custom Ink's own Stripe platform balance)
- Each transfer generates a transfer object with a unique ID, tied to the org's connected account, visible in both Custom Ink's Sigma and the org's Express dashboard
- `transfer.metadata` can include campaign ID, campaign name, close date — making reconciliation trivial vs. PayPal's flat CSV with no contextual fields

---

### "What about returned / failed payouts? How do they handle re-issuance?"

**Short answer:** Stripe fires a `payout.failed` webhook. Custom Ink catches it, surfaces the failure in the payout dashboard, and can retry with a corrected bank account. The org updates their bank info in the Express portal — no support ticket required.

**Full answer:** Today's process for a returned check or failed PayPal payout: someone opens a manual ticket, finance investigates, reissues. With Stripe:
1. `payout.failed` webhook → Custom Ink flags the connected account
2. If bank account is wrong: generate new `accountLinks.create({ type: 'account_onboarding' })` → org re-enters bank info in Stripe hosted flow
3. Stripe validates the new account via Financial Connections or micro-deposits
4. Custom Ink retries `transfers.create` — or sets up automatic retry via webhook handler

Failed payouts are also tracked in Sigma: `SELECT * FROM payouts WHERE status = 'failed'` — full history, no spreadsheet.

There's also `payout.reconciliation_completed` for when everything settles, and `balance.available` for when funds are ready to pay out — all observable programmatically.

---

## Part 3 — Compliance & Tax

### "How does Stripe handle 1099-K? What does Custom Ink need to do?"

**Short answer:** Almost nothing. Stripe generates 1099-K forms automatically for connected accounts that meet the IRS threshold ($600 in 2024+). Custom Ink doesn't collect paper W-9s, doesn't validate EINs manually, doesn't mail tax forms. The org's tax info is captured during Connect onboarding and Stripe handles the rest.

**Full answer:** Stripe's tax responsibilities with Connect Express:
- During onboarding, Stripe collects TIN/EIN as part of KYC — this is the W-9 equivalent
- Stripe validates the TIN against IRS records (TIN matching API)
- At year end, Stripe generates 1099-K for each connected account that exceeds the threshold
- Forms are filed with the IRS and delivered to the org via the Express dashboard
- Custom Ink can query: `stripe.tax.forms.list({ type: '1099-K', connected_account: orgId })`

What this replaces at Custom Ink:
- The emailed W-9 PDF → print → sign → scan → email back flow
- Manual EIN verification in Tipalti
- Finance team's annual 1099 preparation process
- The compliance blockers preventing Fulfill Engine stores from distributing profits (W-9 collection is exactly what's blocked)

**Important caveat:** Stripe handles 1099-K for payment processing income. If Custom Ink has other tax reporting obligations (e.g., revenue share classified differently), those still need legal review. Stripe does not give tax advice. But for the payment flow as described, they're covered.

---

### "What about escheatment laws — abandoned property?"

**Short answer:** Stripe doesn't automatically handle state escheatment reporting — that's Custom Ink's obligation. But Stripe makes it tractable: every unclaimed balance is queryable via the API, with timestamps. Custom Ink can build a lightweight dormancy tracker against this data. Today they have no systematic way to even know which accounts have unclaimed balances.

**Full answer:** Escheatment laws require companies to report and remit unclaimed property (including undelivered payouts) to the state after a dormancy period (typically 3-5 years, varies by state). Currently Custom Ink can't easily track this across Tipalti, PayPal, and manual checks.

With Connect:
- `stripe.accounts.list({ limit: 100 })` → filter for accounts where `payouts_enabled: true` but no recent payout activity
- `stripe.balance.retrieve({ stripeAccount: orgId })` → check for sitting balances
- `payout.created` webhook timestamps give dormancy start dates

Custom Ink would need to build a dormancy monitoring job (cron that queries balances > N days old, flags for compliance review). This is ~1-2 days of engineering work. The underlying data is clean and queryable — vs. today where the data is split across 3 platforms with no unified view.

---

### "What about OFAC / sanctions screening?"

**Short answer:** Stripe screens all connected accounts against OFAC and other sanctions lists as part of KYC. If a match is found, the account is flagged and Stripe restricts it before any funds move. Custom Ink doesn't need to run its own OFAC checks on orgs.

**Full answer:** Stripe's compliance coverage for Express accounts:
- OFAC SDN list screening
- PEP (Politically Exposed Person) screening
- Adverse media screening
- Ongoing monitoring (not just at onboarding — Stripe rescreens periodically)

This is particularly relevant for high-value fundraising accounts where a large nonprofit might later be involved in sanctions action. With Tipalti, Custom Ink is relying on Tipalti's screening. With PayPal mass-pay CSV uploads, there is effectively no screening at the time of payout. With Stripe Connect, screening happens at account creation and is maintained continuously.

---

## Part 4 — Fraud & Risk

### "How does Radar work across all three flows — can they really share rules?"

**Short answer:** Yes. All three flows run on the same Stripe platform account. Radar rules configured at the platform level apply to every charge that flows through Custom Ink's Stripe account — GOF, fundraising, and stores, simultaneously. A rule written once covers all three.

**Full answer:** Radar rule logic is evaluated at charge creation time. Because all three flows use Custom Ink's platform account as the charge origin (destination charges, not direct charges), every charge goes through the same Radar instance. Examples:

```
# Block if card has been used on 5+ different accounts in 24h
block if: :card_id_count_distinct_user_id_last_24_hours > 5

# Flag high-velocity same-card donations to same org
review if: :card_id_count_distinct_fundraiser_id_last_10_minutes > 3

# Block known fraud countries on GOF orders
block if: :ip_country = 'XX' and :amount > 100000
```

Metadata on each charge (campaign ID, org ID, order type = GOF/fundraising/stores) lets Radar rules be scoped:
```
block if: :metadata['flow'] = 'fundraising' and :card_testing_score > 75
```

The Scott cross-flow fraud strategy (block a fraudster on one flow = block across all) is possible because:
- A fraudster's card blocked by Radar on a GOF order → same card blocked on fundraising donation → same card blocked on store purchase
- No rule duplication, no manual coordination between teams

---

### "What's the risk to Custom Ink if an org commits fraud — who eats the loss?"

**Short answer:** With destination charges, Custom Ink is the merchant of record. If an org fraudulently triggers a payout and then disputes the underlying charges, Custom Ink holds the dispute liability — same as they do today. Stripe doesn't absorb fraud losses. But Platform Controls let Custom Ink hold payouts for review before they go out.

**Full answer:** This is the right question and worth being direct about. Liability in Connect:

- **Chargebacks/disputes:** The platform (Custom Ink) is liable on destination charges. If a donor charges back a fraudulent fundraiser, Custom Ink eats the loss unless they've already clawed back the transfer to the org.
- **Mitigation:** Custom Ink can hold transfers for N days (configurable per account) before disbursing. This creates a window to catch chargebacks before money leaves the platform. For high-risk accounts: `delay_days: 14` on payout schedule.
- **Radar:** Catches card fraud at charge time — before the money ever enters the platform
- **Platform Controls:** `stripe.accounts.update(orgId, { settings: { payouts: { debit_negative_balances: true } } })` — if an org has a negative balance (from chargebacks after payout), Stripe can automatically debit their connected bank account to cover it

Compare to today: with PayPal mass-pay, once a CSV is uploaded and payments go out, there is essentially no claw-back mechanism. With Stripe, there's a recoverable window.

---

## Part 5 — Migration & Integration

### "How long does this actually take to build?"

**Short answer:** Phase 1 (fundraising on Connect) is realistically 6-8 weeks for an experienced team — Stripe's hosted onboarding and payout APIs do the heavy lifting. The longest part is migrating existing Tipalti payees to Stripe Express, not the integration itself.

**Full answer:** Work breakdown for Phase 1 (Fundraising):

| Work | Estimated time |
|---|---|
| `accounts.create` + `accountLinks.create` onboarding flow | 3–5 days |
| Webhook handler for `account.updated` (KYC status changes) | 2 days |
| Payment intent with `application_fee_amount` + `transfer_data` | 2 days |
| Campaign-close payout trigger + retry logic | 3 days |
| Internal payout dashboard (can use existing Sigma + API) | 5 days |
| Migrate existing orgs from Tipalti → Stripe (email re-verification flow) | 5–10 days (ops) |
| Testing + staging | 5 days |
| **Total** | **~6-8 weeks** |

What Custom Ink doesn't need to build (because Stripe handles it):
- KYC/identity verification UI
- W-9 collection and validation
- Bank account verification
- 1099-K generation
- Payout ledger for orgs
- Express dashboard

Phase 2 (Online Stores) adds payout schedule configuration per store and the Tipalti/PayPal store payout migration — similar scope. Phase 3 (GOF) is the most complex due to existing tech debt in the system.

---

### "Can they run Stripe and Tipalti in parallel during migration?"

**Short answer:** Yes. New campaigns onboard to Stripe Express. Existing Tipalti payees can continue on the old flow until they recertify on Stripe. Custom Ink can migrate cohort by cohort — all new orgs go to Stripe, existing orgs get a migration window. No big bang cutover required.

**Full answer:** Migration strategy:
1. New orgs created after cutover → Stripe Express only
2. Existing Tipalti orgs → keep paying via Tipalti until they go through a new campaign
3. At each new campaign start, send "upgrade your payout account" email → Stripe-hosted onboarding link
4. Once org completes Stripe onboarding, future payouts route to Stripe; Tipalti record marked inactive
5. After 12 months, force-migrate any remaining Tipalti orgs or deactivate

Key question to raise: does Custom Ink's Tipalti contract have minimum commitments or early termination fees? If so, there may be a cost to running parallel systems. Stripe doesn't charge per connected account — only on processed volume.

---

### "Our payment team is stretched thin — how much ongoing maintenance does Connect require?"

**Short answer:** Less than what they're operating today. The Monday/Tuesday/Wednesday manual cycle alone is several engineer-hours per week. Connect's operational surface is webhook monitoring and occasional account review — not weekly manual uploads.

**Full answer:** Ongoing operational responsibilities with Connect vs. today:

| Task | Today | With Connect |
|---|---|---|
| Weekly payout run | Manual, 3 steps, 3 days | Webhook-triggered, automated |
| PayPal batch uploads | Manual CSV every Tuesday | Eliminated |
| Failed payout re-issuance | Manual ticket → finance → reissue | Webhook → org re-verifies → retry |
| W-9 collection | Manual per org | Eliminated (Stripe onboarding) |
| 1099 prep | Manual annual process | Automated by Stripe |
| Fraud review on transfers | Manual, case by case | Radar rules + Platform Controls |
| Reconciliation | 3 separate files, manual merge | One Sigma query |

What still needs ongoing attention:
- Monitoring `account.updated` webhooks for KYC issues
- Reviewing Platform Controls queue (paused orgs, flagged payouts)
- Sigma reporting and anomaly detection
- Stripe API version upgrades (Stripe's upgrade cadence is predictable, well-documented)

---

## Part 6 — Commercial & Pricing

### "What does this actually cost Custom Ink?"

**Short answer:** Stripe takes 2.9% + 30¢ per transaction for standard card payments. On top of that, Connect has a per-transaction fee for connected accounts (typically 0.25% + 25¢ per payout, or a flat fee per active account — depends on negotiated terms). At Custom Ink's volume, this is a commercial conversation, not a list-price question.

**Full answer:** Stripe pricing has three layers for Custom Ink:
1. **Platform processing fees:** 2.9% + 30¢ per charge (standard) — Custom Ink already pays this on Braintree/Payflow. Rate negotiable at volume.
2. **Connect fees:** ~0.25% + 25¢ per payout to connected accounts (list price) — negotiable. Some structures include a per-active-account monthly fee instead.
3. **Express account fees:** No charge per connected account created; fees apply on payouts.

What offsets cost:
- Tipalti contract eliminated (or reduced to legacy orgs during wind-down)
- PayPal mass-pay fees eliminated
- Engineering time saved on manual weekly cycle (hard to quantify, real)
- Compliance cost savings (W-9, 1099, escheatment infrastructure)

For nonprofits where Custom Ink charges 0% application fee: Custom Ink absorbs the Stripe processing fee on donations. This is a design choice — they can also pass it through to donors as a "platform fee" (common practice).

**Important:** Don't quote specific rates in the room. Stripe pricing for platforms at Custom Ink's volume is negotiated. The right answer is "this is a commercial conversation we'd have with your team and our sales team together."

---

### "What's the switching cost if they want to leave Stripe later?"

**Short answer:** Connected account data (KYC, bank accounts) lives in Stripe and can't be bulk-exported to another processor. That's real lock-in. But the business logic (campaign triggers, payout rules, org management) lives in Custom Ink's systems — that's portable. The lock-in is similar to any payment processor relationship.

**Full answer:** Honest answer on portability:
- **Not portable from Stripe:** Verified KYC data, connected account IDs, bank account tokens, payout history in Stripe's system
- **Portable:** Custom Ink's business logic (when to payout, how to split, which orgs are verified), org data in Custom Ink's own DB, Sigma data exportable to a data warehouse
- **Migration path if needed:** Orgs would need to re-verify on the new platform. This is the same friction they have today when migrating from PayPal → Tipalti (current problem). Any payout platform requires org KYC.

The real question is: are there better alternatives? Tipalti is already proving painful. PayPal is already at its limits. A custom-built payout system would cost far more to build and maintain. Connect lock-in is real but it's the least bad option.

---

## Part 7 — Specific Stakeholder Questions

### For Scott (fraud / cross-platform strategy):

**Expected push:** "How do we actually enforce a fraud block across all three flows — what's the data model?"

**Answer:** Radar rules run at the `PaymentIntent` level. All three flows create PaymentIntents on Custom Ink's platform account. The shared signal is the card fingerprint (`card.fingerprint`) — this is consistent across all three flows for the same card. A block rule on card fingerprint applies universally.

For cross-account fraud (different cards, same device): Stripe's `ip_address` and device fingerprint metadata is also consistent across flows. Build a Radar rule: `block if: :ip_risk_score > 85` — this fires on any of the three flows.

For org-level fraud (fraudulent org draining donations): Platform Controls + delayed payout window. Radar's `review if: :charge_amount > 500000 and :metadata['flow'] = 'fundraising'` puts high-value fundraising charges in manual review before settlement.

---

### For Nicole (refunds team):

**Expected push:** "What happens to a donor refund when the org has already been paid out?"

**Answer:** This is the most operationally important question for Nicole's team.

If the org hasn't been paid yet (transfer not yet made): straightforward. `refunds.create({ payment_intent: pi_id })` — Custom Ink refunds donor, transfer never happens.

If the org has already been paid: `refunds.create({ payment_intent: pi_id, refund_application_fee: true, reverse_transfer: true })` — Stripe reverses the transfer from the org's connected account back to the platform, then refunds the donor. The org's balance goes negative if they've already withdrawn.

If the org has already withdrawn to their bank: Custom Ink needs to either absorb the loss (dispute process) or collect from the org directly. Stripe can set `debit_negative_balances: true` on the connected account — Stripe will auto-debit the org's bank account to cover the negative balance. This is the correct setting for fundraising accounts.

Today: returned donor → manual check mailed → weeks of delay. With Connect: API call, same day.

---

### For engineering ("Is this a 12-month project or a 6-month project?"):

**Answer:** Phase 1 (fundraising) should be shippable in 6-8 weeks with 2 engineers. The Stripe Connect API is well-documented, with official Node.js/Ruby/Python SDKs, a test mode that mirrors production behavior exactly, and a Stripe-hosted test account flow that simulates the full KYC path without real identity docs.

The risk isn't the Stripe integration — it's migrating existing Tipalti payees and getting the webhook infrastructure reliable. Those are the planning items worth investing in upfront.

Stripe provides a dedicated Solutions Engineer for integrations at this scale. There is also a migration playbook specifically for Tipalti → Connect transitions.

---

## Quick Reference — Objection Card

| Objection | Response |
|---|---|
| "We already have Tipalti, why rip it out?" | Tipalti handles payables, not payments. It doesn't touch the donor charge, fraud layer, or reconciliation. You'd still need Braintree/PayPal plus Tipalti. Connect replaces all of it with one API. |
| "Orgs are used to PayPal" | Org experience with Connect is actually better — instant bank verification via Financial Connections vs. PayPal micro-deposits. And orgs don't interact with "Stripe" directly — they see Custom Ink's UI. |
| "What if Stripe goes down?" | Stripe's SLA is 99.99% uptime. More importantly: your current system has a PayPal CSV upload that runs once a week. If PayPal is down Tuesday, you wait until next Tuesday. Connect has real-time retry logic. |
| "We have net-terms for GOF — does Stripe support that?" | Yes. Stripe Invoicing supports net-30/60 terms with ACH debit collection. The invoice is created in Stripe, sent to the buyer, and auto-collected on the due date. No manual follow-up. |
| "We're not ready to do a full migration" | You don't have to. Start with new fundraising campaigns only. Existing Tipalti orgs stay on Tipalti until their next campaign. No big bang. |
| "What about international orgs?" | Stripe Connect supports 35+ countries. If Custom Ink's fundraising is US-only today, this isn't a blocker for Phase 1. International expansion becomes a configuration change, not a new vendor. |
| "Can we keep our fraud team's manual review step?" | Yes. Platform Controls + Radar's `review` action puts charges or payouts in a queue. Custom Ink's fraud team reviews flagged items before funds move. Connect doesn't remove human oversight — it makes it selective instead of universal. |
| "We want to own our payout data, not lock it in Stripe" | All payout and transfer data is queryable via Stripe Sigma (SQL) and exportable to any data warehouse via Stripe's data pipeline. You own the business logic — Stripe stores the transaction records like any payment processor. |

---

*Last updated: June 2026 · Prepared by Solutions Engineering · Questions: brian@stripe.com*
