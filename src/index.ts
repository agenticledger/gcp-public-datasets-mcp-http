#!/usr/bin/env node
/**
 * GCP Public Blockchain Datasets MCP Server — Streamable HTTP
 *
 * Auth model: Bearer token is a base64-encoded JSON:
 *   { "credentials": { ...service account JSON... }, "projectId": "your-project" }
 *
 * Or, if GOOGLE_APPLICATION_CREDENTIALS and GCP_PROJECT_ID are set as env vars,
 * clients can connect without a Bearer token (uses server-side credentials).
 */

import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema as _zodToJsonSchema } from 'zod-to-json-schema';
import { BlockchainAnalyzerClient } from './api-client.js';
import { tools } from './tools.js';

function zodToJsonSchema(schema: any): any {
  return _zodToJsonSchema(schema);
}

const PORT = parseInt(process.env.PORT || '3100', 10);
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || `http://localhost:${PORT}`;
const SLUG = 'gcp-blockchain';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/static', express.static(path.join(__dirname, 'public')));

// --- OAuth token store (in-memory, ephemeral) ---
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

interface OAuthToken {
  apiKey: string;
  expiresAt: number;
}

const oauthTokens = new Map<string, OAuthToken>();

// Cleanup expired tokens every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of oauthTokens) {
    if (now > data.expiresAt) oauthTokens.delete(token);
  }
}, 10 * 60 * 1000);

// --- OAuth authorization code store (in-memory, ephemeral) ---
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface AuthCode {
  apiKey: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  redirectUri: string;
  expiresAt: number;
}

const authCodes = new Map<string, AuthCode>();

// Cleanup expired auth codes every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of authCodes) {
    if (now > data.expiresAt) authCodes.delete(code);
  }
}, 2 * 60 * 1000);

// PKCE S256 verifier
function verifyPKCE(codeVerifier: string, codeChallenge: string, method: string): boolean {
  if (method === 'S256') {
    const hash = createHash('sha256').update(codeVerifier).digest('base64url');
    return hash === codeChallenge;
  }
  if (method === 'plain') {
    return codeVerifier === codeChallenge;
  }
  return false;
}

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'gcp-public-datasets-mcp-http',
    version: '1.0.0',
    tools: tools.length,
    transport: 'streamable-http',
    auth: 'dual-mode',
    auth_modes: ['bearer-passthrough', 'oauth-authorization-code', 'oauth-client-credentials'],
    hasServerCredentials: !!(process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GCP_PROJECT_ID),
  });
});

// Smart root route
app.get('/', (req, res) => {
  const accept = req.headers.accept || '';
  if (accept.includes('text/html')) {
    res.send(BRANDED_LANDING_HTML);
    return;
  }
  res.json({
    name: 'GCP Public Blockchain Datasets MCP Server',
    provider: 'AgenticLedger',
    version: '1.0.0',
    description: 'Query 17 blockchain datasets on Google BigQuery — Ethereum, Bitcoin, Solana, Polygon, and more. 23 tools for on-chain analytics with built-in cost guards.',
    mcpEndpoint: '/mcp',
    transport: 'streamable-http',
    tools: tools.length,
    auth: {
      type: 'bearer-passthrough',
      description: 'Pass a base64-encoded JSON as Bearer token containing your GCP service account credentials and project ID.',
      header: 'Authorization: Bearer <base64-encoded-json>',
      tokenFormat: '{ "credentials": { ...service account JSON... }, "projectId": "your-project-id" }',
      howToGetKey: 'Create a GCP service account with BigQuery Data Viewer role, download the JSON key, then base64-encode it with your project ID.',
    },
    configTemplate: {
      mcpServers: {
        'gcp-blockchain': {
          url: `${SERVER_BASE_URL}/mcp`,
          headers: { Authorization: 'Bearer <base64-encoded-credentials-json>' },
        },
      },
    },
    links: {
      health: '/health',
      documentation: 'https://financemcps.agenticledger.ai/gcp-public-datasets/',
      oauth_discovery: '/.well-known/oauth-authorization-server',
    },
  });
});

