// CustomInk × Stripe Demo Server
// Run: npm install && node server.js
// Then open: http://localhost:3000

require('dotenv').config();
const express = require('express');
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('Missing STRIPE_SECRET_KEY — copy .env.example to .env and add your key');
  process.exit(1);
}
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ── Core payment intent ──────────────────────────────────────────
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount = 34200, items = [] } = req.body;
    const pi = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      description: 'CustomInk Order — Demo',
      metadata: { demo: 'customink_stripe', items: JSON.stringify(items) },
    });
    res.json({ clientSecret: pi.client_secret });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connect: Create Express connected account ────────────────────
app.post('/api/connect/create-account', async (req, res) => {
  try {
    // V2 Connect controller model — all CI connected accounts are "recipient" type:
    // they receive transfers, never process payments on behalf of buyers.
    // The two meaningful dimensions are WHO collects KYC and WHAT dashboard the org gets.
    const {
      org_name,
      email,
      org_type = 'non_profit',
      collector = 'stripe',   // 'stripe' | 'application' (requirement_collection)
      dashboard = 'express',  // 'express' | 'none' (stripe_dashboard.type)
      country = 'US',
    } = req.body;

    const isAppCollected = collector === 'application';
    const isExpressDash  = dashboard === 'express';

    // Express dashboard requires application to control losses (Stripe rule).
    // Application-collected accounts always control losses regardless of dashboard.
    const lossesPayer = (isExpressDash || isAppCollected) ? 'application' : 'stripe';

    const accountParams = {
      country,
      email: email || `demo-${Date.now()}@customink-demo.com`,
      controller: {
        requirement_collection: collector,
        stripe_dashboard: { type: dashboard },
        fees: { payer: 'application' },                            // CI always pays Stripe fees
        losses: { payments: lossesPayer },
      },
      capabilities: { transfers: { requested: true } },           // recipient — transfers only
      business_type: org_type,
      metadata: {
        org_name: org_name || 'Demo Org',
        collector,
        dashboard,
        demo: 'customink_connect',
      },
    };

    // Recipient service agreement is cross-border only — not supported for US→US.
    if (isAppCollected && country !== 'US') {
      accountParams.tos_acceptance = { service_agreement: 'recipient' };
    }

    const account = await stripe.accounts.create(accountParams);
    res.json({ account });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connect: Skip onboarding (test mode only) ────────────────────
// Programmatically fulfills all KYC requirements with Stripe test data so
// demos don't need to navigate the hosted onboarding UI.
app.post('/api/connect/skip-onboarding', async (req, res) => {
  try {
    const { account_id } = req.body;

    // Fetch account to know business_type
    const account = await stripe.accounts.retrieve(account_id);
    const biz = account.business_type || 'non_profit';
    const isCompany = biz !== 'individual';

    const isAppCollected = account.controller?.requirement_collection === 'application';

    const updateParams = {
      business_profile: {
        mcc: '5699',                          // apparel / custom merchandise
        url: 'https://demo.customink.com',
        product_description: 'Custom apparel and merchandise',
      },
    };

    // ToS can only be accepted programmatically for application-collected accounts.
    // Stripe-collected (Express) accounts must accept ToS through the hosted onboarding UI.
    if (isAppCollected) {
      updateParams.tos_acceptance = {
        date: Math.floor(Date.now() / 1000),
        ip: '127.0.0.1',
      };
    }

    if (isCompany) {
      updateParams.company = {
        name: 'Demo Org (Test)',
        tax_id: '000000000',                  // Stripe test EIN — auto-verifies
        address: { line1: '123 Main St', city: 'San Francisco', state: 'CA', postal_code: '94102', country: 'US' },
        phone: '0000000000',
      };
    } else {
      updateParams.individual = {
        first_name: 'Jenny',
        last_name:  'Rosen',
        dob:    { day: 1, month: 1, year: 1901 }, // Stripe magic DOB — auto-verifies
        ssn_last_4: '0000',                        // auto-verifies in test mode
        email: 'jenny@example.com',
        phone: '0000000000',
        address: { line1: '123 Main St', city: 'San Francisco', state: 'CA', postal_code: '94102', country: 'US' },
      };
    }

    await stripe.accounts.update(account_id, updateParams);

    // If company, add a representative person
    if (isCompany) {
      const persons = await stripe.accounts.listPersons(account_id, { limit: 5 });
      const hasRep = persons.data.some(p => p.relationship?.representative);
      if (!hasRep) {
        await stripe.accounts.createPerson(account_id, {
          first_name: 'Jenny',
          last_name:  'Rosen',
          dob:    { day: 1, month: 1, year: 1901 },
          ssn_last_4: '0000',
          email: 'jenny@example.com',
          phone: '0000000000',
          address: { line1: '123 Main St', city: 'San Francisco', state: 'CA', postal_code: '94102', country: 'US' },
          relationship: { representative: true, title: 'Director', percent_ownership: 25 },
        });
      }
    }

    // Add test bank account (US routing: 110000000, Stripe test account)
    const extAccounts = await stripe.accounts.listExternalAccounts(account_id, { object: 'bank_account', limit: 1 });
    if (extAccounts.data.length === 0) {
      await stripe.accounts.createExternalAccount(account_id, {
        external_account: {
          object: 'bank_account', country: 'US', currency: 'usd',
          routing_number: '110000000',
          account_number: '000123456789',
        },
      });
    }

    // Re-fetch to return updated requirements state
    const updated = await stripe.accounts.retrieve(account_id);
    res.json({ account: updated });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connect: Create account onboarding link ──────────────────────
app.post('/api/connect/account-link', async (req, res) => {
  try {
    const { account_id } = req.body;
    const origin = req.headers.origin || `http://localhost:${PORT}`;
    const link = await stripe.accountLinks.create({
      account: account_id,
      refresh_url: `${origin}/payouts`,
      return_url: `${origin}/payouts?onboarded=${account_id}`,
      type: 'account_onboarding',
    });
    res.json({ url: link.url });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connect: Destination charge (buyer pays, split to org) ────────
app.post('/api/connect/charge', async (req, res) => {
  try {
    const {
      amount = 5000,
      application_fee_amount = 0,
      destination,
      description = 'CustomInk Fundraiser — Demo',
    } = req.body;
    const pi = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      application_fee_amount,
      transfer_data: { destination },
      description,
      metadata: { demo: 'customink_connect' },
    });
    res.json({ clientSecret: pi.client_secret, pi_id: pi.id });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connect: Manual transfer to connected account ────────────────
app.post('/api/connect/transfer', async (req, res) => {
  try {
    const { amount, destination, description = 'Campaign close payout — Demo' } = req.body;
    const transfer = await stripe.transfers.create({
      amount,
      currency: 'usd',
      destination,
      description,
      metadata: { demo: 'customink_connect' },
    });
    res.json({ transfer });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connect: Platform balance ─────────────────────────────────────
app.get('/api/connect/balance', async (req, res) => {
  try {
    const balance = await stripe.balance.retrieve();
    res.json({ balance });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connect: List connected accounts ─────────────────────────────
app.get('/api/connect/accounts', async (req, res) => {
  try {
    const accounts = await stripe.accounts.list({ limit: 20 });
    res.json({ accounts: accounts.data });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connect: Get single account ───────────────────────────────────
app.get('/api/connect/account/:id', async (req, res) => {
  try {
    const account = await stripe.accounts.retrieve(req.params.id);
    res.json({ account });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connect: List transfers ───────────────────────────────────────
app.get('/api/connect/transfers', async (req, res) => {
  try {
    const transfers = await stripe.transfers.list({ limit: 20 });
    res.json({ transfers: transfers.data });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connect: List payouts for connected account ───────────────────
app.get('/api/connect/payouts/:account_id', async (req, res) => {
  try {
    const payouts = await stripe.payouts.list(
      { limit: 10 },
      { stripeAccount: req.params.account_id }
    );
    res.json({ payouts: payouts.data });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connect: Platform-level payout (platform → bank) ─────────────
app.post('/api/connect/payout', async (req, res) => {
  try {
    const { amount, method = 'standard' } = req.body;
    const payout = await stripe.payouts.create({ amount, currency: 'usd', method });
    res.json({ payout });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connect: Account session for embedded components ─────────────
// CI accounts are transfers-only recipients — they don't have card_payments,
// so the 'payments' embedded component is not available. Use payouts + account_management.
app.post('/api/connect/account-session', async (req, res) => {
  try {
    const { account_id } = req.body;
    const accountSession = await stripe.accountSessions.create({
      account: account_id,
      components: {
        payouts: { enabled: true, features: { instant_payouts: false, standard_payouts: true, edit_payout_schedule: false } },
        account_management: { enabled: true, features: { external_account_collection: true } },
      },
    });
    res.json({ client_secret: accountSession.client_secret });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connect: Delete connected account ────────────────────────────
app.delete('/api/connect/account/:id', async (req, res) => {
  try {
    const deleted = await stripe.accounts.del(req.params.id);
    res.json({ deleted });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Connect: Seed mock transfer data to a connected account ───────
app.post('/api/connect/seed-mock-data', async (req, res) => {
  try {
    const { account_id } = req.body;

    // Auto-complete onboarding if transfers capability isn't active yet
    const acct = await stripe.accounts.retrieve(account_id);
    if (acct.capabilities?.transfers !== 'active') {
      const biz = acct.business_type || 'non_profit';
      const isCompany = biz !== 'individual';
      const isAppCollected = acct.controller?.requirement_collection === 'application';

      const updateParams = {
        business_profile: {
          mcc: '5699',
          url: 'https://demo.customink.com',
          product_description: 'Custom apparel and merchandise',
        },
      };
      if (isAppCollected) {
        updateParams.tos_acceptance = { date: Math.floor(Date.now() / 1000), ip: '127.0.0.1' };
      }
      if (isCompany) {
        updateParams.company = {
          name: 'Demo Org (Test)', tax_id: '000000000',
          address: { line1: '123 Main St', city: 'San Francisco', state: 'CA', postal_code: '94102', country: 'US' },
          phone: '0000000000',
        };
      } else {
        updateParams.individual = {
          first_name: 'Jenny', last_name: 'Rosen',
          dob: { day: 1, month: 1, year: 1901 }, ssn_last_4: '0000',
          email: 'jenny@example.com', phone: '0000000000',
          address: { line1: '123 Main St', city: 'San Francisco', state: 'CA', postal_code: '94102', country: 'US' },
        };
      }
      await stripe.accounts.update(account_id, updateParams);

      if (isCompany) {
        const persons = await stripe.accounts.listPersons(account_id, { limit: 5 });
        const hasRep = persons.data.some(p => p.relationship?.representative);
        if (!hasRep) {
          await stripe.accounts.createPerson(account_id, {
            first_name: 'Jenny', last_name: 'Rosen',
            dob: { day: 1, month: 1, year: 1901 }, ssn_last_4: '0000',
            email: 'jenny@example.com', phone: '0000000000',
            address: { line1: '123 Main St', city: 'San Francisco', state: 'CA', postal_code: '94102', country: 'US' },
            relationship: { representative: true, title: 'Director', percent_ownership: 25 },
          });
        }
      }
      const extAccounts = await stripe.accounts.listExternalAccounts(account_id, { object: 'bank_account', limit: 1 });
      if (extAccounts.data.length === 0) {
        await stripe.accounts.createExternalAccount(account_id, {
          external_account: {
            object: 'bank_account', country: 'US', currency: 'usd',
            routing_number: '110000000', account_number: '000123456789',
          },
        });
      }
    }

    const mockTransfers = [
      { amount: 24750, description: 'Campaign payout — Fall Spirit Tees (127 orders)', metadata: { campaign: 'fall-spirit-2024', orders: '127' } },
      { amount: 18320, description: 'Campaign payout — Winter Fundraiser (94 orders)', metadata: { campaign: 'winter-fundraiser-2024', orders: '94' } },
      { amount: 9650, description: 'Revenue share — Q3 2024', metadata: { type: 'revenue_share', period: 'Q3-2024' } },
    ];
    const results = [];
    for (const t of mockTransfers) {
      try {
        const transfer = await stripe.transfers.create({ amount: t.amount, currency: 'usd', destination: account_id, description: t.description, metadata: t.metadata });
        results.push({ id: transfer.id, amount: transfer.amount });
      } catch (e) {
        results.push({ error: e.message, description: t.description });
      }
    }
    res.json({ transfers: results });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Config: Return publishable key ────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_51TdyxbQ9wb5pYzAEqN0CkU0hUkd8FX24KBPoAMeJCARPLy0kJLjwgvH3903dk5VnFzcLFiyYzC3kDCTyDP13HGno00CEBtozwn' });
});

// ── Page routes ───────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'customink-stripe-demo.html'));
});
app.get('/refunds', (req, res) => {
  res.sendFile(path.join(__dirname, 'customink-refunds.html'));
});
app.get('/connect', (req, res) => {
  res.sendFile(path.join(__dirname, 'customink-connect.html'));
});
app.get('/architecture', (req, res) => {
  res.sendFile(path.join(__dirname, 'architecture-diagram.html'));
});
app.get('/payouts', (req, res) => {
  res.sendFile(path.join(__dirname, 'customink-payouts.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n🎨 CustomInk × Stripe Demo Server');
  console.log(`→  http://localhost:${PORT}\n`);
});

module.exports = app;
