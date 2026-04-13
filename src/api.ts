import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';

import {
  getAllRegisteredGroups,
  getAllTasks,
  getAllTenants,
  getTenantById,
  createTenant,
  updateTenant,
  deleteTenant,
  getDashboardUser,
  createDashboardUser,
  getRegisteredGroupsByTenant,
  getTasksByTenant,
  getMessagesSince,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { eventBus, NanoClawEvent } from './event-bus.js';
import { API_PORT } from './config.js';
import { getWebhookHandler } from './webhook-registry.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const JWT_SECRET =
  process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  tenantIds: string[];
  iat: number;
  exp: number;
}

function base64UrlEncode(data: string): string {
  return Buffer.from(data).toString('base64url');
}

function base64UrlDecode(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
  const now = Date.now();
  const fullPayload: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + JWT_EXPIRY_MS,
  };
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(fullPayload));
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyJwt(token: string): JwtPayload | null {
  try {
    const [header, body, signature] = token.split('.');
    const expectedSig = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${header}.${body}`)
      .digest('base64url');
    if (signature !== expectedSig) return null;
    const payload: JwtPayload = JSON.parse(base64UrlDecode(body));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function authenticateRequest(req: http.IncomingMessage): JwtPayload | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  return verifyJwt(authHeader.slice(7));
}

interface ApiDeps {
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getQueueState: () => Map<
    string,
    {
      active: boolean;
      containerName: string | null;
      groupFolder: string | null;
    }
  >;
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS',
  );
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown,
): void {
  setCorsHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(
  res: http.ServerResponse,
  statusCode: number,
  message: string,
): void {
  sendJson(res, statusCode, { error: message });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

export function startApiServer(port: number, deps: ApiDeps): http.Server {
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = parsedUrl.pathname;
    const method = req.method || 'GET';

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Split pathname into segments: ['', 'api', 'health'] etc.
      const segments = pathname.split('/').filter(Boolean);

      // All routes start with /api
      if (segments[0] !== 'api') {
        sendError(res, 404, 'Not found');
        return;
      }

      // POST /api/auth/login
      if (
        segments[1] === 'auth' &&
        segments[2] === 'login' &&
        method === 'POST'
      ) {
        const body = JSON.parse(await readBody(req));
        const { email, password } = body;
        if (!email || !password) {
          sendError(res, 400, 'Email and password required');
          return;
        }
        const user = getDashboardUser(email);
        if (!user || user.password_hash !== hashPassword(password)) {
          sendError(res, 401, 'Invalid credentials');
          return;
        }
        const tenantIds = JSON.parse(user.tenant_ids) as string[];
        const token = signJwt({
          userId: user.id,
          email: user.email,
          role: user.role,
          tenantIds,
        });
        sendJson(res, 200, {
          token,
          user: { id: user.id, email: user.email, role: user.role, tenantIds },
        });
        return;
      }

      // POST /api/auth/register (bootstrap — creates first user)
      if (
        segments[1] === 'auth' &&
        segments[2] === 'register' &&
        method === 'POST'
      ) {
        const body = JSON.parse(await readBody(req));
        const { email, password, role } = body;
        if (!email || !password) {
          sendError(res, 400, 'Email and password required');
          return;
        }
        const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        try {
          createDashboardUser({
            id,
            email,
            password_hash: hashPassword(password),
            role: role || 'admin',
            tenant_ids: ['default'],
          });
          const token = signJwt({
            userId: id,
            email,
            role: role || 'admin',
            tenantIds: ['default'],
          });
          sendJson(res, 201, {
            token,
            user: { id, email, role: role || 'admin', tenantIds: ['default'] },
          });
        } catch (err) {
          sendError(res, 409, 'User already exists');
        }
        return;
      }

      // GET /api/auth/me (requires auth)
      if (segments[1] === 'auth' && segments[2] === 'me' && method === 'GET') {
        const user = authenticateRequest(req);
        if (!user) {
          sendError(res, 401, 'Unauthorized');
          return;
        }
        sendJson(res, 200, user);
        return;
      }

      // GET /api/health
      if (segments[1] === 'health' && method === 'GET') {
        sendJson(res, 200, {
          status: 'ok',
          uptime: process.uptime(),
          version: process.env.npm_package_version || '1.0.0',
        });
        return;
      }

      // GET /api/tenants
      if (
        segments[1] === 'tenants' &&
        segments.length === 2 &&
        method === 'GET'
      ) {
        const tenants = getAllTenants();
        sendJson(res, 200, tenants);
        return;
      }

      // POST /api/tenants
      if (
        segments[1] === 'tenants' &&
        segments.length === 2 &&
        method === 'POST'
      ) {
        const body = JSON.parse(await readBody(req));
        const id =
          body.id ||
          `tenant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const slug =
          body.slug ||
          body.name?.toLowerCase().replace(/[^a-z0-9]/g, '-') ||
          id;
        createTenant({
          id,
          name: body.name || 'New Tenant',
          slug,
          settings: body.settings,
        });
        const tenant = getTenantById(id);
        sendJson(res, 201, tenant);
        return;
      }

      // DELETE /api/tenants/:id
      if (
        segments[1] === 'tenants' &&
        segments.length === 3 &&
        method === 'DELETE'
      ) {
        try {
          deleteTenant(segments[2]);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendError(
            res,
            400,
            err instanceof Error ? err.message : 'Failed to delete tenant',
          );
        }
        return;
      }

      // PUT /api/tenants/:id
      if (
        segments[1] === 'tenants' &&
        segments.length === 3 &&
        method === 'PUT'
      ) {
        const body = JSON.parse(await readBody(req));
        updateTenant(segments[2], body);
        const tenant = getTenantById(segments[2]);
        sendJson(res, 200, tenant);
        return;
      }

      // Routes under /api/tenants/:id/...
      if (segments[1] === 'tenants' && segments.length >= 3) {
        const tenantId = segments[2];

        // GET /api/tenants/:id/agents
        if (
          segments[3] === 'agents' &&
          segments.length === 4 &&
          method === 'GET'
        ) {
          const groups = getRegisteredGroupsByTenant(tenantId);
          const agents = Object.entries(groups).map(([jid, group]) => ({
            jid,
            name: group.name,
            folder: group.folder,
            isMain: group.isMain || false,
            requiresTrigger: group.requiresTrigger,
            addedAt: group.added_at,
          }));
          sendJson(res, 200, agents);
          return;
        }

        // Routes under /api/tenants/:id/agents/:jid/...
        if (segments[3] === 'agents' && segments.length >= 5) {
          // JID may contain colons (e.g. "tg:12345") so rejoin remaining segments for JID
          // The JID is segment 4, and action is segment 5+
          const jid = decodeURIComponent(segments[4]);

          // GET /api/tenants/:id/agents/:jid/messages
          if (
            segments[5] === 'messages' &&
            segments.length === 6 &&
            method === 'GET'
          ) {
            const since = parsedUrl.searchParams.get('since') || '';
            const limit = parseInt(
              parsedUrl.searchParams.get('limit') || '100',
              10,
            );
            const botName = process.env.ASSISTANT_NAME || 'Andy';
            const messages = getMessagesSince(jid, since, botName, limit);
            sendJson(res, 200, messages);
            return;
          }

          // POST /api/tenants/:id/agents/:jid/messages
          if (
            segments[5] === 'messages' &&
            segments.length === 6 &&
            method === 'POST'
          ) {
            const body = JSON.parse(await readBody(req));
            const content = body.content || body.text || '';
            if (!content) {
              sendError(res, 400, 'Message content is required');
              return;
            }

            const msg = {
              id: `dashboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              chat_jid: jid,
              sender: 'dashboard',
              sender_name: 'Dashboard',
              content,
              timestamp: new Date().toISOString(),
              is_from_me: false,
              is_bot_message: false,
            };

            storeMessage(msg);
            storeChatMetadata(jid, msg.timestamp);
            sendJson(res, 201, msg);
            return;
          }

          // GET /api/tenants/:id/agents/:jid/claude-md
          if (
            segments[5] === 'claude-md' &&
            segments.length === 6 &&
            method === 'GET'
          ) {
            const groups = deps.getRegisteredGroups();
            const group = groups[jid];
            if (!group) {
              sendError(res, 404, 'Agent not found');
              return;
            }

            try {
              const groupPath = resolveGroupFolderPath(group.folder);
              const claudeMdPath = path.join(groupPath, 'CLAUDE.md');
              if (!fs.existsSync(claudeMdPath)) {
                sendJson(res, 200, { content: '' });
                return;
              }
              const content = fs.readFileSync(claudeMdPath, 'utf-8');
              sendJson(res, 200, { content });
            } catch (err) {
              sendError(res, 500, 'Failed to read CLAUDE.md');
            }
            return;
          }

          // PUT /api/tenants/:id/agents/:jid/claude-md
          if (
            segments[5] === 'claude-md' &&
            segments.length === 6 &&
            method === 'PUT'
          ) {
            const groups = deps.getRegisteredGroups();
            const group = groups[jid];
            if (!group) {
              sendError(res, 404, 'Agent not found');
              return;
            }

            try {
              const body = JSON.parse(await readBody(req));
              const content = body.content || '';
              const groupPath = resolveGroupFolderPath(group.folder);
              fs.mkdirSync(groupPath, { recursive: true });
              const claudeMdPath = path.join(groupPath, 'CLAUDE.md');
              fs.writeFileSync(claudeMdPath, content, 'utf-8');
              sendJson(res, 200, { success: true });
            } catch (err) {
              sendError(res, 500, 'Failed to write CLAUDE.md');
            }
            return;
          }
        }
      }

      // GET /api/containers
      if (
        segments[1] === 'containers' &&
        segments.length === 2 &&
        method === 'GET'
      ) {
        const queueState = deps.getQueueState();
        const containers: Array<{
          jid: string;
          active: boolean;
          containerName: string | null;
          groupFolder: string | null;
        }> = [];
        for (const [jid, state] of queueState) {
          containers.push({ jid, ...state });
        }
        sendJson(res, 200, containers);
        return;
      }

      // GET /api/tasks
      if (
        segments[1] === 'tasks' &&
        segments.length === 2 &&
        method === 'GET'
      ) {
        const tenantId = parsedUrl.searchParams.get('tenantId');
        const tasks = tenantId ? getTasksByTenant(tenantId) : getAllTasks();
        sendJson(res, 200, tasks);
        return;
      }

      // GET /api/sse/events
      if (
        segments[1] === 'sse' &&
        segments[2] === 'events' &&
        method === 'GET'
      ) {
        setCorsHeaders(res);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const listener = (event: NanoClawEvent) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        };

        eventBus.on('event', listener);

        // Send keepalive comment every 30 seconds
        const keepalive = setInterval(() => {
          res.write(': keepalive\n\n');
        }, 30000);

        req.on('close', () => {
          eventBus.removeListener('event', listener);
          clearInterval(keepalive);
        });

        return;
      }

      // POST /api/webhooks/:name — generic webhook routing
      if (
        segments[1] === 'webhooks' &&
        segments.length === 3 &&
        method === 'POST'
      ) {
        const handler = getWebhookHandler(segments[2]);
        if (!handler) {
          sendError(res, 404, 'Webhook not found');
          return;
        }
        const rawBody = await readBody(req);
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers[key] = value;
        }
        try {
          handler(rawBody, headers);
          sendJson(res, 200, { ok: true });
        } catch (err: any) {
          if (err?.statusCode === 401) {
            sendError(res, 401, 'Unauthorized');
          } else {
            logger.error({ err, webhook: segments[2] }, 'Webhook error');
            sendError(res, 500, 'Webhook processing error');
          }
        }
        return;
      }

      sendError(res, 404, 'Not found');
    } catch (err) {
      logger.error({ err, path: pathname, method }, 'API error');
      sendError(res, 500, 'Internal server error');
    }
  });

  server.listen(port, () => {
    logger.info({ port }, 'API server started');
  });

  return server;
}
