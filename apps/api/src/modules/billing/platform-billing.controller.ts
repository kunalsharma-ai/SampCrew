import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import {
  addonCreate,
  addonUpdate,
  billingSettingsInput,
  couponCreate,
  couponUpdate,
  dealInput,
  invoiceMarkPaid,
  invoiceVoid,
  manualInvoice,
  planBillingUpdate,
  type AddonCreate,
  type AddonUpdate,
  type CouponCreate,
  type DealInput,
  type PlanBillingUpdate,
} from '@crew/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { PlatformRealm } from '../../platform/authz/decorators';
import { contentDisposition } from '../../platform/http/content-disposition';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { BillingEngine } from './billing-engine.service';
import { PlatformBillingService } from './platform-billing.service';

const invoicesQuery = z.object({ status: z.enum(['open', 'paid', 'void', 'overdue']).optional(), tenantId: z.uuid().optional() });
const runInput = z.object({ tenantId: z.uuid().optional(), asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict();
const unlockInput = z.object({ reason: z.string().trim().min(5).max(300) }).strict();
const keyParam = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

/** Billing in the Super Admin Console. Billing staff and Super admins change it; everyone with billing:read can see it. */
@Controller('platform/billing')
export class PlatformBillingController {
  constructor(
    private readonly billing: PlatformBillingService,
    private readonly engine: BillingEngine,
  ) {}

  @PlatformRealm('billing:read')
  @Get('settings')
  @Doc({ summary: 'How SAMPLEDGE bills: seller details and GSTIN, tax, invoice numbers, payment terms, reminders, read-only lock, gateway per currency' })
  settings() {
    return this.engine.settings();
  }

  @PlatformRealm('billing:manage')
  @Put('settings')
  @Doc({ summary: 'Save the billing settings', body: billingSettingsInput })
  saveSettings(@Body() body: unknown) {
    return this.engine.saveSettings(body);
  }

  @PlatformRealm('billing:read')
  @Get('revenue')
  @Doc({ summary: 'Revenue: MRR and ARR, subscriptions by status, upgrades, downgrades, churn, trial conversion, money collected and outstanding, per plan and add-on' })
  revenue() {
    return this.billing.revenue();
  }

  @PlatformRealm('billing:read')
  @Get('invoices')
  @Doc({ summary: 'Invoices across workspaces', query: invoicesQuery })
  invoices(@Query(new ZodPipe(invoicesQuery)) q: z.infer<typeof invoicesQuery>) {
    return this.billing.invoices(q);
  }

  @PlatformRealm('billing:read')
  @Get('invoices/:id/pdf')
  @Doc({ summary: 'An invoice as a PDF' })
  async invoicePdf(@Param('id', UuidPipe) id: string, @Res() res: Response) {
    const f = await this.billing.invoicePdf(id);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', contentDisposition('attachment', f.filename));
    res.setHeader('cache-control', 'private, no-store');
    res.send(f.pdf);
  }

  @PlatformRealm('billing:manage')
  @Post('invoices/:id/mark-paid')
  @HttpCode(200)
  @Doc({ summary: 'Record a bank transfer or cheque for an invoice (lifts past-due and the read-only lock when nothing else is overdue)', body: invoiceMarkPaid })
  markPaid(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(invoiceMarkPaid)) body: z.infer<typeof invoiceMarkPaid>) {
    return this.billing.markPaid(id, body);
  }

  @PlatformRealm('billing:manage')
  @Post('invoices/:id/void')
  @HttpCode(200)
  @Doc({ summary: 'Void an open invoice', body: invoiceVoid })
  voidInvoice(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(invoiceVoid)) body: z.infer<typeof invoiceVoid>) {
    return this.billing.voidInvoice(id, body.reason);
  }

  @PlatformRealm('billing:read')
  @Get('tenants/:id')
  @Doc({ summary: 'One workspace\'s billing: subscription, deal, coupon, add-ons, usage, invoices and payments' })
  tenant(@Param('id', UuidPipe) id: string) {
    return this.billing.tenantBilling(id);
  }

  @PlatformRealm('billing:manage')
  @Put('tenants/:id/deal')
  @Doc({ summary: 'Contract terms for one workspace: price per seat, discount, extra modules, end date (empty clears it)', body: dealInput })
  deal(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(dealInput)) body: DealInput) {
    return this.billing.setDeal(id, body);
  }

  @PlatformRealm('billing:manage')
  @Post('tenants/:id/invoices')
  @Doc({ summary: 'Issue an invoice by hand (a one-off charge)', body: manualInvoice })
  manualInvoice(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(manualInvoice)) body: z.infer<typeof manualInvoice>) {
    return this.billing.manualInvoice(id, body);
  }

  @PlatformRealm('billing:manage')
  @Post('tenants/:id/unlock')
  @HttpCode(200)
  @Doc({ summary: 'Lift the read-only lock for 7 days while a payment is on its way', body: unlockInput })
  unlock(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(unlockInput)) body: z.infer<typeof unlockInput>) {
    return this.billing.unlock(id, body.reason);
  }

  @PlatformRealm('billing:manage')
  @Post('run')
  @HttpCode(200)
  @Doc({ summary: 'Run the billing clock now: renewals, trial ends, reminders, read-only lock, usage warnings (it also runs every hour)', body: runInput })
  run(@Body(new ZodPipe(runInput)) body: z.infer<typeof runInput>) {
    return this.billing.run(body);
  }

  @PlatformRealm('billing:read')
  @Get('payment-events')
  @Doc({ summary: 'The latest webhooks from Razorpay and Stripe and what SampCrew did with each' })
  paymentEvents() {
    return this.billing.paymentEvents();
  }

  @PlatformRealm('plans:manage')
  @Put('plans/:key')
  @Doc({ summary: 'A plan\'s free trial (days and modules) and, per limit, whether to stop or bill overage', body: planBillingUpdate })
  planBilling(@Param('key', new ZodPipe(keyParam)) key: string, @Body(new ZodPipe(planBillingUpdate)) body: PlanBillingUpdate) {
    return this.billing.setPlanBilling(key, body);
  }

  @PlatformRealm('billing:read')
  @Get('addons')
  @Doc({ summary: 'The add-on catalogue with how many workspaces have each' })
  addons() {
    return this.billing.addons();
  }

  @PlatformRealm('plans:manage')
  @Post('addons')
  @Doc({ summary: 'Create an add-on: a module, or more of a limit (employees, AI credits, storage)', body: addonCreate })
  createAddon(@Body(new ZodPipe(addonCreate)) body: AddonCreate) {
    return this.billing.createAddon(body);
  }

  @PlatformRealm('plans:manage')
  @Patch('addons/:key')
  @Doc({ summary: 'Change an add-on\'s name, prices, plans or visibility, or archive it (workspaces that have it keep it)', body: addonUpdate })
  updateAddon(@Param('key', new ZodPipe(keyParam)) key: string, @Body(new ZodPipe(addonUpdate)) body: AddonUpdate) {
    return this.billing.updateAddon(key, body);
  }

  @PlatformRealm('billing:read')
  @Get('coupons')
  @Doc({ summary: 'Coupon codes with how often each was used' })
  coupons() {
    return this.billing.coupons();
  }

  @PlatformRealm('billing:manage')
  @Post('coupons')
  @Doc({ summary: 'Create a coupon code (percent or amount off, once, for some invoices or forever)', body: couponCreate })
  createCoupon(@Body(new ZodPipe(couponCreate)) body: CouponCreate) {
    return this.billing.createCoupon(body);
  }

  @PlatformRealm('billing:manage')
  @Patch('coupons/:id')
  @Doc({ summary: 'Switch a coupon code on or off', body: couponUpdate })
  coupon(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(couponUpdate)) body: z.infer<typeof couponUpdate>) {
    return this.billing.setCouponActive(id, body.active);
  }
}
