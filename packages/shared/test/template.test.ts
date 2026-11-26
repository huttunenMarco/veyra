import { describe, expect, it } from 'vitest';
import { jsonStringEscape, renderTemplate, unknownVariables } from '../src/template';

describe('template renderer', () => {
  const ctx = { 'zone.name': 'Lastkaj 2', 'sensor.valueLabel': 'Ledig', 'event.timestamp': '2026-11-17 10:00' };

  it('renders allowlisted variables', () => {
    expect(renderTemplate('{{zone.name}} är nu {{ sensor.valueLabel }}. Tid: {{event.timestamp}}', ctx)).toBe(
      'Lastkaj 2 är nu Ledig. Tid: 2026-11-17 10:00',
    );
  });

  it('drops unknown and non-allowlisted variables', () => {
    expect(renderTemplate('a{{constructor.prototype}}b{{process.env}}c', ctx)).toBe('abc');
    expect(unknownVariables('{{zone.name}} {{secret.value}}')).toEqual(['secret.value']);
  });

  it('can escape for JSON', () => {
    const out = renderTemplate('{"z":"{{zone.name}}"}', { 'zone.name': 'a"b\n' }, jsonStringEscape);
    expect(JSON.parse(out)).toEqual({ z: 'a"b\n' });
  });
});
