import { Injectable } from '@nestjs/common';
import { AuthzService } from '../../platform/authz/authz.service';
import { MongoService as DatabaseService, type TenantTx } from '../../platform/database/mongo.service';
import { Errors } from '../../platform/http/errors';
import { HelpdeskService } from '../helpdesk/helpdesk.service';
import { AiGatewayService, type Evidence } from './ai-gateway.service';

const ASSISTANT_PROMPT = 'assistant-v1';
const DRAFT_PROMPT = 'helpdesk-draft-v1';

const STOP = new Set(('a an and are as at be but by can could did do does for from had has have how i if in into is it its me my no not of on or our '
  + 'please should so than that the their them then there these they this to was we were what when where which who why will with would you your about '
  + 'get got any much many also just more most some such only own same very hello hi thanks thank').split(' '));

/** A light English stem ("leaves", "leaving" and "leave" match), close to what full-text search did. */
export function stem(word: string): string {
  return word.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '').replace(/e$/, '');
}

/** The meaningful words of free text, stemmed, for matching help articles. */
export function searchTerms(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem))].slice(0, 20);
}

interface Source { id: string; title: string; body: string }

/**
 * The HR assistant answers employees from the workspace's published help articles only, citing them. When no
 * article matches, it says so without calling a model and points to Ask HR. Reply drafts help HR answer a case;
 * HR edits and sends them, nothing is sent automatically.
 */
@Injectable()
export class AssistantService {
  constructor(
    private readonly db: DatabaseService,
    private readonly gateway: AiGatewayService,
    private readonly authz: AuthzService,
    private readonly helpdesk: HelpdeskService,
  ) {}

  /** Published articles that share words with the text, most matches first (ties: most recently updated). */
  private async sources(tx: TenantTx, text: string, limit = 4): Promise<Source[]> {
    const terms = new Set(searchTerms(text));
    if (!terms.size) return [];
    const articles = await tx.collection('helpdesk_articles').find({ published: true }, { projection: { title: 1, body: 1, updated_at: 1 } });
    return articles
      .map((a) => {
        const words = `${a.title} ${a.body}`.toLowerCase().split(/[^a-z0-9]+/).map(stem);
        return { a, score: words.filter((w) => terms.has(w)).length / Math.log(2 + words.length) };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score || new Date(y.a.updated_at).getTime() - new Date(x.a.updated_at).getTime())
      .slice(0, limit)
      .map(({ a }) => ({ id: a.id as string, title: a.title as string, body: (a.body as string).slice(0, 4000) }));
  }

  private static numbered(sources: Source[]) {
    return sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.body}`).join('\n\n');
  }

  private static citations(text: string, sources: Source[]) {
    const cited = new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    return sources.map((s, i) => ({ number: i + 1, articleId: s.id, title: s.title, cited: cited.has(i + 1) }));
  }

  async ask(question: string) {
    await this.gateway.assertAvailable('assistant');
    const { sources, workspace } = await this.db.tenant(async (tx) => {
      await this.authz.require('helpdesk:use', undefined, tx);
      const w = await tx.collection<{ name: string }>('tenants').findOne({ id: tx.tenantId });
      return { sources: await this.sources(tx, question), workspace: w!.name };
    });
    if (!sources.length) {
      const answer = "I couldn't find this in your workspace's help articles, so I can't answer it reliably. You can ask HR directly and they will reply.";
      const interactionId = await this.gateway.recordWithoutModel({ feature: 'assistant', promptVersion: ASSISTANT_PROMPT, question, response: answer });
      return { interactionId, answered: false, answer, sources: [], model: null };
    }
    const system = [
      `You are the HR assistant for ${workspace}, answering an employee's question inside SampCrew, their HR system.`,
      'Answer only from the numbered help articles below. Cite the articles you use like [1] or [2].',
      'If the articles do not answer the question, say that you could not find it and suggest asking HR. Do not guess or use outside knowledge about laws or policies.',
      'You cannot see the employee\'s records and cannot make or promise decisions about their pay, leave or employment; say HR can help with anything specific to them.',
      'Write plainly in at most 150 words. No headings.',
      '',
      'Help articles:',
      AssistantService.numbered(sources),
    ].join('\n');
    const r = await this.gateway.complete({
      feature: 'assistant', promptVersion: ASSISTANT_PROMPT, system, user: question, maxTokens: 1024,
      evidence: sources.map<Evidence>((s) => ({ kind: 'helpdesk_article', id: s.id, title: s.title })),
    });
    return { interactionId: r.interactionId, answered: true, answer: r.text, sources: AssistantService.citations(r.text, sources), model: r.model };
  }

  async draftReply(caseId: string) {
    const ctx = await this.helpdesk.draftContext(caseId);
    if (ctx.confidential) throw Errors.conflict('confidential_case', 'AI drafts are not available for confidential cases.');
    const sources = await this.db.tenant((tx) => this.sources(tx, `${ctx.subject} ${ctx.description} ${ctx.messages.filter((m) => !m.fromHr).map((m) => m.body).join(' ')}`, 3));
    const system = [
      'You draft replies for an HR team member answering an employee\'s helpdesk case. The HR person will read, edit and send your draft themselves.',
      'Use the help articles below where they apply and cite them like [1]. Never invent policy, amounts or dates; where the articles do not say, write a short placeholder in square brackets such as [check the employee\'s payslip].',
      'Be warm, clear and brief (under 120 words). Address the employee as "you". Do not sign off with a name.',
      '',
      sources.length ? `Help articles:\n${AssistantService.numbered(sources)}` : 'No help article matched this case.',
    ].join('\n');
    const thread = [`Case ${ctx.ref} in ${ctx.category}`, `Subject: ${ctx.subject}`, `Employee: ${ctx.description}`, ...ctx.messages.map((m) => `${m.fromHr ? 'HR' : 'Employee'}: ${m.body}`)].join('\n');
    const r = await this.gateway.complete({
      feature: 'helpdesk_draft', promptVersion: DRAFT_PROMPT, system, user: `${thread}\n\nDraft HR's next reply.`, maxTokens: 1024,
      subject: { type: 'helpdesk_case', id: caseId },
      evidence: sources.map<Evidence>((s) => ({ kind: 'helpdesk_article', id: s.id, title: s.title })),
    });
    return { interactionId: r.interactionId, draft: r.text, sources: AssistantService.citations(r.text, sources), model: r.model };
  }
}
