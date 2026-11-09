import { Injectable } from '@nestjs/common';
import { automation, STEP_TYPES, TRIGGER_EVENTS, type WorkflowDefinition, type WorkflowInput, type WorkflowStep, type WorkflowTestInput } from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService, type TenantTx as Tx } from '../../platform/database/mongo.service';
import { memberNames } from '../employees/employee-view';
import { Errors } from '../../platform/http/errors';
import { AiGatewayService } from '../ai/ai-gateway.service';
import { ApprovalsService } from '../approvals/approvals.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
const pick = (rows: Doc[], ...keys: string[]) => rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k]])));
const byText = (k: string) => (a: Doc, b: Doc) => String(a[k]).localeCompare(String(b[k]));

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
      roles: pick((await tx.collection('roles').find({})).sort((a, b) => Number(b.is_system) - Number(a.is_system) || byText('name')(a, b)), 'key', 'name') as { key: string; name: string }[],
      courses: pick((await tx.collection('courses').find({ archived_at: null })).sort(byText('title')), 'id', 'title') as { id: string; title: string }[],
      slackConnections: pick((await tx.collection('integration_connections').find({ provider: 'slack', status: { $ne: 'disconnected' } })).sort(byText('name')), 'id', 'name', 'status'),
      webhookEndpoints: pick((await tx.collection('webhook_endpoints').find({})).sort(byText('name')), 'id', 'name', 'status'),
    }));
  }

  /** Schema and meaning checks, plus that every role, course and person named exists in this workspace. */
  private async check(tx: Tx, definition: unknown): Promise<WorkflowDefinition> {
    const roles = await tx.collection('roles').distinct<string>('key', {});
    const v = automation.validateDefinition(definition, roles);
    if (!v.ok) throw Errors.validation(v.issues.map((i) => ({ path: `definition.${i.path}`, message: i.message })));
    const issues: { path: string; message: string }[] = [];
    for (const [i, s] of v.definition.steps.entries()) {
      if (s.type === 'assign_course' && !(await tx.collection('courses').exists({ id: s.courseId, archived_at: null }))) issues.push({ path: `definition.steps.${i}.courseId`, message: 'Choose a current course' });
      if (s.type === 'slack' && !(await tx.collection('integration_connections').exists({ id: s.connectionId, provider: 'slack', status: { $ne: 'disconnected' } }))) issues.push({ path: `definition.steps.${i}.connectionId`, message: 'Choose a connected Slack channel' });
      if (s.type === 'webhook' && !(await tx.collection('webhook_endpoints').exists({ id: s.endpointId }))) issues.push({ path: `definition.steps.${i}.endpointId`, message: 'Choose a webhook endpoint' });
      if (s.type === 'notify' && s.to === 'member' && !(await tx.collection('memberships').exists({ id: s.membershipId, status: 'active' }))) issues.push({ path: `definition.steps.${i}.membershipId`, message: 'Choose an active member' });
    }
    if (issues.length) throw Errors.validation(issues);
    return v.definition;
  }

  async list() {
    return this.db.tenant(async (tx) => {
      const flows = (await tx.collection('workflows').find({ status: { $ne: 'archived' } })).sort(byText('name'));
      const ids = flows.map((w) => w.id);
      const versions = await tx.collection('workflow_versions').find({ workflow_id: { $in: ids } }, { projection: { workflow_id: 1, version: 1 } });
      const runs = await tx.collection('workflow_runs').find({ workflow_id: { $in: ids }, mode: 'live' }, { projection: { workflow_id: 1, status: 1, created_at: 1 } });
      const owners = await memberNames(tx, flows.map((w) => w.owner_membership_id));
      const monthAgo = Date.now() - 30 * 86_400_000;
      return flows.map((w) => {
        const mine = versions.filter((v) => v.workflow_id === w.id);
        const live = runs.filter((r) => r.workflow_id === w.id);
        return {
          id: w.id, name: w.name, description: w.description, status: w.status, statusReason: w.status_reason ?? null, trigger: w.trigger_event, updatedAt: w.updated_at,
          latestVersion: mine.length ? Math.max(...mine.map((v) => v.version as number)) : null,
          activeVersion: mine.find((v) => v.id === w.active_version_id)?.version ?? null,
          ownerName: owners.get(w.owner_membership_id) ?? null,
          runs30d: live.filter((r) => (r.created_at as Date).getTime() > monthAgo).length,
          failedRuns: live.filter((r) => r.status === 'failed').length,
          openRuns: live.filter((r) => ['running', 'waiting'].includes(r.status)).length,
        };
      });
    });
  }

  async create(input: WorkflowInput) {
    return this.db.tenant(async (tx) => {
      const def = await this.check(tx, input.definition);
      const actor = requestContext.tenantActor();
      const w = (await tx.collection('workflows').insert({ name: input.name, description: input.description, trigger_event: def.trigger.event, owner_membership_id: actor.membershipId })) as { id: string };
      await this.saveVersion(tx, w.id, def, input.aiInteractionId ?? null);
      await this.audit.record(tx, { action: 'workflow.created', resourceType: 'workflow', resourceId: w.id, metadata: { name: input.name, trigger: def.trigger.event } });
      return this.load(tx, w.id);
    });
  }

  private async saveVersion(tx: Tx, workflowId: string, def: WorkflowDefinition, aiInteractionId: string | null) {
    const actor = requestContext.tenantActor();
    if (aiInteractionId && !(await tx.collection('ai_interactions').exists({ id: aiInteractionId, feature: 'workflow_draft', membership_id: actor.membershipId }))) {
      throw Errors.badRequest('unknown_draft', 'That AI draft is not one of yours');
    }
    // Numbered under a lock on the workflow, so two saves at once cannot take the same number.
    await tx.collection('workflows').lock({ id: workflowId });
    const last = await tx.collection('workflow_versions').findOne({ workflow_id: workflowId }, { sort: { version: -1 }, projection: { version: 1 } });
    const v = await tx.collection('workflow_versions').insert({
      workflow_id: workflowId, version: ((last?.version as number | undefined) ?? 0) + 1, definition: JSON.parse(JSON.stringify(def)), created_by_membership_id: actor.membershipId, ai_interaction_id: aiInteractionId,
    });
    return { id: v.id as string, version: v.version as number };
  }

  async update(id: string, input: WorkflowInput) {
    return this.db.tenant(async (tx) => {
      const w = await this.row(tx, id);
      if (w.status === 'archived') throw Errors.conflict('workflow_archived', 'This workflow is archived.');
      const def = await this.check(tx, input.definition);
      if (def.trigger.event !== w.trigger_event && w.status === 'active') {
        throw Errors.conflict('trigger_change_active', 'Pause the workflow before changing what starts it.');
      }
      await tx.collection('workflows').updateOne({ id }, { $set: { name: input.name, description: input.description, trigger_event: def.trigger.event } });
      const v = await this.saveVersion(tx, id, def, input.aiInteractionId ?? null);
      await this.audit.record(tx, { action: 'workflow.version_saved', resourceType: 'workflow', resourceId: id, metadata: { version: v.version } });
      return this.load(tx, id);
    });
  }

  private async row(tx: Tx, id: string) {
    const w = await tx.collection('workflows').findOne({ id });
    if (!w) throw Errors.notFound('Workflow');
    return w as { id: string; name: string; status: string; trigger_event: string; active_version_id: string | null };
  }

  private async load(tx: Tx, id: string) {
    const doc = await tx.collection('workflows').findOne({ id });
    if (!doc) throw Errors.notFound('Workflow');
    const vs = await tx.collection('workflow_versions').find({ workflow_id: id }, { sort: { version: -1 } });
    const names = await memberNames(tx, [doc.owner_membership_id, ...vs.map((v) => v.created_by_membership_id)]);
    const w = {
      id: doc.id, name: doc.name, description: doc.description, status: doc.status, statusReason: doc.status_reason ?? null, trigger: doc.trigger_event,
      activeVersionId: doc.active_version_id ?? null, ownerMembershipId: doc.owner_membership_id, ownerName: names.get(doc.owner_membership_id) ?? null,
      createdAt: doc.created_at, updatedAt: doc.updated_at,
    };
    const versions = vs.map((v) => ({
      id: v.id as string, version: v.version as number, definition: v.definition as WorkflowDefinition, testedAt: (v.tested_at as Date | null) ?? null,
      aiDrafted: v.ai_interaction_id != null, createdAt: v.created_at as Date, byName: names.get(v.created_by_membership_id) ?? null,
    }));
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
      const v = (await tx.collection('workflow_versions').findOne({ workflow_id: id }, { sort: { version: -1 } })) as { id: string; definition: WorkflowDefinition };
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
      const run = (await tx.collection('workflow_runs').insert({
        workflow_id: id, version_id: v.id, mode: 'test', context: ctx, status, step_index: trace.length, outcome: status === 'failed' ? null : outcome.slice(0, 500),
        error: status === 'failed' ? outcome : null, started_by_membership_id: actor.membershipId, finished_at: new Date(),
      })) as { id: string };
      if (trace.length) {
        await tx.collection('workflow_step_runs').insertMany(trace.map((t, i) => ({
          run_id: run.id, step_index: i, step_id: t.step.id, type: t.step.type, status: t.status, detail: t.detail.slice(0, 2000), error: t.error ?? null,
        })));
      }
      if (status !== 'failed') await tx.collection('workflow_versions').updateOne({ id: v.id }, { $set: { tested_at: new Date() } });
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
          const roleIds = await tx.collection('roles').distinct<string>('id', { key: step.role });
          const holders = await tx.collection('role_assignments').distinct<string>('membership_id', { role_id: { $in: roleIds } });
          const n = await tx.collection('memberships').count({ id: { $in: holders }, status: 'active' });
          who = `${n} ${n === 1 ? 'person' : 'people'} with the ${step.role} role`;
        }
        return { status: 'simulated', detail: `Would notify ${who}${step.email ? ' by email too' : ''}: "${automation.render(step.title, ctx)}"` };
      }
      case 'approval':
        return approvals === 'approve'
          ? { status: 'simulated', detail: `Would ask for approval ("${automation.render(step.summary, ctx)}"); the test assumes it is approved` }
          : { status: 'stopped', detail: `Would ask for approval ("${automation.render(step.summary, ctx)}"); the test assumes it is rejected, so the run stops` };
      case 'assign_course': {
        const c = await tx.collection('courses').findOne({ id: step.courseId, archived_at: null });
        if (!c) return { status: 'failed', detail: 'Assign a course', error: 'The course no longer exists or is archived' };
        return { status: 'simulated', detail: `Would assign "${c.title}"${step.dueInDays ? `, due in ${step.dueInDays} days` : ''}` };
      }
      case 'slack': {
        const c = await tx.collection('integration_connections').findOne({ id: step.connectionId, status: { $ne: 'disconnected' } });
        if (!c) return { status: 'failed', detail: 'Post to Slack', error: 'The Slack connection no longer exists' };
        return { status: 'simulated', detail: `Would post to Slack (${c.name}${c.status === 'error' ? ', which last failed' : ''}): "${automation.render(step.text, ctx)}"` };
      }
      case 'webhook': {
        const w = await tx.collection('webhook_endpoints').findOne({ id: step.endpointId });
        if (!w) return { status: 'failed', detail: 'Send to a webhook', error: 'The webhook endpoint no longer exists' };
        return { status: 'simulated', detail: `Would send to "${w.name}"${w.status === 'active' ? '' : ` (now ${w.status})`}: "${automation.render(step.message, ctx)}"` };
      }
    }
  }

  async activate(id: string) {
    return this.db.tenant(async (tx) => {
      const w = await this.row(tx, id);
      if (w.status === 'archived') throw Errors.conflict('workflow_archived', 'This workflow is archived.');
      const v = (await tx.collection('workflow_versions').findOne({ workflow_id: id }, { sort: { version: -1 } }))!;
      if (!v.tested_at) throw Errors.conflict('not_tested', 'Run a test of this version first. A version can only be activated after a test run without errors.');
      // The owner becomes whoever activates it: the workflow acts with their permissions from now on.
      await tx.collection('workflows').updateOne({ id }, { $set: { status: 'active', active_version_id: v.id, owner_membership_id: requestContext.tenantActor().membershipId, status_reason: null } });
      await this.audit.record(tx, { action: 'workflow.activated', resourceType: 'workflow', resourceId: id, metadata: { version: v.version } });
      return this.load(tx, id);
    });
  }

  async setStatus(id: string, status: 'paused' | 'archived') {
    return this.db.tenant(async (tx) => {
      const w = await this.row(tx, id);
      if (w.status === 'archived') throw Errors.conflict('workflow_archived', 'This workflow is archived.');
      if (status === 'paused' && w.status !== 'active') throw Errors.conflict('not_active', 'Only an active workflow can be paused.');
      await tx.collection('workflows').updateOne({ id }, { $set: { status, status_reason: null } });
      // Runs already under way stop at their next step (the runner checks the workflow's status each time).
      await this.audit.record(tx, { action: `workflow.${status}`, resourceType: 'workflow', resourceId: id });
      return this.load(tx, id);
    });
  }

  async runs(q: { workflowId?: string; status?: string; mode?: 'live' | 'test' }) {
    return this.db.tenant(async (tx) => {
      const list = await tx.collection('workflow_runs').find(
        { ...(q.workflowId ? { workflow_id: q.workflowId } : {}), ...(q.status ? { status: q.status } : {}), ...(q.mode ? { mode: q.mode } : {}) },
        { sort: { created_at: -1 }, limit: 200 },
      );
      const flows = new Map((await tx.collection('workflows').find({ id: { $in: [...new Set(list.map((r) => r.workflow_id))] } }, { projection: { name: 1 } })).map((w) => [w.id, w.name]));
      const versions = new Map((await tx.collection('workflow_versions').find({ id: { $in: [...new Set(list.map((r) => r.version_id))] } }, { projection: { version: 1, definition: 1 } })).map((v) => [v.id, v]));
      return list.map((r) => {
        const v = versions.get(r.version_id);
        return {
          id: r.id, workflowId: r.workflow_id, workflowName: flows.get(r.workflow_id) ?? null, version: v?.version ?? null, mode: r.mode, status: r.status, stepIndex: r.step_index,
          stepCount: Array.isArray(v?.definition?.steps) ? v.definition.steps.length : null, outcome: r.outcome ?? null, error: r.error ?? null, createdAt: r.created_at,
          finishedAt: r.finished_at ?? null, wakeAt: r.wake_at ?? null, employeeName: r.context?.['employee.name'] != null ? String(r.context['employee.name']) : null,
        };
      });
    });
  }

  async run(id: string) {
    return this.db.tenant(async (tx) => {
      const doc = await tx.collection('workflow_runs').findOne({ id });
      if (!doc) throw Errors.notFound('Workflow run');
      const w = await tx.collection('workflows').findOne({ id: doc.workflow_id }, { projection: { name: 1 } });
      const v = (await tx.collection('workflow_versions').findOne({ id: doc.version_id }))!;
      const r = {
        id: doc.id, workflowId: doc.workflow_id, workflowName: w?.name ?? null, version: v.version, definition: v.definition as WorkflowDefinition, mode: doc.mode, status: doc.status,
        stepIndex: doc.step_index, attempt: doc.attempt, context: doc.context, outcome: doc.outcome ?? null, error: doc.error ?? null, createdAt: doc.created_at,
        finishedAt: doc.finished_at ?? null, wakeAt: doc.wake_at ?? null, approvalRequestId: doc.approval_request_id ?? null,
      };
      const steps = (await tx.collection('workflow_step_runs').find({ run_id: id }, { sort: { created_at: 1, step_index: 1, attempt: 1 } }))
        .map((x) => ({ index: x.step_index, stepId: x.step_id, type: x.type, attempt: x.attempt, status: x.status, detail: x.detail, error: x.error ?? null, createdAt: x.created_at }));
      const { definition, ...rest } = r;
      return { ...rest, plan: definition.steps.map((s, i) => ({ index: i, id: s.id, type: s.type, summary: automation.describeStep(s) })), steps, canRetry: r.status === 'failed' && r.mode === 'live', canCancel: ['running', 'waiting'].includes(r.status as string) };
    });
  }

  /** Replays a failed run from the step that failed. Steps before it are not repeated. */
  async retry(id: string) {
    await this.db.tenant(async (tx) => {
      const r = await tx.collection('workflow_runs').findOne({ id });
      if (!r) throw Errors.notFound('Workflow run');
      if (r.status !== 'failed' || r.mode !== 'live') throw Errors.conflict('not_failed', 'Only a failed run can be retried.');
      const w = await this.row(tx, r.workflow_id);
      if (w.status !== 'active') throw Errors.conflict('not_active', 'Activate the workflow again before retrying its runs.');
      await tx.collection('workflow_runs').updateOne({ id }, { $set: { status: 'running', attempt: 0, error: null, finished_at: null, wake_at: new Date() } });
      await this.audit.record(tx, { action: 'workflow.run_retried', resourceType: 'workflow_run', resourceId: id });
    });
    return this.run(id);
  }

  async cancel(id: string) {
    await this.db.tenant(async (tx) => {
      const r = await tx.collection('workflow_runs').findOne({ id });
      if (!r) throw Errors.notFound('Workflow run');
      if (!['running', 'waiting'].includes(r.status)) throw Errors.conflict('run_finished', 'This run has already finished.');
      if (r.approval_request_id) await this.approvals.cancel(tx, r.approval_request_id);
      await tx.collection('workflow_runs').updateOne({ id }, { $set: { status: 'cancelled', outcome: 'Cancelled by an administrator', finished_at: new Date(), wake_at: null } });
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
