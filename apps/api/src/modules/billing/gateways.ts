import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentGateway } from '@crew/contracts';

/**
 * Razorpay and Stripe, spoken to over their REST APIs with the keys SAMPLEDGE saved in Console > Integrations.
 * Nothing here touches the database: BillingEngine decides what to charge and what a payment means.
 */

export interface GatewayKeys {
  provider: PaymentGateway;
  /** Razorpay key id. */
  keyId?: string;
  /** Razorpay key secret or Stripe secret key. */
  secret: string;
  webhookSecret: string | null;
  baseUrl: string;
}

export interface CheckoutInput {
  orderId: string;
  /** Decimal string, e.g. "5900.00". */
  amount: string;
  amountMinor: number;
  currency: string;
  description: string;
  customer: { name: string; email: string; stripeCustomer?: string | null };
  /** Where the browser comes back to after paying (or giving up). */
  returnUrl: string;
  tenantId: string;
}

export interface CheckoutResult {
  providerOrderId: string;
  url: string;
  /** A Stripe customer created for this workspace, to be saved for renewals. */
  stripeCustomer?: string;
}

/** A webhook reduced to what SampCrew acts on. */
export interface GatewayEvent {
  eventId: string;
  type: string;
  /** paid: the order is paid; closed: the checkout expired or was cancelled; other: nothing to do. */
  outcome: 'paid' | 'closed' | 'other';
  providerOrderId: string | null;
  orderId: string | null;
  paymentId: string | null;
  amountMinor: number | null;
  currency: string | null;
  /** Stripe: the payment intent, to find the saved card. */
  paymentIntent?: string | null;
  customer?: string | null;
}

export class GatewayError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
  }
}

const TIMEOUT = 15_000;
const STRIPE_TOLERANCE_S = 300;

export const DEFAULT_BASE: Record<PaymentGateway, string> = { razorpay: 'https://api.razorpay.com', stripe: 'https://api.stripe.com' };

