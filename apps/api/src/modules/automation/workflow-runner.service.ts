import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { automation, TRIGGER_EVENTS, webhookBody, type TriggerEvent, type WorkflowDefinition, type WorkflowStep } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { loadSubject } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext, type TenantActor } from '../../platform/context/request-context';
import { membershipUserNames, MongoService as DatabaseService, type TenantTx as Tx } from '../../platform/database/mongo.service';
import { loadEntitlements } from '../../platform/entitlements/entitlements.service';
import { type DomainEvent, OutboxService } from '../../platform/events/outbox.service';
import { NotificationService } from '../../platform/notify/notification.service';
import { type ApprovalRequestRow, ApprovalsService } from '../approvals/approvals.service';
import { attrsOf, talentEmployee } from '../talent/talent-common';
import { LearningService } from '../talent/learning.service';
import { ConnectionsService, ConnectorError } from '../integrations/connections.service';
import { WebhooksService } from '../integrations/webhooks.service';
import { contextForEvent, type RunContext } from './workflow-context';

interface RunRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  version_id: string;
  mode: 'live' | 'test';
  subject_employee_id: string | null;
  context: RunContext;
  status: string;
  step_index: number;
  attempt: number;
}

interface WorkflowRow { id: string; name: string; status: string; owner_membership_id: string }

/** PostgreSQL's md5(text)::uuid: a stable id from a text. */
const md5Uuid = (text: string) => createHash('md5').update(text).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

/** Members holding a role (by key) whose membership is active. */
async function activeHolders(tx: Tx, roleKey: string): Promise<string[]> {
  const roleIds = await tx.collection('roles').distinct<string>('id', { key: roleKey });
  const holders = await tx.collection('role_assignments').distinct<string>('membership_id', { role_id: { $in: roleIds } });
  return tx.collection('memberships').distinct<string>('id', { id: { $in: holders }, status: 'active' });
}

/** A step that could not run; the runner retries it with back-off and then fails the run. */
class StepError extends Error {
  constructor(message: string, public readonly retryable = true) {
    super(message);
  }
}

type StepOutcome =
  | { kind: 'next'; status: 'succeeded' | 'simulated'; detail: string }
  | { kind: 'stop'; detail: string }
  | { kind: 'wait'; detail: string; wakeAt: Date | null; approvalRequestId?: string };

/**
 * Durable workflow runner. Domain events (from the transactional outbox) start runs; each run moves through its
 * steps with its position saved after every step, so a restart carries on where it left off. Delays and
 * approvals park the run; a timer loop picks runs whose time has come. A failing step is retried three times
 * with back-off, then the run fails and can be retried from that step. Every step acts as the workflow's owner,
 * whose permissions are checked again each time.
 */
