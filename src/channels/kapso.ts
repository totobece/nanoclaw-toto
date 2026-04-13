import crypto from 'crypto';

import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
} from '../types.js';
import { registerWebhookHandler } from '../webhook-registry.js';
import { ChannelOpts, registerChannel } from './registry.js';

const envConfig = readEnvFile([
  'KAPSO_API_KEY',
  'KAPSO_PHONE_NUMBER_ID',
  'KAPSO_WEBHOOK_SECRET',
]);

const KAPSO_API_KEY =
  process.env.KAPSO_API_KEY || envConfig.KAPSO_API_KEY || '';
const KAPSO_PHONE_NUMBER_ID =
  process.env.KAPSO_PHONE_NUMBER_ID || envConfig.KAPSO_PHONE_NUMBER_ID || '';
const KAPSO_WEBHOOK_SECRET =
  process.env.KAPSO_WEBHOOK_SECRET || envConfig.KAPSO_WEBHOOK_SECRET || '';

let instance: KapsoChannel | null = null;

export class KapsoChannel implements Channel {
  name = 'kapso';
  private client!: WhatsAppClient;
  private connected = false;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    instance = this;
  }

  async connect(): Promise<void> {
    this.client = new WhatsAppClient({
      baseUrl: 'https://api.kapso.ai/meta/whatsapp',
      kapsoApiKey: KAPSO_API_KEY,
    });
    this.connected = true;
    logger.info(
      { phoneNumberId: KAPSO_PHONE_NUMBER_ID },
      'Kapso WhatsApp channel connected',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const phone = jid.replace(/^kapso:/, '');

    // WhatsApp has a 4096-char limit per message; split if needed
    const MAX_LEN = 4096;
    const chunks =
      text.length <= MAX_LEN
        ? [text]
        : text.match(new RegExp(`.{1,${MAX_LEN}}`, 'gs')) || [text];

    for (const chunk of chunks) {
      await this.client.messages.sendText({
        phoneNumberId: KAPSO_PHONE_NUMBER_ID,
        to: phone,
        body: chunk,
      });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('kapso:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    instance = null;
  }

  /**
   * Handle an incoming Kapso webhook payload.
   * Called by the generic webhook route in api.ts via the webhook registry.
   */
  handleWebhook(rawBody: string, headers: Record<string, string>): void {
    // Verify signature when secret is configured
    const signature = headers['x-webhook-signature'] || '';
    if (
      KAPSO_WEBHOOK_SECRET &&
      !verifySignature(rawBody, signature, KAPSO_WEBHOOK_SECRET)
    ) {
      logger.warn('Kapso webhook: invalid signature, rejecting');
      throw Object.assign(new Error('Invalid signature'), { statusCode: 401 });
    }

    const payload = JSON.parse(rawBody);
    const event = headers['x-webhook-event'] || '';

    // Only process inbound messages
    if (event !== 'whatsapp.message.received') {
      logger.debug({ event }, 'Kapso webhook: ignoring event');
      return;
    }

    // Handle batched payloads
    const isBatch = headers['x-webhook-batch'] === 'true';
    const items: unknown[] = isBatch ? payload.data || [] : [payload];

    for (const item of items) {
      try {
        this.processMessage(item);
      } catch (err) {
        logger.error({ err, item }, 'Kapso webhook: failed to process message');
      }
    }
  }

  private processMessage(payload: unknown): void {
    const p = payload as Record<string, any>;
    const message = p.message;
    if (!message) return;

    // Skip outbound messages (our own replies)
    if (message.kapso?.direction === 'outbound') return;

    const senderPhone = message.from;
    if (!senderPhone) return;

    const jid = `kapso:${senderPhone}`;
    const senderName =
      p.contact?.profile?.name || p.contacts?.[0]?.profile?.name || senderPhone;

    // Use kapso enriched content (works for all message types: text, audio transcript, etc.)
    let text = message.kapso?.content || '';

    // Fallback to raw text body
    if (!text && message.text?.body) {
      text = message.text.body;
    }

    // Audio transcript
    if (!text && message.kapso?.transcript) {
      text = `[voice] ${message.kapso.transcript}`;
    }

    if (!text) {
      logger.debug(
        { type: message.type, jid },
        'Kapso: skipping non-text message',
      );
      return;
    }

    // Parse timestamp: Kapso may send Unix seconds or ISO string
    let timestamp: string;
    const ts = message.timestamp;
    if (typeof ts === 'number' || /^\d+$/.test(ts)) {
      timestamp = new Date(parseInt(ts, 10) * 1000).toISOString();
    } else {
      timestamp = ts || new Date().toISOString();
    }

    const msg: NewMessage = {
      id:
        message.id ||
        `kapso-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: jid,
      sender: senderPhone,
      sender_name: senderName,
      content: text,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    };

    logger.info(
      { jid, sender: senderName, type: message.type },
      'Kapso: inbound message',
    );

    this.onChatMetadata(jid, msg.timestamp, senderName, 'kapso', false);
    this.onMessage(jid, msg);
  }
}

function verifySignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

// Register webhook handler at module load.
// The handler routes to the singleton instance (set when the channel connects).
registerWebhookHandler('kapso', (rawBody, headers) => {
  if (!instance) {
    logger.warn('Kapso webhook received but channel not connected');
    return;
  }
  instance.handleWebhook(rawBody, headers);
});

// Register channel factory
registerChannel('kapso', (opts: ChannelOpts) => {
  if (!KAPSO_API_KEY || !KAPSO_PHONE_NUMBER_ID) {
    return null;
  }
  return new KapsoChannel(opts);
});
