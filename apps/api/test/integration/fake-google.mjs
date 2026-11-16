// Поддельный Google (OpenID Connect) для интеграционных тестов: discovery, JWKS, token endpoint с проверкой PKCE.
// Тест сам кладёт в codes «что ответил бы Google» для конкретного кода авторизации.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

export async function startFakeGoogle() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: state.issuer, authorization_endpoint: state.issuer + '/auth', token_endpoint: state.issuer + '/token',
        jwks_uri: state.issuer + '/jwks', response_types_supported: ['code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        const form = new URLSearchParams(body);
        const grant = codes.get(form.get('code'));
        codes.delete(form.get('code'));
        const verifierOk = grant && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === grant.challenge;
        if (!grant || !verifierOk) return json(400, { error: 'invalid_grant' });
        const idToken = await new SignJWT({ email: grant.email, email_verified: grant.emailVerified, nonce: grant.nonce })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(state.issuer).setAudience('fake-client')
          .setSubject(grant.sub).setIssuedAt().setExpirationTime('5m').sign(privateKey);
        json(200, { access_token: 'fake', token_type: 'Bearer', expires_in: 300, id_token: idToken });
      });
      return undefined;
    }
    return json(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const state = { issuer: `http://127.0.0.1:${server.address().port}`, server, codes };
  return state;
}
