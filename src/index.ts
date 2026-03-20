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

import { randomUUID } from 'node:crypto';
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

const app = express();
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/static', express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    server: 'gcp-public-datasets-mcp-http',
    version: '1.0.0',
    tools: tools.length,
    transport: 'streamable-http',
    auth: 'bearer-passthrough (base64 GCP credentials)',
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
    },
  });
});

// --- Parse Bearer token ---
function parseCredentials(req: express.Request): { credentials: Record<string, unknown>; projectId: string } | null {
  const auth = req.headers.authorization;
  if (auth) {
    const token = auth.replace(/^Bearer\s+/i, '');
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
  console.log(`  Health check:   ${SERVER_BASE_URL}/health`);
  console.log(`  Tools:          ${tools.length}`);
  console.log(`  Transport:      Streamable HTTP`);
  console.log(`  Auth:           Bearer passthrough (base64 GCP credentials)`);
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log(`  Server creds:   ${process.env.GOOGLE_APPLICATION_CREDENTIALS}`);
  }
});
