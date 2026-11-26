import type { IntegrationType, TemplateContext } from '@veyra/shared';

export interface EventContext {
  template: TemplateContext;
  /** Structured payload for machine consumers (webhooks). */
  payload: Record<string, unknown>;
  snapshot?: Buffer;
}

export interface RenderedAction {
  destination: string;
  /** What will be sent, without secrets. Stored in delivery history. */
  preview: Record<string, unknown>;
}

export class DeliveryError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
    public responseCode?: number,
  ) {
    super(message);
  }
}

export interface IntegrationProvider<C = unknown, A = unknown> {
  type: IntegrationType;
  validateConfig(config: unknown): C;
  validateAction(config: unknown): A;
  render(connection: C, action: A, context: EventContext): RenderedAction;
  /** Perform the delivery. Throws DeliveryError on failure. Returns the provider response code. */
  send(connection: C, action: A, context: EventContext): Promise<{ responseCode?: number }>;
}
