/**
 * Generic webhook handler registry.
 * Channels register handlers at module load; api.ts routes
 * incoming POST /api/webhooks/:name to the matching handler.
 */

export type WebhookHandler = (
  rawBody: string,
  headers: Record<string, string>,
) => void;

const handlers = new Map<string, WebhookHandler>();

export function registerWebhookHandler(
  name: string,
  handler: WebhookHandler,
): void {
  handlers.set(name, handler);
}

export function getWebhookHandler(name: string): WebhookHandler | undefined {
  return handlers.get(name);
}
