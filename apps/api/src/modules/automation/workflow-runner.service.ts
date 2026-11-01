import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { automation, TRIGGER_EVENTS, webhookBody, type TriggerEvent, type WorkflowDefinition, type WorkflowStep } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { loadSubject } from '../../platform/authz/authz.service';
import { hasPermission } from '../../platform/authz/policy';
import { APP_CONFIG, type AppConfig } from '../../platform/config/config';
import { requestContext, type TenantActor } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
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
        const r = await one<{ subject_employee_id: string }>(tx, 'select subject_employee_id from workflow_runs where id = $1', [id]);
        return attrsOf(await talentEmployee(tx, r!.subject_employee_id));
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
      const flows = await many<{ id: string; active_version_id: string }>(
        tx, `select id, active_version_id from workflows where status = 'active' and trigger_event = $1 and active_version_id is not null`, [e.type],
      );
      if (!flows.length) return 0;
      const ent = await this.entitlementsFor(tx);
      if (!ent) return 0;
      const ctx = await contextForEvent(tx, e.type as TriggerEvent, e.payload);
      if (!ctx) return 0;
      let started = 0;
      for (const f of flows) {
        const r = await tx.query(
          `insert into workflow_runs (tenant_id, workflow_id, version_id, mode, event_id, subject_employee_id, context, status, wake_at)
           values (app_tenant_id(), $1, $2, 'live', $3, $4, $5, 'running', now()) on conflict (workflow_id, event_id) do nothing`,
          [f.id, f.active_version_id, e.id, ctx.employeeId, JSON.stringify(ctx.context)],
        );
        started += r.rowCount ?? 0;
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
      const due = await this.db.platform((tx) =>
        many<{ id: string; tenant_id: string }>(
          tx,
          `update workflow_runs set wake_at = null, updated_at = now()
            where id in (select id from workflow_runs
                          where mode = 'live' and ((status in ('running', 'waiting') and wake_at <= now())
                             or (status = 'running' and wake_at is null and updated_at < now() - interval '5 minutes'))
                          order by wake_at nulls first limit $1 for update skip locked)
            returning id, tenant_id`,
          [limit],
        ),
      );
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
        const run = await one<RunRow>(tx, 'select * from workflow_runs where id = $1', [runId]);
        if (!run || !['running', 'waiting'].includes(run.status)) return null;
        const wf = (await one<WorkflowRow>(tx, 'select id, name, status, owner_membership_id from workflows where id = $1', [run.workflow_id]))!;
        const v = (await one<{ definition: WorkflowDefinition }>(tx, 'select definition from workflow_versions where id = $1', [run.version_id]))!;
        const owner = await one<{ user_id: string; status: string; label: string }>(
          tx, `select m.user_id, m.status, u.full_name as label from memberships m join users u on u.id = m.user_id where m.id = $1`, [wf.owner_membership_id],
        );
        return { run, wf, def: v.definition, owner };
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
    await tx.query(
      `insert into workflow_step_runs (tenant_id, run_id, step_index, step_id, type, attempt, status, detail) values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)
       on conflict (run_id, step_index, attempt, status) do nothing`,
      [run.id, run.step_index, step.id, step.type, run.attempt + 1, status, o.detail.slice(0, 2000)],
    );
    if (o.kind === 'next') {
      await tx.query(`update workflow_runs set step_index = step_index + 1, attempt = 0, status = 'running', wake_at = null where id = $1`, [run.id]);
      return true;
    }
    if (o.kind === 'stop') {
      await tx.query(`update workflow_runs set status = 'stopped', outcome = $2, finished_at = now(), wake_at = null where id = $1`, [run.id, o.detail.slice(0, 500)]);
      return false;
    }
    await tx.query(`update workflow_runs set status = 'waiting', wake_at = $2, approval_request_id = coalesce($3, approval_request_id) where id = $1`, [run.id, o.wakeAt, o.approvalRequestId ?? null]);
    return false;
  }

  private async finish(tenantId: string, runId: string, status: 'succeeded' | 'cancelled', outcome: string) {
    await this.db.tenant((tx) => tx.query(`update workflow_runs set status = $2, outcome = $3, finished_at = now(), wake_at = null where id = $1 and status in ('running', 'waiting')`, [runId, status, outcome]), { tenantId });
  }

  private async failAndPause(tenantId: string, run: RunRow, wf: WorkflowRow, reason: string) {
    await this.db.tenant(async (tx) => {
      await tx.query(`update workflow_runs set status = 'failed', error = $2, finished_at = now(), wake_at = null where id = $1`, [run.id, reason]);
      await tx.query(`update workflows set status = 'paused', status_reason = $2 where id = $1 and status = 'active'`, [wf.id, reason]);
      await this.audit.record(tx, { tenantId, action: 'workflow.paused_automatically', resourceType: 'workflow', resourceId: wf.id, metadata: { reason } });
    }, { tenantId });
  }

  private async stepFailed(tenantId: string, run: RunRow, step: WorkflowStep, err: StepError) {
    const attempt = run.attempt + 1;
    const final = !err.retryable || attempt >= automation.MAX_STEP_ATTEMPTS;
    await this.db.tenant(async (tx) => {
      await tx.query(
        `insert into workflow_step_runs (tenant_id, run_id, step_index, step_id, type, attempt, status, detail, error) values (app_tenant_id(), $1, $2, $3, $4, $5, 'failed', $6, $7)
         on conflict (run_id, step_index, attempt, status) do nothing`,
        [run.id, run.step_index, step.id, step.type, attempt, final ? 'Gave up' : `Will retry (attempt ${attempt} of ${automation.MAX_STEP_ATTEMPTS})`, err.message.slice(0, 2000)],
      );
      if (final) {
        await tx.query(`update workflow_runs set status = 'failed', attempt = $2, error = $3, finished_at = now(), wake_at = null where id = $1`, [run.id, attempt, err.message.slice(0, 2000)]);
        const wf = (await one<{ owner_membership_id: string; name: string }>(tx, 'select owner_membership_id, name from workflows where id = $1', [run.workflow_id]))!;
        await this.notifications.notify(tx, { membershipIds: [wf.owner_membership_id], kind: 'workflow.failed', title: `Workflow "${wf.name}" failed at step ${run.step_index + 1}`, body: err.message, link: `/automation/runs/${run.id}` });
      } else {
        await tx.query(`update workflow_runs set status = 'running', attempt = $2, error = $3, wake_at = now() + make_interval(secs => $4) where id = $1`, [run.id, attempt, err.message.slice(0, 2000), automation.retryDelayMs(attempt) / 1000]);
      }
    }, { tenantId });
  }

  /** Resumes a run parked on an approval step. Runs inside the approver's decision transaction. */
  private async onDecision(tx: Tx, req: ApprovalRequestRow, approved: boolean) {
    const run = await one<RunRow>(tx, `select * from workflow_runs where id = $1 and status = 'waiting' and approval_request_id = $2`, [req.resource_id, req.id]);
    if (!run) return;
    const v = (await one<{ definition: WorkflowDefinition }>(tx, 'select definition from workflow_versions where id = $1', [run.version_id]))!;
    const step = v.definition.steps[run.step_index]!;
    const who = requestContext.tenantActor().label;
    if (approved) {
      await this.record(tx, run, step, { kind: 'next', status: 'succeeded', detail: `Approved by ${who}` });
      await tx.query(`update workflow_runs set wake_at = now(), approval_request_id = null where id = $1`, [run.id]);
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
        const waited = await this.db.tenant((tx) => one(tx, `select 1 from workflow_step_runs where run_id = $1 and step_index = $2 and status = 'waiting'`, [run.id, run.step_index]));
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
          const role = await this.db.tenant((tx) => one(tx, 'select 1 from roles where key = $1', [step.role]));
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
        const course = await this.db.tenant((tx) => one<{ title: string }>(tx, 'select title from courses where id = $1 and archived_at is null', [step.courseId]));
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
        const conn = await this.db.tenant((tx) => one<{ name: string; status: string }>(tx, 'select name, status from integration_connections where id = $1', [step.connectionId]));
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
          const w = await one<{ name: string; status: string }>(tx, 'select name, status from webhook_endpoints where id = $1', [step.endpointId]);
          if (!w) throw new StepError('The webhook endpoint no longer exists', false);
          if (w.status !== 'active') throw new StepError(`The webhook endpoint "${w.name}" is ${w.status}`, true);
          // One delivery per run and step, however often the step is retried.
          const eventId = (await one<{ id: string }>(tx, 'select md5($1)::uuid as id', [`${run.id}:${step.id}`]))!.id;
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
        return (await many<{ membership_id: string }>(
          tx, `select distinct ra.membership_id from role_assignments ra join roles r on r.id = ra.role_id join memberships m on m.id = ra.membership_id where r.key = $1 and m.status = 'active'`, [step.role],
        )).map((r) => r.membership_id);
      case 'member':
        return step.membershipId ? [step.membershipId] : [];
    }
  }
}