// --- OAuth 2.0 Discovery ---
// Claude-CLI OAuth-trap fix: OAuth Authorization Server metadata de-advertised.
// The spec discovery path /.well-known/oauth-authorization-server now 404s, so Claude CLI
// falls back to Bearer passthrough (Mode-B broker) instead of a self-hosted OAuth dance.
app.get('/_disabled/oauth-authorization-server', (_req, res) => {
  res.json({
    issuer: SERVER_BASE_URL,
    authorization_endpoint: `${SERVER_BASE_URL}/authorize`,
    token_endpoint: `${SERVER_BASE_URL}/oauth/token`,
    revocation_endpoint: `${SERVER_BASE_URL}/oauth/revoke`,
    registration_endpoint: `${SERVER_BASE_URL}/oauth/register`,
    grant_types_supported: ['authorization_code', 'client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    service_documentation: `https://financemcps.agenticledger.ai/${SLUG}/`,
  });
});

// --- OAuth 2.0 Dynamic Client Registration (RFC 7591) ---
app.post('/oauth/register', (req, res) => {
  res.status(201).json({
    client_id: SLUG,
    client_name: req.body?.client_name || 'MCP Client',
    redirect_uris: req.body?.redirect_uris || [],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
});

// --- OAuth 2.0 Authorization Endpoint ---
app.get('/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = req.query;

  if (response_type !== 'code') {
    res.status(400).json({ error: 'unsupported_response_type', error_description: 'Only response_type=code is supported' });
    return;
  }

  res.send(AUTHORIZE_HTML(
    client_id as string || '',
    redirect_uri as string || '',
    code_challenge as string || '',
    code_challenge_method as string || 'S256',
    state as string || '',
    scope as string || '',
  ));
});

app.post('/authorize', (req, res) => {
  const { api_key, client_id, redirect_uri, code_challenge, code_challenge_method, state, scope } = req.body;

  if (!api_key) {
    res.status(400).send('GCP credentials (base64) are required');
    return;
  }

  if (!redirect_uri) {
    res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri is required' });
    return;
  }

  // Generate authorization code
  const code = `authcode_${randomUUID().replace(/-/g, '')}`;

  authCodes.set(code, {
    apiKey: api_key,
    codeChallenge: code_challenge || '',
    codeChallengeMethod: code_challenge_method || 'S256',
    redirectUri: redirect_uri,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });

  // Redirect back to the client with the code
  const url = new URL(redirect_uri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);

  res.redirect(302, url.toString());
});

// --- OAuth 2.0 Token Exchange ---
app.post('/oauth/token', (req, res) => {
  const { grant_type } = req.body;

  // --- Authorization Code Grant (Claude.ai Cowork / PKCE flow) ---
  if (grant_type === 'authorization_code') {
    const { code, code_verifier, redirect_uri } = req.body;

    if (!code) {
      res.status(400).json({ error: 'invalid_request', error_description: 'code is required' });
      return;
    }

    const entry = authCodes.get(code);
    if (!entry) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code not found or expired' });
      return;
    }

    // Delete the code immediately (single use)
    authCodes.delete(code);

    // Check expiry
    if (Date.now() > entry.expiresAt) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });
      return;
    }

    // Verify redirect_uri matches
    if (redirect_uri && redirect_uri !== entry.redirectUri) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      return;
    }

    // Verify PKCE
    if (entry.codeChallenge) {
      if (!code_verifier) {
        res.status(400).json({ error: 'invalid_request', error_description: 'code_verifier is required for PKCE' });
        return;
      }
      if (!verifyPKCE(code_verifier, entry.codeChallenge, entry.codeChallengeMethod)) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
    }

    // Issue token
    const accessToken = `mcp_${randomUUID().replace(/-/g, '')}`;
    const expiresIn = TOKEN_TTL_MS / 1000;

    oauthTokens.set(accessToken, {
      apiKey: entry.apiKey,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    res.json({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: expiresIn,
    });
    return;
  }

  // --- Client Credentials Grant (programmatic / M2M) ---
  if (grant_type === 'client_credentials') {
    const { client_id, client_secret } = req.body;

    if (client_id !== SLUG) {
      res.status(400).json({ error: 'invalid_client', error_description: `client_id must be "${SLUG}"` });
      return;
    }

    if (!client_secret) {
      res.status(400).json({ error: 'invalid_request', error_description: 'client_secret is required (your base64 GCP credentials)' });
      return;
    }

    const accessToken = `mcp_${randomUUID().replace(/-/g, '')}`;
    const expiresIn = TOKEN_TTL_MS / 1000;

    oauthTokens.set(accessToken, {
      apiKey: client_secret,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });

    res.json({
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: expiresIn,
    });
    return;
  }

  res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Supported: authorization_code, client_credentials' });
});

// --- OAuth 2.0 Token Revocation ---
app.post('/oauth/revoke', (req, res) => {
  const { token } = req.body;
  if (token) oauthTokens.delete(token);
  res.status(200).json({ status: 'revoked' });
});

