/**
 * TEST STUB, not a payment provider. A local stand-in for the parts of the Razorpay and Stripe APIs SampCrew uses,
 * so payments can be driven end to end without real keys, money or network access:
 *
 *   Razorpay: GET/POST /v1/payment_links (Basic auth with the key id and secret)
 *   Stripe:   GET /v1/balance, POST /v1/customers, POST /v1/checkout/sessions, GET/POST /v1/payment_intents (Bearer)
 *
 * Each checkout gets a hosted page at /pay/<provider>/<id> with Pay and Cancel buttons. Pay sends the signed
 * webhook the real provider would send (payment_link.paid, or checkout.session.completed) to the SampCrew API and
 * then returns the browser to SampCrew, as the real hosted pages do.
 *
 * Valid test keys: Razorpay key id rzp_test_* with secret "rzp_test_secret"; Stripe secret key "sk_test_stub".
 * Anything else is refused with 401, so the Console's "Test connection" can be checked both ways.
 *
 *   PAYMENTS_STUB_PORT=4060 API_URL=http://localhost:4000 RAZORPAY_WEBHOOK_SECRET=... STRIPE_WEBHOOK_SECRET=... node e2e/payments-stub.cjs
 *
 * Tests in the same process use createPaymentsStub(): webhooks are then returned by POST /__pay/<provider>/<id>
 * instead of being sent, so the test can deliver them itself.
 */
const http = require('node:http');
const { createHmac, randomBytes } = require('node:crypto');

const RAZORPAY_SECRET = 'rzp_test_secret';
const STRIPE_KEY = 'sk_test_stub';
const id = (p) => `${p}_${randomBytes(7).toString('hex')}`;

