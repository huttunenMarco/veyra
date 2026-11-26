/**
 * Allowlisted template renderer: `{{ camera.name }}` style placeholders.
 * Only known variables resolve; unknown placeholders render as empty strings.
 * No expressions, no prototype access.
 */
export const templateVariables = [
  'camera.name',
  'zone.name',
  'sensor.name',
  'sensor.value',
  'sensor.valueLabel',
  'sensor.previousValue',
  'sensor.previousValueLabel',
  'event.id',
  'event.type',
  'event.timestamp',
  'rule.name',
  'snapshot.url',
] as const;
export type TemplateVariable = (typeof templateVariables)[number];

export type TemplateContext = Partial<Record<TemplateVariable, string>>;

const allowed = new Set<string>(templateVariables);
const PLACEHOLDER = /\{\{\s*([a-zA-Z.]+)\s*\}\}/g;

export function renderTemplate(
  template: string,
  context: TemplateContext,
  escape: (value: string) => string = (v) => v,
): string {
  return template.replace(PLACEHOLDER, (_m, key: string) => {
    if (!allowed.has(key)) return '';
    const value = context[key as TemplateVariable];
    return value === undefined ? '' : escape(value);
  });
}

/** Escape a value for insertion inside a JSON string literal. */
export function jsonStringEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export function unknownVariables(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    if (!allowed.has(m[1]!)) out.push(m[1]!);
  }
  return out;
}