// --- Parse Bearer token (dual-mode: OAuth mcp_ tokens + direct base64) ---
function parseCredentials(req: express.Request): { credentials: Record<string, unknown>; projectId: string } | null {
  const auth = req.headers.authorization;
  if (auth) {
    const token = auth.replace(/^Bearer\s+/i, '');

    // Mode 1: OAuth-issued token (mcp_ prefix)
    if (token.startsWith('mcp_')) {
      const entry = oauthTokens.get(token);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        oauthTokens.delete(token);
        return null;
      }
      // The stored apiKey is the base64 GCP credentials — decode it
      try {
        const decoded = JSON.parse(Buffer.from(entry.apiKey, 'base64').toString('utf8'));
        if (decoded.credentials && decoded.projectId) {
          return { credentials: decoded.credentials, projectId: decoded.projectId };
        }
        if (decoded.project_id && decoded.private_key) {
          return { credentials: decoded, projectId: decoded.project_id };
        }
      } catch {
        // Not valid base64 JSON
      }
      return null;
    }

    // Mode 2: Direct base64-encoded credentials passthrough
    try {
      const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
      if (decoded.credentials && decoded.projectId) {
        return { credentials: decoded.credentials, projectId: decoded.projectId };
      }
      // Maybe the entire token IS the service account JSON
      if (decoded.project_id && decoded.private_key) {
        return { credentials: decoded, projectId: decoded.project_id };
      }
    } catch {
      // Not base64 JSON — ignore
    }
  }

  // Fall back to server-side env vars
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.GCP_PROJECT_ID) {
    return {
      credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS as any, // file path
      projectId: process.env.GCP_PROJECT_ID,
    };
  }

  return null;
}

// --- Per-session state ---
interface SessionState {
  server: Server;
  transport: StreamableHTTPServerTransport;
  client: BlockchainAnalyzerClient;
}

const sessions = new Map<string, SessionState>();

function createMCPServer(client: BlockchainAnalyzerClient): Server {
  const server = new Server(
    { name: 'gcp-public-datasets-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = tools.find((t) => t.name === name);

    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    try {
      const result = await tool.handler(client, args as any);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

// --- MCP endpoint ---
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // New session — parse credentials
  const creds = parseCredentials(req);
  if (!creds) {
    res.status(401).json({
      error: 'Missing credentials. Pass a base64-encoded JSON as Bearer token: { "credentials": {...}, "projectId": "..." }',
      hint: 'Or set GOOGLE_APPLICATION_CREDENTIALS and GCP_PROJECT_ID as server env vars.',
    });
    return;
  }

  // Create per-session BigQuery client
  const client = new BlockchainAnalyzerClient(creds.credentials as any, creds.projectId);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const server = createMCPServer(client);

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) {
      sessions.delete(sid);
      console.log(`[mcp] Session closed: ${sid}`);
    }
  };

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);

  const newSessionId = transport.sessionId;
  if (newSessionId) {
    sessions.set(newSessionId, { server, transport, client });
    console.log(`[mcp] New session: ${newSessionId}`);
  }
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session.' });
    return;
  }
  const { transport } = sessions.get(sessionId)!;
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const { transport, server } = sessions.get(sessionId)!;
  await transport.close();
  await server.close();
  sessions.delete(sessionId);
  res.status(200).json({ status: 'session closed' });
});