function createPaymentsStub(opts = {}) {
  const state = { links: new Map(), sessions: new Map(), intents: new Map(), customers: new Map(), charges: [], requests: [], declineCharges: false };
  const config = {
    apiUrl: opts.apiUrl ?? process.env.API_URL ?? 'http://localhost:4000',
    razorpaySecret: opts.razorpayWebhookSecret ?? process.env.RAZORPAY_WEBHOOK_SECRET ?? 'whsec_razorpay_stub',
    stripeSecret: opts.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET ?? 'whsec_stripe_stub',
    send: opts.sendWebhooks ?? true,
  };
  let base = '';

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const authRazorpay = (req) => {
    const h = req.headers.authorization ?? '';
    const [kid, secret] = Buffer.from(h.replace(/^Basic /, ''), 'base64').toString('utf8').split(':');
    return /^rzp_test_/.test(kid ?? '') && secret === RAZORPAY_SECRET;
  };
  const authStripe = (req) => req.headers.authorization === `Bearer ${STRIPE_KEY}`;
  const parseForm = (raw) => {
    const out = {};
    for (const part of raw.split('&').filter(Boolean)) {
      const [k, v = ''] = part.split('=');
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    }
    return out;
  };

  /** The webhook the provider would send when a checkout is paid, signed with the webhook secret. */
  function paidWebhook(provider, obj) {
    if (provider === 'razorpay') {
      const payment = { id: id('pay'), entity: 'payment', amount: obj.amount, currency: obj.currency, status: 'captured', method: 'upi' };
      obj.status = 'paid';
      obj.amount_paid = obj.amount;
      const body = JSON.stringify({ entity: 'event', account_id: 'acc_stub', event: 'payment_link.paid', contains: ['payment_link', 'order', 'payment'], payload: { payment_link: { entity: obj }, payment: { entity: payment } }, created_at: Math.floor(Date.now() / 1000) });
      return { url: `${config.apiUrl}/api/v1/billing/webhooks/razorpay`, body, headers: { 'content-type': 'application/json', 'x-razorpay-event-id': id('evt'), 'x-razorpay-signature': createHmac('sha256', config.razorpaySecret).update(body).digest('hex') } };
    }
    const pi = { id: id('pi'), object: 'payment_intent', amount: obj.amount_total, currency: obj.currency, customer: obj.customer, payment_method: id('pm'), status: 'succeeded' };
    state.intents.set(pi.id, pi);
    Object.assign(obj, { status: 'complete', payment_status: 'paid', payment_intent: pi.id });
    const body = JSON.stringify({ id: id('evt'), object: 'event', type: 'checkout.session.completed', livemode: false, created: Math.floor(Date.now() / 1000), data: { object: obj } });
    const t = Math.floor(Date.now() / 1000);
    return { url: `${config.apiUrl}/api/v1/billing/webhooks/stripe`, body, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${createHmac('sha256', config.stripeSecret).update(`${t}.${body}`).digest('hex')}` } };
  }

  function page(provider, obj) {
    const amount = provider === 'razorpay' ? obj.amount : obj.amount_total;
    const currency = String(obj.currency).toUpperCase();
    const name = provider === 'razorpay' ? 'Razorpay test checkout' : 'Stripe test checkout';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title></head><body style="font-family:sans-serif;max-width:480px;margin:40px auto">
<h1>${name}</h1><p>This is a local stand-in. No money moves.</p>
<p data-testid="stub-amount">${currency} ${(amount / 100).toFixed(2)}</p><p>${provider === 'razorpay' ? obj.description : obj.line_items_name}</p>
<form method="post" action="/pay/${provider}/${obj.id}/confirm"><button type="submit" data-testid="stub-pay">Pay ${currency} ${(amount / 100).toFixed(2)}</button></form>
<form method="post" action="/pay/${provider}/${obj.id}/cancel"><button type="submit" data-testid="stub-cancel">Cancel</button></form></body></html>`;
  }

  async function deliver(hook) {
    const res = await fetch(hook.url, { method: 'POST', headers: hook.headers, body: hook.body });
    state.requests.push({ webhook: hook.url, status: res.status });
    return res.status;
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://stub');
      const path = url.pathname;
      state.requests.push({ method: req.method, path });
      try {
        // ----- test controls
        if (path === '/__state') return json(res, 200, { links: [...state.links.values()], sessions: [...state.sessions.values()], charges: state.charges, requests: state.requests });
        if (path === '/__control' && req.method === 'POST') {
          const b = JSON.parse(raw || '{}');
          if (typeof b.declineCharges === 'boolean') state.declineCharges = b.declineCharges;
          if (b.razorpayWebhookSecret) config.razorpaySecret = b.razorpayWebhookSecret;
          if (b.stripeWebhookSecret) config.stripeSecret = b.stripeWebhookSecret;
          if (b.apiUrl) config.apiUrl = b.apiUrl;
          return json(res, 200, { ok: true });
        }
        const pay = path.match(/^\/__pay\/(razorpay|stripe)\/([^/]+)$/);
        if (pay && req.method === 'POST') {
          const obj = pay[1] === 'razorpay' ? state.links.get(pay[2]) : state.sessions.get(pay[2]);
          if (!obj) return json(res, 404, { error: 'no such checkout' });
          return json(res, 200, paidWebhook(pay[1], obj));
        }
        // ----- hosted checkout pages
        const hosted = path.match(/^\/pay\/(razorpay|stripe)\/([^/]+?)(\/confirm|\/cancel)?$/);
        if (hosted) {
          const [, provider, cid, action] = hosted;
          const obj = provider === 'razorpay' ? state.links.get(cid) : state.sessions.get(cid);
          if (!obj) { res.writeHead(404); return res.end('No such checkout'); }
          if (!action) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(provider, obj)); }
          if (action === '/cancel') {
            res.writeHead(303, { location: provider === 'razorpay' ? obj.callback_url : obj.cancel_url });
            return res.end();
          }
          const hook = paidWebhook(provider, obj);
          if (config.send) await deliver(hook);
          const back = provider === 'razorpay' ? `${obj.callback_url}&razorpay_payment_link_id=${obj.id}&razorpay_payment_link_status=paid` : obj.success_url;
          res.writeHead(303, { location: back });
          return res.end();
        }
        // ----- Razorpay
        if (path.startsWith('/v1/payment_links')) {
          if (!authRazorpay(req)) return json(res, 401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
          if (req.method === 'GET') return json(res, 200, { entity: 'collection', count: 0, items: [] });
          const b = JSON.parse(raw);
          if (!b.amount || !b.currency || !b.reference_id) return json(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'amount, currency and reference_id are required' } });
          const link = { id: id('plink'), entity: 'payment_link', status: 'created', amount: b.amount, amount_paid: 0, currency: b.currency, description: b.description, reference_id: b.reference_id, notes: b.notes ?? {}, callback_url: b.callback_url, short_url: `${base}/pay/razorpay/` };
          link.short_url += link.id;
          state.links.set(link.id, link);
          return json(res, 200, link);
        }
        // ----- Stripe
        if (path.startsWith('/v1/')) {
          if (!authStripe(req)) return json(res, 401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } });
          if (path === '/v1/balance') return json(res, 200, { object: 'balance', livemode: false, available: [] });
          const f = parseForm(raw);
          if (path === '/v1/customers' && req.method === 'POST') {
            const c = { id: id('cus'), object: 'customer', name: f.name, email: f.email };
            state.customers.set(c.id, c);
            return json(res, 200, c);
          }
          if (path === '/v1/checkout/sessions' && req.method === 'POST') {
            const s = {
              id: id('cs_test'), object: 'checkout.session', mode: f.mode, customer: f.customer, client_reference_id: f.client_reference_id,
              metadata: { order_id: f['metadata[order_id]'], tenant_id: f['metadata[tenant_id]'] }, amount_total: Number(f['line_items[0][price_data][unit_amount]']),
              currency: f['line_items[0][price_data][currency]'], line_items_name: f['line_items[0][price_data][product_data][name]'], payment_status: 'unpaid', status: 'open',
              success_url: f.success_url, cancel_url: f.cancel_url, url: '',
            };
            s.url = `${base}/pay/stripe/${s.id}`;
            state.sessions.set(s.id, s);
            return json(res, 200, s);
          }
          const pi = path.match(/^\/v1\/payment_intents\/(.+)$/);
          if (pi && req.method === 'GET') {
            const p = state.intents.get(pi[1]);
            return p ? json(res, 200, p) : json(res, 404, { error: { message: 'No such payment_intent' } });
          }
          if (path === '/v1/payment_intents' && req.method === 'POST') {
            if (state.declineCharges) return json(res, 402, { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } });
            const p = { id: id('pi'), object: 'payment_intent', amount: Number(f.amount), currency: f.currency, customer: f.customer, payment_method: f.payment_method, status: 'succeeded', metadata: { invoice_id: f['metadata[invoice_id]'] } };
            state.intents.set(p.id, p);
            state.charges.push(p);
            return json(res, 200, p);
          }
        }
        json(res, 404, { error: { message: `Not handled by the payments stub: ${req.method} ${path}` } });
      } catch (e) {
        json(res, 500, { error: { message: String(e && e.message) } });
      }
    });
  });

  return {
    server,
    state,
    config,
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve(base);
      }));
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

module.exports = { createPaymentsStub, RAZORPAY_SECRET, STRIPE_KEY };

if (require.main === module) {
  const stub = createPaymentsStub();
  stub.listen(Number(process.env.PAYMENTS_STUB_PORT ?? 4060)).then((base) => console.log(`payments stub listening on ${base}`));
}
