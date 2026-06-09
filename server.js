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
    const { org_name, email, org_type = 'non_profit' } = req.body;
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email: email || `demo-${Date.now()}@customink-demo.com`,
      capabilities: {
        transfers: { requested: true },
        card_payments: { requested: true },
      },
      business_type: org_type,
      metadata: { org_name: org_name || 'Demo Org', demo: 'customink_connect' },
    });
    res.json({ account });
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
