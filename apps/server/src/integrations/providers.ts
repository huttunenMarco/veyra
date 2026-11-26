import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import {
  actionConfigSchemas,
  connectionConfigSchemas,
  jsonStringEscape,
  renderTemplate,
  type ActionConfig,
  type ConnectionConfig,
  type IntegrationType,
} from '@veyra/shared';
import { z } from 'zod';
import { config } from '../config';
import { assertPublicHost, OutboundBlockedError } from '../lib/outbound';
import { DeliveryError, type EventContext, type IntegrationProvider } from './types';
import { hostOf, maskPhone, postJson, send } from './util';

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new DeliveryError(`Ogiltig konfiguration: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, false);
  }
  return r.data;
}

const t = (tpl: string, ctx: EventContext) => renderTemplate(tpl, ctx.template);

const ntfyPriority = { min: 1, low: 2, default: 3, high: 4, urgent: 5 } as const;

/** Link opened when the notification is tapped: the event in Veyra (when it's a real event). */
function eventLink(ctx: EventContext): string | undefined {
  const id = ctx.template['event.id'];
  return id && id !== 'test' ? `${config.PUBLIC_URL.replace(/\/+$/, '')}/events?highlight=${id}` : undefined;
}

const ntfy: IntegrationProvider<ConnectionConfig<'ntfy'>, ActionConfig<'ntfy'>> = {
  type: 'ntfy',
  validateConfig: (c) => parse(connectionConfigSchemas.ntfy, c),
  validateAction: (c) => parse(actionConfigSchemas.ntfy, c),
  render: (conn, action, ctx) => ({
    destination: `${hostOf(conn.serverUrl)}/${conn.topic}`,
    preview: {
      topic: conn.topic,
      title: t(action.title, ctx),
      message: t(action.message, ctx),
      priority: action.priority,
      attachment: action.attachSnapshot && ctx.snapshot ? 'snapshot.jpg' : null,
    },
  }),
  async send(conn, action, ctx) {
    const base = conn.serverUrl.replace(/\/+$/, '');
    const title = t(action.title, ctx);
    const message = t(action.message, ctx);
    const click = eventLink(ctx);
    const headers: Record<string, string> = {};
    if (conn.accessToken) headers.Authorization = `Bearer ${conn.accessToken}`;

    if (action.attachSnapshot && ctx.snapshot) {
      // Upload the image as an attachment. Text goes in query parameters, which (unlike
      // headers) carry UTF-8 safely.
      const q = new URLSearchParams({ message, filename: 'snapshot.jpg', priority: String(ntfyPriority[action.priority]), tags: 'camera' });
      if (title) q.set('title', title);
      if (click) q.set('click', click);
      return send(`${base}/${encodeURIComponent(conn.topic)}?${q}`, {
        method: 'PUT',
        body: ctx.snapshot,
        headers: { ...headers, 'Content-Type': 'image/jpeg' },
      });
    }
    return postJson(
      `${base}/`,
      { topic: conn.topic, title: title || undefined, message, priority: ntfyPriority[action.priority], tags: ['camera'], click },
      headers,
    );
  },
};

const email: IntegrationProvider<ConnectionConfig<'email'>, ActionConfig<'email'>> = {
  type: 'email',
  validateConfig: (c) => parse(connectionConfigSchemas.email, c),
  validateAction: (c) => parse(actionConfigSchemas.email, c),
  render: (conn, action, ctx) => ({
    destination: action.to.join(', '),
    preview: {
      from: conn.from,
      to: action.to,
      subject: t(action.subject, ctx),
      body: t(action.body, ctx),
      attachment: action.attachSnapshot && ctx.snapshot ? 'snapshot.jpg' : null,
    },
  }),
  async send(conn, action, ctx) {
    try {
      await assertPublicHost(conn.host);
    } catch (err) {
      throw new DeliveryError((err as Error).message, !(err instanceof OutboundBlockedError));
    }
    const transport = nodemailer.createTransport({
      host: conn.host,
      port: conn.port,
      secure: conn.secure,
      auth: conn.user ? { user: conn.user, pass: conn.password } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    try {
      const info = await transport.sendMail({
        from: conn.from,
        to: action.to,
        subject: t(action.subject, ctx),
        text: t(action.body, ctx),
        attachments: action.attachSnapshot && ctx.snapshot ? [{ filename: 'snapshot.jpg', content: ctx.snapshot, contentType: 'image/jpeg' }] : [],
      });
      if (info.rejected.length > 0) throw new DeliveryError(`Avvisade mottagare: ${info.rejected.join(', ')}`, false);
      return { responseCode: 250 };
    } catch (err) {
      if (err instanceof DeliveryError) throw err;
      const e = err as { responseCode?: number; code?: string; message: string };
      const permanent = e.code === 'EAUTH' || (e.responseCode !== undefined && e.responseCode >= 500 && e.responseCode < 600);
      throw new DeliveryError(`SMTP: ${e.message}`, !permanent, e.responseCode);
    } finally {
      transport.close();
    }
  },
};

const sms: IntegrationProvider<ConnectionConfig<'sms'>, ActionConfig<'sms'>> = {
  type: 'sms',
  validateConfig: (c) => parse(connectionConfigSchemas.sms, c),
  validateAction: (c) => parse(actionConfigSchemas.sms, c),
  render: (conn, action, ctx) => ({
    destination: action.to.map(maskPhone).join(', '),
    preview: { from: conn.from, to: action.to.map(maskPhone), body: t(action.body, ctx) },
  }),
  async send(conn, action, ctx) {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${conn.accountSid}/Messages.json`;
    const auth = Buffer.from(`${conn.accountSid}:${conn.authToken}`).toString('base64');
    let code: number | undefined;
    for (const to of action.to) {
      const body = new URLSearchParams({ To: to, From: conn.from, Body: t(action.body, ctx) }).toString();
      const res = await send(url, {
        method: 'POST',
        body,
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      code = res.responseCode;
    }
    return { responseCode: code };
  },
};

function webhookBody(action: ActionConfig<'webhook'>, ctx: EventContext): string {
  if (!action.payloadTemplate.trim()) return JSON.stringify(ctx.payload);
  const rendered = renderTemplate(action.payloadTemplate, ctx.template, jsonStringEscape);
  try {
    JSON.parse(rendered);
  } catch {
    throw new DeliveryError('Payload-mallen ger inte giltig JSON', false);
  }
  return rendered;
}

const webhook: IntegrationProvider<ConnectionConfig<'webhook'>, ActionConfig<'webhook'>> = {
  type: 'webhook',
  validateConfig: (c) => parse(connectionConfigSchemas.webhook, c),
  validateAction: (c) => parse(actionConfigSchemas.webhook, c),
  render: (conn, action, ctx) => ({
    destination: hostOf(conn.url),
    preview: { url: hostOf(conn.url), signed: !!conn.signingSecret, body: JSON.parse(webhookBody(action, ctx)) },
  }),
  async send(conn, action, ctx) {
    const body = webhookBody(action, ctx);
    const headers: Record<string, string> = { ...conn.headers };
    if (conn.signingSecret) {
      const ts = Math.floor(Date.now() / 1000).toString();
      headers['X-Veyra-Timestamp'] = ts;
      headers['X-Veyra-Signature'] = `sha256=${createHmac('sha256', conn.signingSecret).update(`${ts}.${body}`).digest('hex')}`;
    }
    return postJson(conn.url, body, headers);
  },
};

function chat(type: 'slack' | 'teams' | 'discord'): IntegrationProvider<{ webhookUrl: string }, { message: string }> {
  const build = (text: string) => {
    if (type === 'slack') return { text };
    if (type === 'discord') return { content: text, allowed_mentions: { parse: [] } };
    // Teams Workflows ("When a Teams webhook request is received") expects an Adaptive Card message.
    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [{ type: 'TextBlock', text, wrap: true }],
          },
        },
      ],
    };
  };
  return {
    type,
    validateConfig: (c) => parse(connectionConfigSchemas[type], c),
    validateAction: (c) => parse(actionConfigSchemas[type], c),
    render: (conn, action, ctx) => ({ destination: hostOf(conn.webhookUrl), preview: { message: t(action.message, ctx) } }),
    send: (conn, action, ctx) => postJson(conn.webhookUrl, build(t(action.message, ctx))),
  };
}

