import { secretFields, type IntegrationType } from '@veyra/shared';
import { schema } from '../db/client';
import { decryptJson, encryptJson } from '../lib/crypto';
import { badRequest } from '../lib/errors';
import { providers } from '../integrations/providers';
import { DeliveryError } from '../integrations/types';

type Connection = typeof schema.integrationConnections.$inferSelect;

export function connectionConfig(conn: Connection): Record<string, unknown> {
  return decryptJson<Record<string, unknown>>(conn.encryptedConfig);
}

/** Validate a submitted config, keeping stored secrets for fields left empty. */
export function prepareConnectionConfig(
  type: IntegrationType,
  submitted: Record<string, unknown>,
  existing?: Record<string, unknown>,
): string {
  const merged: Record<string, unknown> = { ...(existing ?? {}), ...submitted };
  for (const field of secretFields[type]) {
    const v = submitted[field];
    const empty = v === undefined || v === null || v === '' || (typeof v === 'object' && Object.keys(v as object).length === 0);
    if (empty && existing && existing[field] !== undefined) merged[field] = existing[field];
  }
  try {
    return encryptJson(providers[type].validateConfig(merged));
  } catch (err) {
    throw badRequest(err instanceof DeliveryError ? err.message : 'Ogiltig konfiguration');
  }
}

/** Config without secrets for API responses. */
export function publicConnection(conn: Connection) {
  const cfg = connectionConfig(conn);
  const secrets = secretFields[conn.type];
  const config: Record<string, unknown> = {};
  const secretsSet: string[] = [];
  for (const [k, v] of Object.entries(cfg)) {
    if (secrets.includes(k)) {
      const set = typeof v === 'object' ? Object.keys(v ?? {}).length > 0 : !!v;
      if (set) secretsSet.push(k);
      if (k === 'headers' && v && typeof v === 'object') config.headerNames = Object.keys(v);
    } else {
      config[k] = v;
    }
  }
  const { encryptedConfig: _e, ...rest } = conn;
  return { ...rest, config, secretsSet };
}

export function validateActionConfig(type: IntegrationType, config: unknown) {
  try {
    return providers[type].validateAction(config) as Record<string, unknown>;
  } catch (err) {
    throw badRequest(err instanceof DeliveryError ? err.message : 'Ogiltig åtgärdskonfiguration');
  }
}