// ==================== OAUTH AUTHORIZE CONSENT PAGE ====================
function AUTHORIZE_HTML(clientId: string, redirectUri: string, codeChallenge: string, codeChallengeMethod: string, state: string, scope: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize — GCP Blockchain Datasets MCP</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root{--primary:#2563EB;--primary-dark:#1D4ED8;--primary-light:#DBEAFE;--primary-50:#EFF6FF;--fg:#0F172A;--muted:#64748B;--surface:#F8FAFC;--border:#E2E8F0;--success:#10B981;--success-light:#D1FAE5;--warn:#F59E0B;--warn-light:#FEF3C7;}
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'DM Sans',sans-serif;color:var(--fg);min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--surface);background-image:linear-gradient(135deg,var(--primary-50) 0%,var(--surface) 50%,#F0F9FF 100%);}
    .card{background:#fff;border:1px solid var(--border);border-radius:16px;padding:40px;max-width:480px;width:100%;margin:20px;box-shadow:0 1px 3px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.06);}
    .header{display:flex;align-items:center;gap:14px;margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid var(--border);}
    .header img{height:36px;}
    .header span{font-size:18px;font-weight:700;}
    .consent-msg{font-size:14px;color:var(--muted);margin-bottom:20px;line-height:1.6;}
    .consent-msg strong{color:var(--fg);}
    .scope-badge{display:inline-block;background:var(--primary-50);border:1px solid var(--primary-light);border-radius:8px;padding:4px 10px;font-size:12px;font-weight:600;color:var(--primary-dark);margin-bottom:20px;}
    .key-label{font-size:13px;font-weight:600;margin-bottom:8px;display:block;}
    .key-input{width:100%;padding:12px 16px;border:2px solid var(--border);border-radius:10px;font-family:'JetBrains Mono',monospace;font-size:13px;transition:border-color .2s;margin-bottom:6px;}
    .key-input:focus{outline:none;border-color:var(--primary);}
    .key-hint{font-size:11px;color:var(--muted);margin-bottom:24px;line-height:1.5;}
    .btn-authorize{width:100%;padding:14px;background:var(--primary);color:#fff;border:none;border-radius:10px;font-family:'DM Sans',sans-serif;font-size:15px;font-weight:600;cursor:pointer;transition:background .15s;}
    .btn-authorize:hover{background:var(--primary-dark);}
    .btn-authorize:disabled{background:var(--border);cursor:not-allowed;}
    .trust-row{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);margin-top:16px;}
    .trust-row svg{width:14px;height:14px;color:var(--success);flex-shrink:0;}
    .footer{margin-top:20px;padding-top:16px;border-top:1px solid var(--border);text-align:center;font-size:11px;color:var(--muted);}
  </style>
</head>
<body>
  <div class="card">
    <div class="header"><img src="/static/logo.png" alt="AgenticLedger"><span>GCP Blockchain Datasets MCP</span></div>
    <div class="consent-msg">An application wants to connect to <strong>GCP Blockchain Datasets MCP Server</strong> on your behalf. Enter your GCP credentials to authorize access.</div>
    ${scope ? `<div class="scope-badge">Scope: ${scope}</div>` : ''}
    <form method="POST" action="/authorize">
      <input type="hidden" name="client_id" value="${clientId}">
      <input type="hidden" name="redirect_uri" value="${redirectUri}">
      <input type="hidden" name="code_challenge" value="${codeChallenge}">
      <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
      <input type="hidden" name="state" value="${state}">
      <input type="hidden" name="scope" value="${scope}">
      <label class="key-label">Your GCP Credentials (base64)</label>
      <input type="password" class="key-input" name="api_key" id="apiKey" placeholder="Paste your base64-encoded GCP credentials" required autofocus oninput="document.getElementById('authBtn').disabled=!this.value">
      <div class="key-hint">Your credentials are used to create a temporary access token. They are not stored permanently on this server.</div>
      <button type="submit" class="btn-authorize" id="authBtn" disabled>Authorize</button>
    </form>
    <div class="trust-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>No credentials stored permanently &mdash; tokens expire after 1 hour</div>
    <div class="footer">Powered by AgenticLedger</div>
  </div>
</body>
</html>`;
}

// ==================== BRANDED HTML HELPER PAGE ====================
const BRANDED_LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GCP Blockchain Datasets MCP — AgenticLedger</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root{--primary:#2563EB;--primary-dark:#1D4ED8;--primary-light:#DBEAFE;--primary-50:#EFF6FF;--fg:#0F172A;--muted:#64748B;--surface:#F8FAFC;--border:#E2E8F0;--success:#10B981;--success-light:#D1FAE5;}
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'DM Sans',sans-serif;color:var(--fg);min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--surface);background-image:linear-gradient(135deg,var(--primary-50) 0%,var(--surface) 50%,#F0F9FF 100%);background-size:400% 400%;animation:gradientShift 15s ease infinite;}
    @keyframes gradientShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
    .card{background:#fff;border:1px solid var(--border);border-radius:16px;padding:40px;max-width:560px;width:100%;margin:20px;box-shadow:0 1px 3px rgba(0,0,0,.04),0 8px 24px rgba(0,0,0,.06);}
    .header{display:flex;align-items:center;gap:14px;margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid var(--border);}
    .header img{height:36px;} .header span{font-size:18px;font-weight:700;}
    .status-badge{display:inline-flex;align-items:center;gap:6px;background:var(--success-light);border:1px solid #A7F3D0;border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;color:#065F46;margin-bottom:20px;}
    .status-badge::before{content:'';width:8px;height:8px;border-radius:50%;background:var(--success);animation:pulse 2s infinite;}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    .info-grid{display:grid;gap:12px;margin-bottom:24px;}
    .info-row{display:flex;justify-content:space-between;padding:10px 14px;background:var(--primary-50);border-radius:10px;font-size:13px;}
    .info-row .label{color:var(--muted);font-weight:500;} .info-row .value{font-weight:600;font-family:'JetBrains Mono',monospace;font-size:12px;}
    .section-title{font-size:14px;font-weight:600;margin:24px 0 10px;}
    .key-input{width:100%;padding:12px 16px;border:2px solid var(--border);border-radius:10px;font-family:'JetBrains Mono',monospace;font-size:12px;margin-bottom:8px;min-height:80px;resize:vertical;}
    .key-input:focus{outline:none;border-color:var(--primary);}
    .key-hint{font-size:12px;color:var(--muted);margin-bottom:20px;line-height:1.5;}
    .config-block{position:relative;}
    .config-pre{background:#1E293B;border-radius:12px;padding:20px;overflow-x:auto;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.7;color:#E2E8F0;white-space:pre;margin-bottom:24px;}
    .config-copy{position:absolute;top:12px;right:12px;background:rgba(255,255,255,.1);color:#CBD5E1;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;}
    .config-copy:hover{background:rgba(255,255,255,.2);color:#fff;}
    .footer{padding-top:16px;border-top:1px solid var(--border);text-align:center;font-size:12px;color:var(--muted);margin-top:20px;}
  </style>
</head>
<body>
  <div class="card">
    <div class="header"><img src="/static/logo.png" alt="AgenticLedger"><span>GCP Blockchain Datasets MCP</span></div>
    <div class="status-badge">Server Online</div>
    <div class="info-grid">
      <div class="info-row"><span class="label">Tools</span><span class="value">${tools.length}</span></div>
      <div class="info-row"><span class="label">Transport</span><span class="value">Streamable HTTP</span></div>
      <div class="info-row"><span class="label">Auth</span><span class="value">GCP Service Account (base64)</span></div>
      <div class="info-row"><span class="label">Chains</span><span class="value">17 blockchains</span></div>
    </div>
    <div class="section-title">Paste your GCP service account JSON</div>
    <textarea class="key-input" id="saInput" placeholder='{ "type": "service_account", "project_id": "...", ... }' oninput="updateConfig()"></textarea>
    <div class="key-hint">Your credentials stay in your browser — they are base64-encoded client-side and never sent to this server in plain text.</div>
    <div class="section-title">MCP Configuration</div>
    <div class="config-block">
      <button class="config-copy" onclick="copyConfig()">Copy</button>
      <pre class="config-pre" id="configBlock"></pre>
    </div>
    <div class="footer">Powered by AgenticLedger &middot; <a href="https://financemcps.agenticledger.ai/" target="_blank" style="color:var(--primary);text-decoration:none">Explore Other MCPs</a></div>
  </div>
  <script>
    function updateConfig(){
      var sa=document.getElementById('saInput').value.trim();
      var token='<base64-encoded-service-account-json>';
      if(sa){try{var j=JSON.parse(sa);token=btoa(JSON.stringify({credentials:j,projectId:j.project_id||'your-project-id'}))}catch(e){}}
      var config=JSON.stringify({mcpServers:{"gcp-blockchain":{url:"${SERVER_BASE_URL}/mcp",headers:{Authorization:"Bearer "+token}}}},null,2);
      document.getElementById('configBlock').textContent=config;
    }
    function copyConfig(){
      navigator.clipboard.writeText(document.getElementById('configBlock').textContent).then(function(){
        var b=document.querySelector('.config-copy');b.textContent='Copied!';
        setTimeout(function(){b.textContent='Copy';},2000);
      });
    }
    updateConfig();
  </script>
</body>
</html>`;

app.listen(PORT, () => {
  console.log(`GCP Public Datasets MCP HTTP Server running on port ${PORT}`);
  console.log(`  MCP endpoint:   ${SERVER_BASE_URL}/mcp`);
  console.log(`  OAuth token:    ${SERVER_BASE_URL}/oauth/token`);
  console.log(`  OAuth discovery: ${SERVER_BASE_URL}/.well-known/oauth-authorization-server`);
  console.log(`  Health check:   ${SERVER_BASE_URL}/health`);
  console.log(`  Landing page:   ${SERVER_BASE_URL}/`);
  console.log(`  Tools:          ${tools.length}`);
  console.log(`  Transport:      Streamable HTTP`);
  console.log(`  Auth:           Dual-mode (Bearer passthrough + OAuth Authorization Code + Client Credentials)`);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log(`  Server creds:   ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
  }
});