const http: IntegrationProvider<ConnectionConfig<'http'>, ActionConfig<'http'>> = {
  type: 'http',
  validateConfig: (c) => parse(connectionConfigSchemas.http, c),
  validateAction: (c) => parse(actionConfigSchemas.http, c),
  render: (conn, action, ctx) => ({
    destination: `${action.method} ${hostOf(conn.baseUrl)}`,
    preview: {
      method: action.method,
      url: buildHttpUrl(conn.baseUrl, renderTemplate(action.path, ctx.template, encodeURIComponent)),
      body: action.method === 'GET' ? null : t(action.body, ctx),
    },
  }),
  async send(conn, action, ctx) {
    const url = buildHttpUrl(conn.baseUrl, renderTemplate(action.path, ctx.template, encodeURIComponent));
    if (hostOf(url) !== hostOf(conn.baseUrl)) throw new DeliveryError('Sökvägen får inte byta värd', false);
    const body = action.method === 'GET' ? undefined : t(action.body, ctx);
    let contentType = 'text/plain';
    if (body) {
      try {
        JSON.parse(body);
        contentType = 'application/json';
      } catch {
        /* plain text */
      }
    }
    const headers: Record<string, string> = { ...conn.headers };
    if (body) headers['Content-Type'] = contentType;
    if (conn.authHeaderValue) headers[conn.authHeaderName || 'Authorization'] = conn.authHeaderValue;
    return send(url, { method: action.method, body, headers });
  },
};

function buildHttpUrl(base: string, path: string): string {
  if (!path) return base;
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

// Each provider has its own config types; the registry is heterogeneous by design.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const providers: Record<IntegrationType, IntegrationProvider<any, any>> = {
  ntfy,
  email,
  sms,
  webhook,
  slack: chat('slack'),
  teams: chat('teams'),
  discord: chat('discord'),
  http,
};

/**
 * MQTT is designed but deferred: an `mqtt` provider would implement the same
 * IntegrationProvider interface (connection: broker URL + credentials, action: topic + payload template).
 */