@Injectable()
export class WorkflowRunnerService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Workflows');
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxService,
    private readonly approvals: ApprovalsService,
    private readonly notifications: NotificationService,
    private readonly learning: LearningService,
    private readonly audit: AuditService,
    private readonly connections: ConnectionsService,
    private readonly webhooks: WebhooksService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    for (const type of TRIGGER_EVENTS) this.outbox.subscribe(type, async (e) => { await this.onEvent(e); });
    this.approvals.register('workflow_run', {
      permission: 'employees:read',
      configurePermission: 'automation:manage',
      defaultSteps: [{ type: 'manager' }],
      fallbackRole: 'hr_admin',
      label: 'Workflow approval',
      link: () => '/approvals',
      attributes: async (tx, id) => {
        const r = await tx.collection('workflow_runs').findOne({ id }, { projection: { subject_employee_id: 1 } });
        return attrsOf(await talentEmployee(tx, r!.subject_employee_id as string));
      },
      onApproved: (tx, req) => this.onDecision(tx, req, true),
      onRejected: (tx, req) => this.onDecision(tx, req, false),
    });
  }

  onApplicationBootstrap() {
    if (this.config.CREW_DISABLE_DISPATCHER === 'true' || this.config.CREW_ENV === 'test') return;
    this.timer = setInterval(() => void this.runDue().catch((err: Error) => this.logger.error(`Workflow tick failed: ${err.message}`)), 3000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // Starting runs ------------------------------------------------------------------------------------------------

  /** Starts one live run per active workflow listening for this event. Idempotent per event. */
  async onEvent(e: DomainEvent): Promise<number> {
    if (!e.tenantId) return 0;
    const tenantId = e.tenantId;
    return this.db.tenant(async (tx) => {
      const flows = await tx.collection('workflows').find({ status: 'active', trigger_event: e.type, active_version_id: { $ne: null } }, { projection: { active_version_id: 1 } });
      if (!flows.length) return 0;
      const ent = await this.entitlementsFor(tx);
      if (!ent) return 0;
      const ctx = await contextForEvent(tx, e.type as TriggerEvent, e.payload);
      if (!ctx) return 0;
      let started = 0;
      for (const f of flows) {
        // One run per workflow and event, however often the event is delivered.
        if (await tx.collection('workflow_runs').exists({ workflow_id: f.id, event_id: e.id })) continue;
        await tx.collection('workflow_runs').insert({
          workflow_id: f.id, version_id: f.active_version_id, mode: 'live', event_id: e.id, subject_employee_id: ctx.employeeId, context: ctx.context, status: 'running', wake_at: new Date(),
        });
        started++;
      }
      return started;
    }, { tenantId });
  }

  private async entitlementsFor(tx: Tx) {
    const e = await loadEntitlements(tx);
    return e.features.has('automation') ? e : null;
  }

  // Advancing runs -----------------------------------------------------------------------------------------------

  /** Advances every live run whose time has come (and recovers runs left mid-step by a restart). */
  async runDue(limit = 25): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const dueFilter = () => ({
        mode: 'live',
        $or: [
          { status: { $in: ['running', 'waiting'] }, wake_at: { $lte: new Date() } },
          { status: 'running', wake_at: null, updated_at: { $lt: new Date(Date.now() - 5 * 60_000) } },
        ],
      });
      const candidates = await this.db.platform((tx) => tx.collection('workflow_runs').find(dueFilter(), { sort: { wake_at: 1 }, limit, projection: { tenant_id: 1 } }));
      // Each run is claimed on its own: one that another worker claimed first no longer matches and is skipped.
      const due: { id: string; tenant_id: string }[] = [];
      for (const c of candidates) {
        const claimed = await this.db.platform((tx) => tx.collection('workflow_runs').update({ id: c.id, ...dueFilter() }, { $set: { wake_at: null, updated_at: new Date() } }, { limit: 1 })).catch(() => 0);
        if (claimed) due.push({ id: c.id as string, tenant_id: c.tenant_id as string });
      }
      for (const r of due) {
        try {
          await this.advance(r.tenant_id, r.id);
        } catch (err) {
          this.logger.error(`Workflow run ${r.id} failed to advance: ${(err as Error).message}`);
        }
      }
      return due.length;
    } finally {
      this.ticking = false;
    }
  }

  /** Runs steps until the run waits, stops, fails or finishes. */
  async advance(tenantId: string, runId: string): Promise<void> {
    for (let guard = 0; guard < 50; guard++) {
      const loaded = await this.db.tenant(async (tx) => {
        const run = (await tx.collection('workflow_runs').findOne({ id: runId })) as RunRow | undefined;
        if (!run || !['running', 'waiting'].includes(run.status)) return null;
        const wf = (await tx.collection('workflows').findOne({ id: run.workflow_id })) as unknown as WorkflowRow;
        const v = (await tx.collection('workflow_versions').findOne({ id: run.version_id }))!;
        const m = await tx.collection('memberships').findOne({ id: wf.owner_membership_id });
        const owner = m ? { user_id: m.user_id as string, status: m.status as string, label: (await membershipUserNames(tx, [m.id])).get(m.id as string) ?? '' } : undefined;
        return { run, wf, def: v.definition as WorkflowDefinition, owner };
      }, { tenantId });
      if (!loaded) return;
      const { run, wf, def, owner } = loaded;
      if (run.step_index >= def.steps.length) {
        await this.finish(tenantId, runId, 'succeeded', 'All steps done');
        return;
      }
      if (wf.status !== 'active') {
        await this.finish(tenantId, runId, 'cancelled', `The workflow was ${wf.status === 'paused' ? 'paused' : 'archived'}`);
        return;
      }
      if (!owner || owner.status !== 'active') {
        await this.failAndPause(tenantId, run, wf, 'The workflow owner is no longer an active member, so the workflow was paused.');
        return;
      }
      const actor: TenantActor = { kind: 'user', userId: owner.user_id, tenantId, membershipId: wf.owner_membership_id, sessionId: `workflow:${runId}`, mfa: true, label: `Workflow "${wf.name}" (as ${owner.label})` };
      const step = def.steps[run.step_index]!;
      const outcome = await requestContext.run({ requestId: `workflow-${runId}`, actor }, async () => {
        const allowed = await this.db.tenant(async (tx) => hasPermission(await loadSubject(tx, actor.membershipId, actor.userId, true), 'automation:manage').allowed);
        if (!allowed) return 'owner_lost_permission' as const;
        try {
          return await this.execute(run, step, wf);
        } catch (err) {
          return err instanceof StepError ? err : new StepError((err as Error).message ?? 'Step failed');
        }
      });
      if (outcome === 'owner_lost_permission') {
        await this.failAndPause(tenantId, run, wf, 'The workflow owner no longer has permission to manage workflows, so the workflow was paused.');
        return;
      }
      if (outcome instanceof StepError) {
        await this.stepFailed(tenantId, run, step, outcome);
        return;
      }
      const moved = await this.db.tenant(async (tx) => this.record(tx, run, step, outcome), { tenantId });
      if (!moved) return;
    }
  }

  /** Writes the step's result and moves the run. Returns whether to keep going. */
  private async record(tx: Tx, run: RunRow, step: WorkflowStep, o: StepOutcome): Promise<boolean> {
    const status = o.kind === 'next' ? o.status : o.kind === 'stop' ? 'stopped' : 'waiting';
    await this.stepRun(tx, { run_id: run.id, step_index: run.step_index, step_id: step.id, type: step.type, attempt: run.attempt + 1, status, detail: o.detail.slice(0, 2000) });
    const runs = tx.collection('workflow_runs');
    if (o.kind === 'next') {
      await runs.updateOne({ id: run.id }, { $inc: { step_index: 1 }, $set: { attempt: 0, status: 'running', wake_at: null } });
      return true;
    }
    if (o.kind === 'stop') {
      await runs.updateOne({ id: run.id }, { $set: { status: 'stopped', outcome: o.detail.slice(0, 500), finished_at: new Date(), wake_at: null } });
      return false;
    }
    await runs.updateOne({ id: run.id }, { $set: { status: 'waiting', wake_at: o.wakeAt, ...(o.approvalRequestId ? { approval_request_id: o.approvalRequestId } : {}) } });
    return false;
  }

  /** Records a step attempt once: a repeat of the same attempt and outcome is ignored. */
  private async stepRun(tx: Tx, row: { run_id: string; step_index: number; step_id: string; type: string; attempt: number; status: string; detail: string; error?: string }) {
    const steps = tx.collection('workflow_step_runs');
    if (await steps.exists({ run_id: row.run_id, step_index: row.step_index, attempt: row.attempt, status: row.status })) return;
    await steps.insert(row);
  }

  private async finish(tenantId: string, runId: string, status: 'succeeded' | 'cancelled', outcome: string) {
    await this.db.tenant((tx) => tx.collection('workflow_runs').update({ id: runId, status: { $in: ['running', 'waiting'] } }, { $set: { status, outcome, finished_at: new Date(), wake_at: null } }), { tenantId });
  }

  private async failAndPause(tenantId: string, run: RunRow, wf: WorkflowRow, reason: string) {
    await this.db.tenant(async (tx) => {
      await tx.collection('workflow_runs').updateOne({ id: run.id }, { $set: { status: 'failed', error: reason, finished_at: new Date(), wake_at: null } });
      await tx.collection('workflows').update({ id: wf.id, status: 'active' }, { $set: { status: 'paused', status_reason: reason } });
      await this.audit.record(tx, { tenantId, action: 'workflow.paused_automatically', resourceType: 'workflow', resourceId: wf.id, metadata: { reason } });
    }, { tenantId });
  }

  private async stepFailed(tenantId: string, run: RunRow, step: WorkflowStep, err: StepError) {
    const attempt = run.attempt + 1;
    const final = !err.retryable || attempt >= automation.MAX_STEP_ATTEMPTS;
    await this.db.tenant(async (tx) => {
      await this.stepRun(tx, {
        run_id: run.id, step_index: run.step_index, step_id: step.id, type: step.type, attempt, status: 'failed',
        detail: final ? 'Gave up' : `Will retry (attempt ${attempt} of ${automation.MAX_STEP_ATTEMPTS})`, error: err.message.slice(0, 2000),
      });
      if (final) {
        await tx.collection('workflow_runs').updateOne({ id: run.id }, { $set: { status: 'failed', attempt, error: err.message.slice(0, 2000), finished_at: new Date(), wake_at: null } });
        const wf = (await tx.collection('workflows').findOne({ id: run.workflow_id }))!;
        await this.notifications.notify(tx, { membershipIds: [wf.owner_membership_id], kind: 'workflow.failed', title: `Workflow "${wf.name}" failed at step ${run.step_index + 1}`, body: err.message, link: `/automation/runs/${run.id}` });
      } else {
        await tx.collection('workflow_runs').updateOne({ id: run.id }, { $set: { status: 'running', attempt, error: err.message.slice(0, 2000), wake_at: new Date(Date.now() + automation.retryDelayMs(attempt)) } });
      }
    }, { tenantId });
  }

  /** Resumes a run parked on an approval step. Runs inside the approver's decision transaction. */
  private async onDecision(tx: Tx, req: ApprovalRequestRow, approved: boolean) {
    const run = (await tx.collection('workflow_runs').findOne({ id: req.resource_id, status: 'waiting', approval_request_id: req.id })) as RunRow | undefined;
    if (!run) return;
    const v = (await tx.collection('workflow_versions').findOne({ id: run.version_id }))!;
    const step = (v.definition as WorkflowDefinition).steps[run.step_index]!;
    const who = requestContext.tenantActor().label;
    if (approved) {
      await this.record(tx, run, step, { kind: 'next', status: 'succeeded', detail: `Approved by ${who}` });
      await tx.collection('workflow_runs').updateOne({ id: run.id }, { $set: { wake_at: new Date(), approval_request_id: null } });
    } else {
      await this.record(tx, run, step, { kind: 'stop', detail: `Rejected by ${who}` });
    }
  }

  // Steps --------------------------------------------------------------------------------------------------------

  private async execute(run: RunRow, step: WorkflowStep, wf: WorkflowRow): Promise<StepOutcome> {
    const ctx = run.context;
    switch (step.type) {
      case 'condition': {
        const r = automation.evaluateCondition(step, ctx);
        const detail = `${step.field} is "${r.actual ?? 'empty'}"; ${automation.describeStep(step).toLowerCase()}`;
        return r.met ? { kind: 'next', status: 'succeeded', detail: `Met: ${detail}` } : { kind: 'stop', detail: `Stopped: ${detail}` };
      }
      case 'delay': {
        const waited = await this.db.tenant((tx) => tx.collection('workflow_step_runs').exists({ run_id: run.id, step_index: run.step_index, status: 'waiting' }));
        if (waited) return { kind: 'next', status: 'succeeded', detail: 'Waited' };
        const wakeAt = new Date(Date.now() + automation.delayMs(step));
        return { kind: 'wait', detail: `${automation.describeStep(step)}, until ${wakeAt.toISOString()}`, wakeAt };
      }
      case 'notify':
        return this.db.tenant(async (tx) => {
          const to = await this.recipients(tx, step, run.subject_employee_id);
          const title = automation.render(step.title, ctx).slice(0, 200) || wf.name;
          const n = await this.notifications.notify(tx, { membershipIds: to, kind: 'workflow.notice', title, body: automation.render(step.body, ctx) || undefined, link: undefined, email: step.email });
          return { kind: 'next', status: 'succeeded', detail: n ? `Notified ${n} ${n === 1 ? 'person' : 'people'}: "${title}"` : 'Nobody to notify (no matching active member)' };
        });
      case 'approval': {
        if (!run.subject_employee_id) throw new StepError('This run is not about an employee, so nobody can be asked to approve', false);
        if (step.approver === 'role') {
          const role = await this.db.tenant((tx) => tx.collection('roles').exists({ key: step.role }));
          if (!role) throw new StepError(`Role "${step.role}" no longer exists`, false);
        }
        return this.db.tenant(async (tx) => {
          const id = await this.approvals.start(tx, {
            resourceType: 'workflow_run', resourceId: run.id, subjectEmployeeId: run.subject_employee_id, summary: automation.render(step.summary, ctx).slice(0, 300),
            steps: step.approver === 'manager' ? [{ type: 'manager' }] : [{ type: 'role', role: step.role! }],
          });
          return { kind: 'wait', detail: `Waiting for approval: ${automation.describeStep(step)}`, wakeAt: null, approvalRequestId: id };
        });
      }
      case 'assign_course': {
        if (!run.subject_employee_id) throw new StepError('This run is not about an employee', false);
        const course = await this.db.tenant((tx) => tx.collection('courses').findOne({ id: step.courseId, archived_at: null }));
        if (!course) throw new StepError('The course no longer exists or is archived', false);
        const dueOn = step.dueInDays ? new Date(Date.now() + step.dueInDays * 86_400_000).toISOString().slice(0, 10) : null;
        try {
          const r = await this.learning.assign({ employeeIds: [run.subject_employee_id], courseId: step.courseId, dueOn });
          return { kind: 'next', status: 'succeeded', detail: r.created ? `Assigned "${course.title}"${dueOn ? `, due ${dueOn}` : ''}` : `"${course.title}" was already assigned` };
        } catch (err) {
          const status = (err as { getStatus?: () => number }).getStatus?.();
          // Permission problems will not fix themselves on retry.
          throw new StepError((err as Error).message, !(status && status >= 400 && status < 500));
        }
      }
      case 'slack': {
        const conn = await this.db.tenant((tx) => tx.collection('integration_connections').findOne({ id: step.connectionId }));
        if (!conn || conn.status === 'disconnected') throw new StepError('The Slack connection no longer exists', false);
        try {
          await this.connections.post(step.connectionId, automation.render(step.text, ctx), 'workflow');
        } catch (err) {
          throw new StepError((err as Error).message, err instanceof ConnectorError ? err.retryable : true);
        }
        return { kind: 'next', status: 'succeeded', detail: `Posted to Slack (${conn.name})` };
      }
      case 'webhook':
        return this.db.tenant(async (tx) => {
          const w = await tx.collection('webhook_endpoints').findOne({ id: step.endpointId });
          if (!w) throw new StepError('The webhook endpoint no longer exists', false);
          if (w.status !== 'active') throw new StepError(`The webhook endpoint "${w.name}" is ${w.status}`, true);
          // One delivery per run and step, however often the step is retried.
          const eventId = md5Uuid(`${run.id}:${step.id}`);
          const body = webhookBody({
            id: eventId, type: 'workflow.webhook', occurredAt: new Date().toISOString(), tenantId: run.tenant_id,
            payload: { workflowId: wf.id, workflowName: wf.name, runId: run.id, message: automation.render(step.message, ctx), values: ctx },
          });
          const queued = await this.webhooks.enqueue(tx, step.endpointId, eventId, 'workflow.webhook', body);
          return { kind: 'next', status: 'succeeded', detail: queued ? `Queued for the webhook endpoint "${w.name}"` : `Already queued for "${w.name}"` };
        });
    }
  }

  private async recipients(tx: Tx, step: Extract<WorkflowStep, { type: 'notify' }>, employeeId: string | null): Promise<string[]> {
    switch (step.to) {
      case 'employee':
      case 'manager': {
        if (!employeeId) return [];
        const e = await talentEmployee(tx, employeeId);
        return [step.to === 'employee' ? e.membership_id : e.manager_membership_id].filter((x): x is string => !!x);
      }
      case 'role':
        return activeHolders(tx, step.role!);
      case 'member':
        return step.membershipId ? [step.membershipId] : [];
    }
  }
}
