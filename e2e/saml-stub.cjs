/**
 * SAML 2.0 TEST STUB. Stands in for a SAML identity provider (Okta, Microsoft Entra ID, ADFS, Google Workspace) in
 * automated tests only. It is not a real identity provider and must never be used for real sign-ins: it signs in
 * whoever was set with POST /__user, without asking for a password.
 *
 * It does what CREW relies on a real provider for: it reads the SP's AuthnRequest from the HTTP-Redirect binding,
 * and answers through the HTTP-POST binding with a Response whose Assertion is signed (RSA-SHA256, exclusive C14N)
 * with a key and self-signed certificate created at start (with openssl), carrying InResponseTo, Audience,
 * Recipient, time limits, the email as NameID and an AuthnContextClassRef.
 *
 *   node e2e/saml-stub.cjs            # listens on 4031 (SAML_STUB_PORT)
 *   require('./saml-stub.cjs').start({ port: 0 })   # from tests
 */
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { inflateRawSync } = require('node:zlib');
const { SignedXml } = require('xml-crypto');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const id = () => `_${randomBytes(16).toString('hex')}`;

/** A throwaway RSA key and self-signed certificate, valid for two days. */
function keyPair() {
  const dir = mkdtempSync(join(tmpdir(), 'crew-saml-stub-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-subj', '/CN=CREW SAML TEST STUB', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function start({ port = 0, host = '127.0.0.1', issuerHost = host } = {}) {
  const { key, cert } = keyPair();
  const other = keyPair(); // for the bad_signature tamper: a valid signature by a key CREW does not trust
  const state = {
    user: { email: 'someone@example.com', name: 'Test Person', authnContext: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport' },
    /** For negative tests: 'bad_signature' | 'wrong_audience' | 'wrong_in_response_to' | 'unsigned' | 'expired' | 'altered' | null */
    tamper: null,
    requests: [],
  };
  let base;

  /** Builds the signed Response for an AuthnRequest. */
  function response(req) {
    const now = new Date();
    const iso = (ms) => new Date(now.getTime() + ms).toISOString();
    const expired = state.tamper === 'expired';
    const inResponseTo = state.tamper === 'wrong_in_response_to' ? id() : req.id;
    const audience = state.tamper === 'wrong_audience' ? 'https://someone-else.example' : req.issuer;
    const assertionId = id();
    const u = state.user;
    const assertion =
      `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${iso(expired ? -3_600_000 : 0)}">` +
      `<saml:Issuer>${esc(entityId)}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${esc(u.email)}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${esc(inResponseTo)}" NotOnOrAfter="${iso(expired ? -1_800_000 : 300_000)}" Recipient="${esc(req.acs)}"/></saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${iso(expired ? -3_600_000 : -60_000)}" NotOnOrAfter="${iso(expired ? -1_800_000 : 300_000)}"><saml:AudienceRestriction><saml:Audience>${esc(audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="${id()}"><saml:AuthnContext><saml:AuthnContextClassRef>${esc(u.authnContext)}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      `<saml:AttributeStatement>` +
      `<saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"><saml:AttributeValue>${esc(u.email)}</saml:AttributeValue></saml:Attribute>` +
      `<saml:Attribute Name="http://schemas.microsoft.com/identity/claims/displayname"><saml:AttributeValue>${esc(u.name)}</saml:AttributeValue></saml:Attribute>` +
      `</saml:AttributeStatement></saml:Assertion>`;
    let signed = assertion;
    if (state.tamper !== 'unsigned') {
      const sig = new SignedXml({
        privateKey: state.tamper === 'bad_signature' ? other.key : key,
        publicCert: state.tamper === 'bad_signature' ? other.cert : cert,
        signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
        canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      });
      sig.addReference({
        xpath: "//*[local-name(.)='Assertion']",
        digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
        transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
      });
      sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
      signed = sig.getSignedXml();
      // Changes the signed content after signing: the digest no longer matches.
      if (state.tamper === 'altered') signed = signed.replace(`>${esc(u.email)}</saml:NameID>`, '>attacker@evil.example</saml:NameID>');
    }
    const xml =
      `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id()}" Version="2.0" IssueInstant="${iso(0)}" Destination="${esc(req.acs)}" InResponseTo="${esc(inResponseTo)}">` +
      `<saml:Issuer>${esc(entityId)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
    return Buffer.from(xml).toString('base64');
  }

  /** Reads an HTTP-Redirect AuthnRequest. */
  function parseRequest(samlRequest) {
    const xml = inflateRawSync(Buffer.from(samlRequest, 'base64')).toString('utf8');
    const attr = (name) => new RegExp(`\\s${name}="([^"]*)"`).exec(xml)?.[1];
    return { xml, id: attr('ID'), acs: attr('AssertionConsumerServiceURL'), issuer: /<(?:saml2?:)?Issuer[^>]*>([^<]+)</.exec(xml)?.[1] };
  }

  const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, base);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (url.pathname === '/__user' && req.method === 'POST') {
        Object.assign(state.user, JSON.parse(body || '{}'));
        return json(res, 200, state.user);
      }
      if (url.pathname === '/__tamper' && req.method === 'POST') {
        state.tamper = JSON.parse(body || '{}').tamper ?? null;
        return json(res, 200, { tamper: state.tamper });
      }
      if (url.pathname === '/__requests') return json(res, 200, { requests: state.requests });
      if (url.pathname === '/sso') {
        const samlRequest = url.searchParams.get('SAMLRequest');
        if (!samlRequest) return json(res, 400, { error: 'SAMLRequest missing' });
        const r = parseRequest(samlRequest);
        state.requests.push({ id: r.id, acs: r.acs, issuer: r.issuer, relayState: url.searchParams.get('RelayState') });
        if (!r.id || !r.acs || !r.issuer) return json(res, 400, { error: 'AuthnRequest without ID, AssertionConsumerServiceURL or Issuer' });
        const relay = url.searchParams.get('RelayState') ?? '';
        // The HTTP-POST binding: a form the browser submits to the service provider straight away.
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
          `<!doctype html><html><body onload="document.forms[0].submit()"><p>SAML TEST STUB: signing you in as ${esc(state.user.email)}</p>` +
            `<form method="post" action="${esc(r.acs)}"><input type="hidden" name="SAMLResponse" value="${response(r)}"><input type="hidden" name="RelayState" value="${esc(relay)}">` +
            `<noscript><button>Continue</button></noscript></form></body></html>`,
        );
      }
      json(res, 404, { error: 'not_found' });
    });
  });
  let entityId;
  return new Promise((resolve) =>
    server.listen(port, host, () => {
      base = `http://${issuerHost}:${server.address().port}`;
      entityId = `${base}/metadata`;
      resolve({ entityId, ssoUrl: `${base}/sso`, base, cert, state, server, close: () => new Promise((r) => server.close(r)) });
    }),
  );
}

/** Pulls SAMLResponse and RelayState out of the stub's auto-post page (for tests that do not use a browser). */
function readPostForm(html) {
  const v = (name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1]?.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  return { action: /action="([^"]+)"/.exec(html)?.[1], samlResponse: v('SAMLResponse'), relayState: v('RelayState') };
}

module.exports = { start, readPostForm };

if (require.main === module) {
  start({ port: Number(process.env.SAML_STUB_PORT ?? 4031), host: '127.0.0.1' }).then((s) => console.log(`SAML TEST STUB listening; entity ${s.entityId}, SSO ${s.ssoUrl}`));
}
