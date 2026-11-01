/**
 * TEST STUB, not an AI model. A local stand-in for the Claude Messages API, used only by e2e/ai-flow.cjs in CI
 * and locally, so the AI features can be driven end to end without a real API key or network access. It returns
 * fixed answers chosen by the kind of prompt and records every request it receives (GET /__requests) so the
 * flow can check what CREW sent, for example that personal identifiers were removed.
 *
 *   AI_STUB_PORT=4010 node e2e/ai-stub.cjs
 *   # then start the API with AI_PROVIDER=anthropic ANTHROPIC_API_KEY=<any test value> ANTHROPIC_BASE_URL=http://localhost:4010
 */
const http = require('node:http');
const PORT = Number(process.env.AI_STUB_PORT ?? 4010);
const requests = [];

const WORKFLOW = {
  trigger: { event: 'leave.requested' },
  steps: [
    { id: 'long_leave', type: 'condition', field: 'leave.days', op: 'gte', value: 2 },
    { id: 'manager_ok', type: 'approval', approver: 'manager', summary: 'Extra check: {{employee.name}} asked for {{leave.days}} days of {{leave.type}}' },
    { id: 'tell_employee', type: 'notify', to: 'employee', title: 'Your leave plan was reviewed', body: 'Your manager has seen your plan for {{leave.from}} to {{leave.to}}.', email: false },
  ],
};

function answer(body) {
  const system = typeof body.system === 'string' ? body.system : JSON.stringify(body.system ?? '');
  if (system.includes('CREW workflow definition')) return JSON.stringify(WORKFLOW);
  if (system.includes('You draft replies')) {
    return 'Thanks for asking. Next year\'s holiday calendar is published in CREW once it is approved, usually in December, and you will see it on your Leave page. [check this year\'s publication date]';
  }
  if (system.includes('HR assistant')) {
    return 'Your payslip lists your earnings first, then deductions such as provident fund and professional tax, then reimbursements [1]. Net pay is earnings minus deductions plus reimbursements [1].';
  }
  return 'OK';
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/__requests') return res.end(JSON.stringify(requests));
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'stub: unknown route' } }));
      }
      if (!req.headers['x-api-key'] && !req.headers.authorization) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'stub: no key sent' } }));
      }
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ at: new Date().toISOString(), body });
      const text = answer(body);
      res.end(JSON.stringify({
        id: `msg_stub_${requests.length}`, type: 'message', role: 'assistant', model: body.model ?? 'stub', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text }],
        usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: Math.ceil(text.length / 4) },
      }));
    });
  })
  .listen(PORT, () => console.log(`AI test stub listening on ${PORT}`));