/** Form encoding with Stripe's nested keys: { a: { b: 1 } } -> a[b]=1. */
export function formEncode(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) out.push(...formEncode(v as Record<string, unknown>, key));
    else if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? out.push(...formEncode(item as Record<string, unknown>, `${key}[${i}]`)) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`)));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function call(keys: GatewayKeys, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, unknown>> {
  const url = `${keys.baseUrl.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  let payload: string | undefined;
  if (keys.provider === 'razorpay') {
    headers.authorization = `Basic ${Buffer.from(`${keys.keyId}:${keys.secret}`).toString('base64')}`;
    if (body) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  } else {
    headers.authorization = `Bearer ${keys.secret}`;
    if (body) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = formEncode(body).join('&'); }
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  }
  const name = keys.provider === 'razorpay' ? 'Razorpay' : 'Stripe';
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    throw new GatewayError(`Could not reach ${name}: ${(e as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { description?: string; message?: string; code?: string; decline_code?: string } };
  if (!res.ok) {
    const detail = json.error?.description ?? json.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new GatewayError(`${name} refused the API key${keys.provider === 'razorpay' ? ' id or secret' : ''} (${detail})`, 401, 'unauthorized');
    throw new GatewayError(`${name}: ${detail}`, res.status, json.error?.decline_code ?? json.error?.code);
  }
  return json;
}

/** Signs in with the keys and reports the mode. Used by "Test connection" in the Console. */
export async function probe(keys: GatewayKeys): Promise<string> {
  if (keys.provider === 'razorpay') {
    await call(keys, 'GET', '/v1/payment_links?count=1');
    return `Signed in to Razorpay (${keys.keyId?.startsWith('rzp_live_') ? 'live' : 'test'} mode)`;
  }
  const balance = await call(keys, 'GET', '/v1/balance');
  return `Signed in to Stripe (${balance.livemode ? 'live' : 'test'} mode)`;
}

export async function createCheckout(keys: GatewayKeys, input: CheckoutInput): Promise<CheckoutResult> {
  if (keys.provider === 'razorpay') {
    const sep = input.returnUrl.includes('?') ? '&' : '?';
    const link = await call(keys, 'POST', '/v1/payment_links', {
      amount: input.amountMinor,
      currency: input.currency,
      accept_partial: false,
      description: input.description.slice(0, 2048),
      reference_id: input.orderId,
      customer: { name: input.customer.name.slice(0, 100), email: input.customer.email },
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { order_id: input.orderId, tenant_id: input.tenantId },
      callback_url: `${input.returnUrl}${sep}provider=razorpay`,
      callback_method: 'get',
      expire_by: Math.floor(Date.now() / 1000) + 7 * 86_400,
    });
    if (typeof link.id !== 'string' || typeof link.short_url !== 'string') throw new GatewayError('Razorpay did not return a payment link');
    return { providerOrderId: link.id, url: link.short_url };
  }
  let customer = input.customer.stripeCustomer ?? undefined;
  let created: string | undefined;
  if (!customer) {
    const c = await call(keys, 'POST', '/v1/customers', { name: input.customer.name, email: input.customer.email, metadata: { tenant_id: input.tenantId } }, `customer-${input.tenantId}`);
    customer = created = c.id as string;
  }
  const sep = input.returnUrl.includes('?') ? '&' : '?';
  const session = await call(keys, 'POST', '/v1/checkout/sessions', {
    mode: 'payment',
    customer,
    client_reference_id: input.orderId,
    metadata: { order_id: input.orderId, tenant_id: input.tenantId },
    success_url: `${input.returnUrl}${sep}provider=stripe&status=success`,
    cancel_url: `${input.returnUrl}${sep}provider=stripe&status=cancelled`,
    line_items: [{ quantity: 1, price_data: { currency: input.currency.toLowerCase(), unit_amount: input.amountMinor, product_data: { name: input.description.slice(0, 250) } } }],
    // The card is saved for automatic renewals.
    payment_intent_data: { setup_future_usage: 'off_session', metadata: { order_id: input.orderId, tenant_id: input.tenantId } },
    expires_at: Math.floor(Date.now() / 1000) + 23 * 3600,
  }, `checkout-${input.orderId}`);
  if (typeof session.id !== 'string' || typeof session.url !== 'string') throw new GatewayError('Stripe did not return a checkout page');
  return { providerOrderId: session.id, url: session.url, stripeCustomer: created };
}

/** Stripe: the card a checkout saved, from its payment intent. */
export async function stripePaymentMethod(keys: GatewayKeys, paymentIntent: string): Promise<string | null> {
  const pi = await call(keys, 'GET', `/v1/payment_intents/${encodeURIComponent(paymentIntent)}`);
  return typeof pi.payment_method === 'string' ? pi.payment_method : null;
}

/**
 * Stripe: charges a saved card without the customer present (an automatic renewal). Returns the payment intent
 * id when it succeeded; throws GatewayError (with the decline code) when the bank refused or needs the customer.
 */
export async function chargeSavedCard(keys: GatewayKeys, input: { customer: string; paymentMethod: string; amountMinor: number; currency: string; description: string; invoiceId: string; tenantId: string }): Promise<string> {
  const pi = await call(keys, 'POST', '/v1/payment_intents', {
    amount: input.amountMinor,
    currency: input.currency.toLowerCase(),
    customer: input.customer,
    payment_method: input.paymentMethod,
    off_session: 'true',
    confirm: 'true',
    description: input.description.slice(0, 1000),
    metadata: { invoice_id: input.invoiceId, tenant_id: input.tenantId },
  }, `renewal-${input.invoiceId}`);
  if (pi.status !== 'succeeded') throw new GatewayError(`Stripe could not complete the payment (status ${String(pi.status)})`, 402, String(pi.status));
  return pi.id as string;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Checks a webhook's signature with the webhook secret, then reads it. Throws when the signature does not match. */
export function verifyWebhook(provider: PaymentGateway, secret: string, raw: Buffer, headers: Record<string, string | string[] | undefined>, now = Date.now()): GatewayEvent {
  const header = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  if (provider === 'razorpay') {
    const sig = header('x-razorpay-signature');
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    if (!sig || !safeEqual(sig, expected)) throw new GatewayError('The webhook signature does not match the Razorpay webhook secret', 400, 'bad_signature');
    const body = JSON.parse(raw.toString('utf8')) as { event: string; created_at?: number; payload?: { payment_link?: { entity?: Record<string, unknown> }; payment?: { entity?: Record<string, unknown> } } };
    const link = body.payload?.payment_link?.entity ?? {};
    const payment = body.payload?.payment?.entity ?? {};
    const eventId = header('x-razorpay-event-id') ?? createHmac('sha256', 'event-id').update(raw).digest('hex');
    return {
      eventId, type: body.event,
      outcome: body.event === 'payment_link.paid' ? 'paid' : body.event === 'payment_link.expired' || body.event === 'payment_link.cancelled' ? 'closed' : 'other',
      providerOrderId: (link.id as string) ?? null,
      orderId: (link.reference_id as string) ?? ((link.notes as Record<string, string> | undefined)?.order_id ?? null),
      paymentId: (payment.id as string) ?? null,
      amountMinor: typeof payment.amount === 'number' ? payment.amount : typeof link.amount_paid === 'number' ? link.amount_paid : null,
      currency: (payment.currency as string) ?? (link.currency as string) ?? null,
    };
  }
  const sig = header('stripe-signature') ?? '';
  const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=') as [string, string]).filter((p) => p.length === 2 && p[0] === 't'));
  const t = Number(parts.t);
  const v1 = sig.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const expected = createHmac('sha256', secret).update(`${parts.t}.${raw.toString('utf8')}`).digest('hex');
  if (!t || !v1.some((s) => safeEqual(s, expected))) throw new GatewayError('The webhook signature does not match the Stripe signing secret', 400, 'bad_signature');
  if (Math.abs(now / 1000 - t) > STRIPE_TOLERANCE_S) throw new GatewayError('The webhook is too old (more than 5 minutes); it may be a replay', 400, 'stale_signature');
  const body = JSON.parse(raw.toString('utf8')) as { id: string; type: string; data?: { object?: Record<string, unknown> } };
  const o = body.data?.object ?? {};
  const paid = body.type === 'checkout.session.completed' && o.payment_status === 'paid';
  return {
    eventId: body.id, type: body.type,
    outcome: paid || body.type === 'checkout.session.async_payment_succeeded' ? 'paid' : body.type === 'checkout.session.expired' || body.type === 'checkout.session.async_payment_failed' ? 'closed' : 'other',
    providerOrderId: (o.id as string) ?? null,
    orderId: (o.client_reference_id as string) ?? ((o.metadata as Record<string, string> | undefined)?.order_id ?? null),
    paymentId: (o.payment_intent as string) ?? null,
    amountMinor: typeof o.amount_total === 'number' ? o.amount_total : null,
    currency: typeof o.currency === 'string' ? o.currency.toUpperCase() : null,
    paymentIntent: (o.payment_intent as string) ?? null,
    customer: (o.customer as string) ?? null,
  };
}
