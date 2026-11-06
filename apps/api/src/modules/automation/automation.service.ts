import { Injectable } from '@nestjs/common';
import { automation, STEP_TYPES, TRIGGER_EVENTS, type WorkflowDefinition, type WorkflowInput, type WorkflowStep, type WorkflowTestInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { DatabaseService, many, one, type Tx } from '../../platform/database/database.service';
import { Errors } from '../../platform/http/errors';
import { AiGatewayService } from '../ai/ai-gateway.service';
import { ApprovalsService } from '../approvals/approvals.service';

const WHO = (m: string, u: string, e: string) => `coalesce(nullif(trim(coalesce(${e}.preferred_name, ${e}.first_name) || ' ' || ${e}.last_name), ''), ${u}.full_name)`;

/**
 * The Automation Studio: workflows are saved as numbered versions that never change, a version must pass a
 * test run before it can be activated, and every run (live or test) keeps a step-by-step trace.
 */
@Injectable()
export class AutomationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
    private readonly gateway: AiGatewayService,
  ) {}

  /** Everything the editor needs: triggers and their fields, step types, roles and courses. */
  async catalogue() {
    return this.db.tenant(async (tx) => ({
      triggers: TRIGGER_EVENTS.map((key) => ({ key, label: automation.TRIGGERS[key].label, fields: automation.fieldsFor(key) })),
      steps: STEP_TYPES.map((key) => ({ key, label: automation.STEP_LABEL[key] })),
      ops: automation.CONDITION_OPS.map((key) => ({ key, label: automation.OP_LABEL[key] })),
      roles: await many<{ key: string; name: string }>(tx, 'select key, name from roles order by is_system desc, name'),
      courses: await many<{ id: string; title: string }>(tx, 'select id, title from courses where archived_at is null order by title'),
      slackConnections: await many<{ id: string; name: string; status: string }>(tx, `select id, name, status from integration_connections where provider = 'slack' and status <> 'disconnected' order by name`),
      webhookEndpoints: await many<{ id: string; name: string; status: string }>(tx, 'select id, name, status from webhook_endpoints order by name'),
    }));
  }

  /** Schema and meaning checks, plus that every role, course and person named exists in this workspace. */
  private async check(tx: Tx, definition: unknown): Promise<WorkflowDefinition> {
    const roles = (await many<{ key: string }>(tx, 'select key from roles')).map((r) => r.key);
    const v = automation.validateDefinition(definition, roles);
    if (!v.ok) throw Errors.validation(v.issues.map((i) => ({ path: `definition.${i.path}`, message: i.message })));
    const issues: { path: string; message: string }[] = [];
    for (const [i, s] of v.definition.steps.entries()) {
      if (s.type === 'assign_course' && !(await one(tx, 'select 1 from courses where id = $1 and archived_at is null', [s.courseId]))) issues.push({ path: `definition.steps.${i}.courseId`, message: 'Choose a current course' });
      if (s.type === 'slack' && !(await one(tx, `select 1 from integration_connections where id = $1 and provider = 'slack' and status <> 'disconnected'`, [s.connectionId]))) issues.push({ path: `definition.steps.${i}.connectionId`, message: 'Choose a connected Slack channel' });
      if (s.type === 'webhook' && !(await one(tx, 'select 1 from webhook_endpoints where id = $1', [s.endpointId]))) issues.push({ path: `definition.steps.${i}.endpointId`, message: 'Choose a webhook endpoint' });
      if (s.type === 'notify' && s.to === 'member' && !(await one(tx, `select 1 from memberships where id = $1 and status = 'active'`, [s.membershipId]))) issues.push({ path: `definition.steps.${i}.membershipId`, message: 'Choose an active member' });
    }
    if (issues.length) throw Errors.validation(issues);
    return v.definition;
  }

  async list() {
    return this.db.tenant((tx) =>
      many(
        tx,
        `select w.id, w.name, w.description, w.status, w.status_reason as "statusReason", w.trigger_event as "trigger", w.updated_at as "updatedAt",
                (select max(version) from workflow_versions v where v.workflow_id = w.id) as "latestVersion",
                (select version from workflow_versions v where v.id = w.active_version_id) as "activeVersion",
                ${WHO('m', 'u', 'e')} as "ownerName",
                (select count(*) from workflow_runs r where r.workflow_id = w.id and r.mode = 'live' and r.created_at > now() - interval '30 days')::int as "runs30d",
                (select count(*) from workflow_runs r where r.workflow_id = w.id and r.mode = 'live' and r.status = 'failed')::int as "failedRuns",
                (select count(*) from workflow_runs r where r.workflow_id = w.id and r.mode = 'live' and r.status in ('running', 'waiting'))::int as "openRuns"
           from workflows w join memberships m on m.id = w.owner_membership_id join users u on u.id = m.user_id left join employees e on e.id = m.employee_id
          where w.status <> 'archived' order by w.name`,
      ),
    );
  }

  async create(input: WorkflowInput) {
    return this.db.tenant(async (tx) => {
      const def = await this.check(tx, input.definition);
      const actor = requestContext.tenantActor();
      const w = (await one<{ id: string }>(
        tx,
        `insert into workflows (tenant_id, name, description, trigger_event, owner_membership_id) values (app_tenant_id(), $1, $2, $3, $4) returning id`,
        [input.name, input.description, def.trigger.event, actor.membershipId],
      ))!;
      await this.saveVersion(tx, w.id, def, input.aiInteractionId ?? null);
      await this.audit.record(tx, { action: 'workflow.created', resourceType: 'workflow', resourceId: w.id, metadata: { name: input.name, trigger: def.trigger.event } });
      return this.load(tx, w.id);
    });
  }

  private async saveVersion(tx: Tx, workflowId: string, def: WorkflowDefinition, aiInteractionId: string | null) {
    const actor = requestContext.tenantActor();
    if (aiInteractionId && !(await one(tx, `select 1 from ai_interactions where id = $1 and feature = 'workflow_draft' and membership_id = $2`, [aiInteractionId, actor.membershipId]))) {
      throw Errors.badRequest('unknown_draft', 'That AI draft is not one of yours');
    }
    return (await one<{ id: string; version: number }>(
      tx,
      `insert into workflow_versions (tenant_id, workflow_id, version, definition, created_by_membership_id, ai_interaction_id)
       values (app_tenant_id(), $1, coalesce((select max(version) from workflow_versions where workflow_id = $1), 0) + 1, $2, $3, $4) returning id, version`,
      [workflowId, JSON.stringify(def), actor.membershipId, aiInteractionId],
    ))!;
  }

  async update(id: string, input: WorkflowInput) {
    return this.db.tenant(async (tx) => {
      const w = await this.row(tx, id);
      if (w.status === 'archived') throw Errors.conflict('workflow_archived', 'This workflow is archived.');
      const def = await this.check(tx, input.definition);
      if (def.trigger.event !== w.trigger_event && w.status === 'active') {
        throw Errors.conflict('trigger_change_active', 'Pause the workflow before changing what starts it.');
      }
      await tx.query('update workflows set name = $2, description = $3, trigger_event = $4 where id = $1', [id, input.name, input.description, def.trigger.event]);
      const v = await this.saveVersion(tx, id, def, input.aiInteractionId ?? null);
      await this.audit.record(tx, { action: 'workflow.version_saved', resourceType: 'workflow', resourceId: id, metadata: { version: v.version } });
      return this.load(tx, id);
    });
  }

  private async row(tx: Tx, id: string) {
    const w = await one<{ id: string; name: string; status: string; trigger_event: string; active_version_id: string | null }>(tx, 'select * from workflows where id = $1', [id]);
    if (!w) throw Errors.notFound('Workflow');
    return w;
  }

  private async load(tx: Tx, id: string) {
    const w = await one<Record<string, unknown>>(
      tx,
      `select w.id, w.name, w.description, w.status, w.status_reason as "statusReason", w.trigger_event as "trigger", w.active_version_id as "activeVersionId",
              w.owner_membership_id as "ownerMembershipId", ${WHO('m', 'u', 'e')} as "ownerName", w.created_at as "createdAt", w.updated_at as "updatedAt"
         from workflows w join memberships m on m.id = w.owner_membership_id join users u on u.id = m.user_id left join employees e on e.id = m.employee_id where w.id = $1`,
      [id],
    );
    if (!w) throw Errors.notFound('Workflow');
    const versions = await many<{ id: string; version: number; definition: WorkflowDefinition; testedAt: string | null; aiDrafted: boolean; createdAt: string; byName: string }>(
      tx,
      `select v.id, v.version, v.definition, v.tested_at as "testedAt", (v.ai_interaction_id is not null) as "aiDrafted", v.created_at as "createdAt", ${WHO('m', 'u', 'e')} as "byName"
         from workflow_versions v join memberships m on m.id = v.created_by_membership_id join users u on u.id = m.user_id left join employees e on e.id = m.employee_id
        where v.workflow_id = $1 order by v.version desc`,
      [id],
    );
    const latest = versions[0]!;
    return {
      ...w,
      latest: { ...latest, steps: latest.definition.steps.map((s) => ({ ...s, summary: automation.describeStep(s) })) },
      versions: versions.map(({ definition: _d, ...v }) => v),
      canActivate: Boolean(latest.testedAt) && (w.status !== 'active' || w.activeVersionId !== latest.id),
    };
  }

  async get(id: string) {
    return this.db.tenant((tx) => this.load(tx, id));
  }

  /**
   * Runs the latest version against sample values without touching anyone: notifications, approvals and course
   * assignments are described, delays are skipped. A version that runs without errors can be activated.
   */
  async test(id: string, input: WorkflowTestInput) {
    return this.db.tenant(async (tx) => {
      await this.row(tx, id);
      const v = (await one<{ id: string; definition: WorkflowDefinition }>(tx, 'select id, definition from workflow_versions where workflow_id = $1 order by version desc limit 1', [id]))!;
      const def = await this.check(tx, v.definition);
      const fields = automation.fieldsFor(def.trigger.event);
      const ctx: automation.Context = Object.fromEntries(fields.map((f) => [f.key, input.sample[f.key] ?? null]));
      const actor = requestContext.tenantActor();
      const trace: { step: WorkflowStep; status: string; detail: string; error?: string }[] = [];
      let status: 'succeeded' | 'stopped' | 'failed' = 'succeeded';
      let outcome = 'Reached the end';
      for (const step of def.steps) {
        const r = await this.simulate(tx, step, ctx, input.approvals);
        trace.push({ step, ...r });
        if (r.status === 'failed') { status = 'failed'; outcome = r.error ?? 'A step failed'; break; }
        if (r.status === 'stopped') { status = 'stopped'; outcome = r.detail; break; }
      }
      const run = (await one<{ id: string }>(
        tx,
        `insert into workflow_runs (tenant_id, workflow_id, version_id, mode, context, status, step_index, outcome, error, started_by_membership_id, finished_at)
         values (app_tenant_id(), $1, $2, 'test', $3, $4, $5, $6, $7, $8, now()) returning id`,
        [id, v.id, JSON.stringify(ctx), status, trace.length, status === 'failed' ? null : outcome.slice(0, 500), status === 'failed' ? outcome : null, actor.membershipId],
      ))!;
      for (const [i, t] of trace.entries()) {
        await tx.query(
          `insert into workflow_step_runs (tenant_id, run_id, step_index, step_id, type, status, detail, error) values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)`,
          [run.id, i, t.step.id, t.step.type, t.status, t.detail.slice(0, 2000), t.error ?? null],
        );
      }
      if (status !== 'failed') await tx.query('update workflow_versions set tested_at = now() where id = $1', [v.id]);
      return { runId: run.id, status, outcome, passed: status !== 'failed', steps: trace.map((t, i) => ({ index: i, stepId: t.step.id, type: t.step.type, status: t.status, detail: t.detail, error: t.error ?? null })) };
    });
  }

  private async simulate(tx: Tx, step: WorkflowStep, ctx: automation.Context, approvals: 'approve' | 'reject'): Promise<{ status: string; detail: string; error?: string }> {
    switch (step.type) {
      case 'condition': {
        const r = automation.evaluateCondition(step, ctx);
        const detail = `${step.field} is "${r.actual ?? 'empty'}"`;
        return r.met ? { status: 'succeeded', detail: `Met: ${detail}` } : { status: 'stopped', detail: `Stopped: ${detail}, so the condition "${automation.describeStep(step)}" is not met` };
      }
      case 'delay':
        return { status: 'simulated', detail: `${automation.describeStep(step)} (skipped in a test run)` };
      case 'notify': {
        let who = step.to === 'employee' ? 'the employee' : step.to === 'manager' ? "the employee's manager" : 'the chosen person';
        if (step.to === 'role') {
          const n = (await one<{ n: number }>(tx, `select count(distinct ra.membership_id)::int as n from role_assignments ra join roles r on r.id = ra.role_id join memberships m on m.id = ra.membership_id where r.key = $1 and m.status = 'active'`, [step.role]))!.n;
          who = `${n} ${n === 1 ? 'person' : 'people'} with the ${step.role} role`;
        }
        return { status: 'simulated', detail: `Would notify ${who}${step.email ? ' by email too' : ''}: "${automation.render(step.title, ctx)}"` };
      }
      case 'approval':
        return approvals === 'approve'
          ? { status: 'simulated', detail: `Would ask for approval ("${automation.render(step.summary, ctx)}"); the test assumes it is approved` }
          : { status: 'stopped', detail: `Would ask for approval ("${automation.render(step.summary, ctx)}"); the test assumes it is rejected, so the run stops` };
      case 'assign_course': {
        const c = await one<{ title: string }>(tx, 'select title from courses where id = $1 and archived_at is null', [step.courseId]);
        if (!c) return { status: 'failed', detail: 'Assign a course', error: 'The course no longer exists or is archived' };
        return { status: 'simulated', detail: `Would assign "${c.title}"${step.dueInDays ? `, due in ${step.dueInDays} days` : ''}` };
      }
      case 'slack': {
        const c = await one<{ name: string; status: string }>(tx, `select name, status from integration_connections where id = $1 and status <> 'disconnected'`, [step.connectionId]);
        if (!c) return { status: 'failed', detail: 'Post to Slack', error: 'The Slack connection no longer exists' };
        return { status: 'simulated', detail: `Would post to Slack (${c.name}${c.status === 'error' ? ', which last failed' : ''}): "${automation.render(step.text, ctx)}"` };
      }
      case 'webhook': {
        const w = await one<{ name: string; status: string }>(tx, 'select name, status from webhook_endpoints where id = $1', [step.endpointId]);
        if (!w) return { status: 'failed', detail: 'Send to a webhook', error: 'The webhook endpoint no longer exists' };
        return { status: 'simulated', detail: `Would send to "${w.name}"${w.status === 'active' ? '' : ` (now ${w.status})`}: "${automation.render(step.message, ctx)}"` };
      }
    }
  }

  async activate(id: string) {
    return this.db.tenant(async (tx) => {
      const w = await this.row(tx, id);
      if (w.status === 'archived') throw Errors.conflict('workflow_archived', 'This workflow is archived.');
      const v = (await one<{ id: string; version: number; tested_at: string | null }>(tx, 'select id, version, tested_at from workflow_versions where workflow_id = $1 order by version desc limit 1', [id]))!;
      if (!v.tested_at) throw Errors.conflict('not_tested', 'Run a test of this version first. A version can only be activated after a test run without errors.');
      // The owner becomes whoever activates it: the workflow acts with their permissions from now on.
      await tx.query(`update workflows set status = 'active', active_version_id = $2, owner_membership_id = $3, status_reason = null where id = $1`, [id, v.id, requestContext.tenantActor().membershipId]);
      await this.audit.record(tx, { action: 'workflow.activated', resourceType: 'workflow', resourceId: id, metadata: { version: v.version } });
      return this.load(tx, id);
    });
  }

  async setStatus(id: string, status: 'paused' | 'archived') {
    return this.db.tenant(async (tx) => {
      const w = await this.row(tx, id);
      if (w.status === 'archived') throw Errors.conflict('workflow_archived', 'This workflow is archived.');
      if (status === 'paused' && w.status !== 'active') throw Errors.conflict('not_active', 'Only an active workflow can be paused.');
      await tx.query('update workflows set status = $2, status_reason = null where id = $1', [id, status]);
      // Runs already under way stop at their next step (the runner checks the workflow's status each time).
      await this.audit.record(tx, { action: `workflow.${status}`, resourceType: 'workflow', resourceId: id });
      return this.load(tx, id);
    });
  }

  async runs(q: { workflowId?: string; status?: string; mode?: 'live' | 'test' }) {
    return this.db.tenant((tx) =>
      many(
        tx,
        `select r.id, r.workflow_id as "workflowId", w.name as "workflowName", v.version, r.mode, r.status, r.step_index as "stepIndex",
                jsonb_array_length(v.definition->'steps') as "stepCount", r.outcome, r.error, r.created_at as "createdAt", r.finished_at as "finishedAt",
                r.wake_at as "wakeAt", r.context->>'employee.name' as "employeeName"
           from workflow_runs r join workflows w on w.id = r.workflow_id join workflow_versions v on v.id = r.version_id
          where ($1::uuid is null or r.workflow_id = $1) and ($2::text is null or r.status = $2) and ($3::text is null or r.mode = $3)
          order by r.created_at desc limit 200`,
        [q.workflowId ?? null, q.status ?? null, q.mode ?? null],
      ),
    );
  }

  async run(id: string) {
    return this.db.tenant(async (tx) => {
      const r = await one<Record<string, unknown> & { definition: WorkflowDefinition }>(
        tx,
        `select r.id, r.workflow_id as "workflowId", w.name as "workflowName", v.version, v.definition, r.mode, r.status, r.step_index as "stepIndex", r.attempt,
                r.context, r.outcome, r.error, r.created_at as "createdAt", r.finished_at as "finishedAt", r.wake_at as "wakeAt", r.approval_request_id as "approvalRequestId"
           from workflow_runs r join workflows w on w.id = r.workflow_id join workflow_versions v on v.id = r.version_id where r.id = $1`,
        [id],
      );
      if (!r) throw Errors.notFound('Workflow run');
      const steps = await many(
        tx,
        `select step_index as index, step_id as "stepId", type, attempt, status, detail, error, created_at as "createdAt" from workflow_step_runs where run_id = $1 order by created_at, step_index, attempt`,
        [id],
      );
      const { definition, ...rest } = r;
      return { ...rest, plan: definition.steps.map((s, i) => ({ index: i, id: s.id, type: s.type, summary: automation.describeStep(s) })), steps, canRetry: r.status === 'failed' && r.mode === 'live', canCancel: ['running', 'waiting'].includes(r.status as string) };
    });
  }

  /** Replays a failed run from the step that failed. Steps before it are not repeated. */
  async retry(id: string) {
    await this.db.tenant(async (tx) => {
      const r = await one<{ status: string; mode: string; workflow_id: string }>(tx, 'select status, mode, workflow_id from workflow_runs where id = $1', [id]);
      if (!r) throw Errors.notFound('Workflow run');
      if (r.status !== 'failed' || r.mode !== 'live') throw Errors.conflict('not_failed', 'Only a failed run can be retried.');
      const w = await this.row(tx, r.workflow_id);
      if (w.status !== 'active') throw Errors.conflict('not_active', 'Activate the workflow again before retrying its runs.');
      await tx.query(`update workflow_runs set status = 'running', attempt = 0, error = null, finished_at = null, wake_at = now() where id = $1`, [id]);
      await this.audit.record(tx, { action: 'workflow.run_retried', resourceType: 'workflow_run', resourceId: id });
    });
    return this.run(id);
  }

  async cancel(id: string) {
    await this.db.tenant(async (tx) => {
      const r = await one<{ status: string; approval_request_id: string | null }>(tx, 'select status, approval_request_id from workflow_runs where id = $1', [id]);
      if (!r) throw Errors.notFound('Workflow run');
      if (!['running', 'waiting'].includes(r.status)) throw Errors.conflict('run_finished', 'This run has already finished.');
      if (r.approval_request_id) await this.approvals.cancel(tx, r.approval_request_id);
      await tx.query(`update workflow_runs set status = 'cancelled', outcome = 'Cancelled by an administrator', finished_at = now(), wake_at = null where id = $1`, [id]);
      await this.audit.record(tx, { action: 'workflow.run_cancelled', resourceType: 'workflow_run', resourceId: id });
    });
    return this.run(id);
  }

  /**
   * Turns a plain-English description into a workflow definition with AI. Nothing is saved: the result is
   * checked like any other definition and shown in the editor, and it must still pass a test run before use.
   */
  async draft(description: string) {
    const cat = await this.catalogue();
    const system = [
      'You turn a description of an HR automation into a SampCrew workflow definition. Reply with one JSON object only, no prose, no code fences.',
      'Shape: {"trigger":{"event":EVENT},"steps":[STEP,...]}. Step ids are short lower_case words, unique.',
      'Step types:',
      '- {"id","type":"condition","field":FIELD,"op":"eq|neq|gt|gte|lt|lte|contains|in","value":string|number|string[]} continue only if true',
      '- {"id","type":"notify","to":"employee|manager|role","role":ROLE_KEY (when to is role),"title":"text with {{field}} placeholders","body":"optional text","email":boolean}',
      '- {"id","type":"delay","amount":number,"unit":"minutes|hours|days"}',
      '- {"id","type":"approval","approver":"manager|role","role":ROLE_KEY (when approver is role),"summary":"text with {{field}} placeholders"}',
      '- {"id","type":"assign_course","courseId":COURSE_ID,"dueInDays":number}',
      'Use only the events, fields, roles and courses listed here. If the description asks for something these steps cannot do, leave it out.',
      `Events and their fields: ${JSON.stringify(cat.triggers.map((t) => ({ event: t.key, label: t.label, fields: t.fields.map((f) => `${f.key} (${f.type})`) })))}`,
      `Roles: ${JSON.stringify(cat.roles)}`,
      `Courses: ${JSON.stringify(cat.courses)}`,
    ].join('\n');
    const r = await this.gateway.complete({ feature: 'workflow_draft', promptVersion: 'workflow-draft-v1', system, user: description, maxTokens: 2048, evidence: [] });
    let parsed: unknown = null;
    const start = r.text.indexOf('{');
    const end = r.text.lastIndexOf('}');
    try {
      parsed = start >= 0 && end > start ? JSON.parse(r.text.slice(start, end + 1)) : null;
    } catch {
      parsed = null;
    }
    if (!parsed) return { interactionId: r.interactionId, definition: null, issues: [{ path: '', message: 'The AI did not return a workflow. Try describing it differently, or build it step by step.' }] };
    const v = automation.validateDefinition(parsed, cat.roles.map((x) => x.key));
    return { interactionId: r.interactionId, definition: v.ok ? v.definition : parsed, issues: v.ok ? [] : v.issues };
  }
}
