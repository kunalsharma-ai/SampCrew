/**
 * OpenID Connect TEST STUB. Stands in for an identity provider (Okta, Microsoft Entra ID, Google Workspace) in
 * automated tests only. It is not a real identity provider and must never be used for real sign-ins: it signs in
 * whoever was set with POST /__user, without asking for a password.
 *
 * It does what CREW relies on a real provider for: discovery, an RS256-signed ID token with iss, aud, nonce, email,
 * email_verified and amr, published keys, the authorization code flow with PKCE (S256) and client authentication
 * (client_secret_basic or client_secret_post).
 *
 *   node e2e/oidc-stub.cjs            # listens on 4030 (OIDC_STUB_PORT), issuer http://localhost:4030
 *   require('./oidc-stub.cjs').start({ port: 0, clientId, clientSecret })   # from tests
 */
const http = require('node:http');
const { createHash, generateKeyPairSync, randomBytes, sign } = require('node:crypto');

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

function start({ port = 0, host = '127.0.0.1', issuerHost = host, clientId = 'crew-test-client', clientSecret = 'crew-test-secret' } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomBytes(6).toString('hex');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const state = {
    user: { email: 'someone@example.com', emailVerified: true, name: 'Test Person', amr: ['pwd'] },
    authorizeRequests: [],
    tokenRequests: 0,
    /** For negative tests: 'wrong_nonce' | 'wrong_aud' | 'bad_signature' | null */
    tamper: null,
  };
  let issuer;

  const idToken = (claims) => {
    const header = b64({ alg: 'RS256', typ: 'JWT', kid });
    const payload = b64(claims);
    let sig = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    if (state.tamper === 'bad_signature') sig = sig.slice(0, -4) + (sig.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    return `${header}.${payload}.${sig}`;
  };

  const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, issuer);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(res, 200, {
          issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        });
      }
      if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
      if (url.pathname === '/__user' && req.method === 'POST') {
        Object.assign(state.user, JSON.parse(body || '{}'));
        return json(res, 200, state.user);
      }
      if (url.pathname === '/__tamper' && req.method === 'POST') {
        state.tamper = JSON.parse(body || '{}').tamper ?? null;
        return json(res, 200, { tamper: state.tamper });
      }
      if (url.pathname === '/__requests') return json(res, 200, { authorize: state.authorizeRequests, tokenRequests: state.tokenRequests });
      if (url.pathname === '/authorize') {
        const p = Object.fromEntries(url.searchParams);
        state.authorizeRequests.push(p);
        if (p.client_id !== clientId) return json(res, 400, { error: 'unauthorized_client' });
        if (p.response_type !== 'code' || p.code_challenge_method !== 'S256' || !p.code_challenge || !p.state || !p.nonce) return json(res, 400, { error: 'invalid_request' });
        const code = randomBytes(16).toString('hex');
        codes.set(code, { ...p, user: { ...state.user } });
        const back = new URL(p.redirect_uri);
        back.searchParams.set('code', code);
        back.searchParams.set('state', p.state);
        return res.writeHead(302, { location: back.toString() }).end();
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        state.tokenRequests++;
        const f = Object.fromEntries(new URLSearchParams(body));
        let id = f.client_id;
        let secret = f.client_secret;
        const auth = req.headers.authorization;
        if (auth?.startsWith('Basic ')) [id, secret] = Buffer.from(auth.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
        if (id !== clientId || secret !== clientSecret) return json(res, 401, { error: 'invalid_client' });
        const c = codes.get(f.code);
        codes.delete(f.code);
        if (!c || f.grant_type !== 'authorization_code' || f.redirect_uri !== c.redirect_uri) return json(res, 400, { error: 'invalid_grant' });
        if (createHash('sha256').update(f.code_verifier ?? '').digest('base64url') !== c.code_challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        const now = Math.floor(Date.now() / 1000);
        const claims = {
          iss: issuer, sub: `stub|${c.user.email}`, aud: state.tamper === 'wrong_aud' ? 'someone-else' : clientId, iat: now, exp: now + 300,
          nonce: state.tamper === 'wrong_nonce' ? 'not-the-nonce' : c.nonce, email: c.user.email, email_verified: c.user.emailVerified, name: c.user.name, amr: c.user.amr,
        };
        return json(res, 200, { access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken(claims) });
      }
      json(res, 404, { error: 'not_found' });
    });
  });
  return new Promise((resolve) =>
    server.listen(port, host, () => {
      issuer = `http://${issuerHost}:${server.address().port}`;
      resolve({ issuer, clientId, clientSecret, state, server, close: () => new Promise((r) => server.close(r)) });
    }),
  );
}

module.exports = { start };

if (require.main === module) {
  start({ port: Number(process.env.OIDC_STUB_PORT ?? 4030), host: '127.0.0.1', issuerHost: 'localhost' }).then((s) => console.log(`OIDC TEST STUB listening; issuer ${s.issuer}, client ${s.clientId}`));
}
