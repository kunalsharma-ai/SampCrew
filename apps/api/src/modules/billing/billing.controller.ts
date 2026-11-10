import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  addonPurchase,
  billingProfileInput,
  checkoutRequest,
  couponCheck,
  PAYMENT_GATEWAYS,
  planRequestCreate,
  renewalSettings,
  trialStart,
  type BillingProfileInput,
  type CheckoutRequest,
  type PaymentGateway,
} from '@crew/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AllowWhenLocked, Public, RequirePermission } from '../../platform/authz/decorators';
import { requestContext } from '../../platform/context/request-context';
import { contentDisposition } from '../../platform/http/content-disposition';
import { Errors } from '../../platform/http/errors';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { BillingEngine } from './billing-engine.service';
import { BillingService } from './billing.service';

const addonKeyParam = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

/**
 * Plan & billing. Reachable while the workspace is read-only for an unpaid invoice, so it can always pay.
 */
@Controller('billing')
@AllowWhenLocked()
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly engine: BillingEngine,
    private readonly db: DatabaseService,
  ) {}

  @Get('plans')
  @Doc({ summary: 'Available plans with prices, features, limits, trial days and overage policy' })
  plans() {
    return this.billing.plans();
  }

  @Get('subscription')
  @RequirePermission('billing:read')
  @Doc({ summary: 'Current subscription, scheduled change, trial, read-only lock, contract terms and whether online payment is set up' })
  subscription() {
    return this.billing.subscription();
  }

  @Post('quote')
  @HttpCode(200)
  @RequirePermission('billing:read')
  @Doc({ summary: 'What a plan change would cost now (proration, credit, coupon, GST) and when it applies', body: checkoutRequest })
  quote(@Body(new ZodPipe(checkoutRequest)) body: CheckoutRequest) {
    return this.billing.quote(body);
  }

  @Put('subscription')
  @RequirePermission('billing:manage')
  @Doc({ summary: 'Change plan, cycle or seats. Paying less waits for the period end; an upgrade is charged for the days left, through Razorpay or Stripe when set up (the response then holds the checkout address), else invoiced.', body: checkoutRequest })
  change(@Body(new ZodPipe(checkoutRequest)) body: CheckoutRequest) {
    return this.billing.change(body);
  }

  @Delete('scheduled-change')
  @RequirePermission('billing:manage')
  @Doc({ summary: 'Cancel a plan change waiting for the end of the period' })
  cancelScheduled() {
    return this.engine.cancelScheduled(requestContext.tenantActor().tenantId);
  }

  @Put('renewal')
  @RequirePermission('billing:manage')
  @Doc({ summary: 'Renew automatically at the end of each period, or stop at the end of this one', body: renewalSettings })
  renewal(@Body(new ZodPipe(renewalSettings)) body: z.infer<typeof renewalSettings>) {
    return this.engine.setAutoRenew(requestContext.tenantActor().tenantId, body.autoRenew);
  }

  @Post('trial')
  @RequirePermission('billing:manage')
  @Doc({ summary: 'Try a plan free for its trial days (once per workspace). At the end, buy it or go back to the current plan.', body: trialStart })
  trial(@Body(new ZodPipe(trialStart)) body: z.infer<typeof trialStart>) {
    return this.engine.startTrial(requestContext.tenantActor().tenantId, body.planKey);
  }

  @Post('coupons/check')
  @HttpCode(200)
  @RequirePermission('billing:read')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Doc({ summary: 'Check a coupon code before using it', body: couponCheck })
  async checkCoupon(@Body(new ZodPipe(couponCheck)) body: z.infer<typeof couponCheck>) {
    const tenantId = requestContext.tenantActor().tenantId;
    return this.db.platform(async (tx) => {
      const sub = (await tx.collection('subscriptions').findOne({ tenant_id: tenantId }))!;
      const planKey = body.planKey ?? (await tx.collection('plans').findOne({ id: sub.plan_id }))!.key;
      const c = await this.engine.validCoupon(tx, tenantId, body.code, planKey, sub.currency);
      return { code: String(c.code).toUpperCase(), name: c.name, kind: c.kind, value: c.value, currency: c.currency ?? null, duration: c.duration, cycles: c.cycles ?? null };
    });
  }

  @Get('usage')
  @RequirePermission('billing:read')
  @Doc({ summary: 'Usage against each limit (employees, AI credits this month, storage) with the policy beyond it' })
  usage() {
    return this.engine.usage(requestContext.tenantActor().tenantId);
  }

  @Get('addons')
  @RequirePermission('billing:read')
  @Doc({ summary: 'Add-ons the workspace can buy on its plan, and the ones it has' })
  addons() {
    return this.db.platform((tx) => this.engine.addonOffer(tx, requestContext.tenantActor().tenantId));
  }

  @Post('addons')
  @RequirePermission('billing:manage')
  @Doc({ summary: 'Buy an add-on or more of it. The rest of the period is charged now (checkout when online payment is set up).', body: addonPurchase })
  buyAddon(@Body(new ZodPipe(addonPurchase)) body: z.infer<typeof addonPurchase>) {
    const actor = requestContext.tenantActor();
    return this.engine.buyAddon(actor.tenantId, body, actor.membershipId);
  }

  @Delete('addons/:key')
  @RequirePermission('billing:manage')
  @Doc({ summary: 'Remove an add-on at the end of the paid period (it works until then)' })
  removeAddon(@Param('key', new ZodPipe(addonKeyParam)) key: string) {
    return this.engine.removeAddon(requestContext.tenantActor().tenantId, key);
  }

  @Post('addons/:key/keep')
  @HttpCode(200)
  @RequirePermission('billing:manage')
  @Doc({ summary: 'Keep an add-on that was going to end with the period' })
  keepAddon(@Param('key', new ZodPipe(addonKeyParam)) key: string) {
    return this.engine.removeAddon(requestContext.tenantActor().tenantId, key, true);
  }

  @Get('profile')
  @RequirePermission('billing:read')
  @Doc({ summary: 'Billing details printed on invoices (legal name, GSTIN, address)' })
  profile() {
    return this.engine.profile(requestContext.tenantActor().tenantId);
  }

  @Put('profile')
  @RequirePermission('billing:manage')
  @Doc({ summary: 'Save billing details. A GSTIN and state decide CGST + SGST or IGST on the next invoices.', body: billingProfileInput })
  saveProfile(@Body(new ZodPipe(billingProfileInput)) body: BillingProfileInput) {
    return this.engine.saveProfile(requestContext.tenantActor().tenantId, body);
  }

  @Get('plan-requests')
  @RequirePermission('billing:read')
  @Doc({ summary: 'Requests this workspace sent SAMPLEDGE for a quote-only plan, with their answers' })
  planRequests() {
    return this.billing.planRequests();
  }

  @Post('plan-requests')
  @RequirePermission('billing:manage')
  @Doc({ summary: 'Ask SAMPLEDGE for a quote-only plan (such as Enterprise). SAMPLEDGE approves it in the Console and the plan is applied.', body: planRequestCreate })
  requestPlan(@Body(new ZodPipe(planRequestCreate)) body: z.infer<typeof planRequestCreate>) {
    return this.billing.requestPlan(body);
  }

  @Post('plan-requests/:id/withdraw')
  @HttpCode(200)
  @RequirePermission('billing:manage')
  @Doc({ summary: 'Withdraw a plan request SAMPLEDGE has not answered yet' })
  withdrawPlanRequest(@Param('id', UuidPipe) id: string) {
    return this.billing.withdrawPlanRequest(id);
  }

  @Get('invoices')
  @RequirePermission('billing:read')
  @Doc({ summary: 'Invoices for this workspace' })
  invoices() {
    return this.billing.invoices();
  }

  @Get('invoices/:id/pdf')
  @RequirePermission('billing:read')
  @Doc({ summary: 'The invoice as a PDF (tax invoice with GST when SAMPLEDGE has a GSTIN)' })
  async invoicePdf(@Param('id', UuidPipe) id: string, @Res() res: Response) {
    const f = await this.billing.invoicePdf(id);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', contentDisposition('attachment', f.filename));
    res.setHeader('cache-control', 'private, no-store');
    res.send(f.pdf);
  }

  @Post('invoices/:id/pay')
  @HttpCode(200)
  @RequirePermission('billing:manage')
  @Doc({ summary: 'Pay an open invoice online: returns the Razorpay or Stripe checkout address' })
  pay(@Param('id', UuidPipe) id: string) {
    const actor = requestContext.tenantActor();
    return this.engine.payInvoice(actor.tenantId, id, actor.membershipId);
  }

  @Get('orders/:id')
  @RequirePermission('billing:read')
  @Doc({ summary: 'Whether a payment sent to Razorpay or Stripe has been confirmed' })
  order(@Param('id', UuidPipe) id: string) {
    return this.billing.order(id);
  }
}

/**
 * Webhooks from Razorpay and Stripe. Public, but every request must carry a valid signature made with the webhook
 * secret saved in Console > Integrations; anything else is refused and recorded.
 */
@Controller('billing/webhooks')
@Public()
export class BillingWebhooksController {
  constructor(private readonly engine: BillingEngine) {}

  @Post(':provider')
  @HttpCode(200)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  @Doc({ summary: 'Payment confirmations from Razorpay (X-Razorpay-Signature) or Stripe (Stripe-Signature)' })
  webhook(@Param('provider') provider: string, @Req() req: Request & { rawBody?: Buffer }) {
    if (!(PAYMENT_GATEWAYS as readonly string[]).includes(provider)) throw Errors.notFound('Payment provider');
    if (!req.rawBody) throw Errors.badRequest('no_body', 'Send the event as JSON');
    return this.engine.webhook(provider as PaymentGateway, req.rawBody, req.headers);
  }
}
