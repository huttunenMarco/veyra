import { ExternalLink, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/feedback';
import { useSensors } from '@/hooks/queries';

function Example({ title, code }: { title: string; code: string }) {
  return (
    <div>
      <div className="mb-1 text-sm font-medium">{title}</div>
      <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">{code}</pre>
    </div>
  );
}

export function ApiPage() {
  const sensors = useSensors();
  const origin = window.location.origin;
  const sensorId = sensors.data?.[0]?.id ?? '<sensor-id>';

  return (
    <>
      <PageHeader
        title="API"
        description="Läs sensorlägen och händelser från andra system, t.ex. Home Assistant, Node-RED eller egna skript."
        actions={
          <Button variant="outline" asChild>
            <a href="/api/docs" target="_blank" rel="noreferrer">
              <ExternalLink /> API-dokumentation
            </a>
          </Button>
        }
      />
      <div className="mb-6 flex gap-3 rounded-xl border border-warning/40 bg-warning-soft/50 p-4 text-sm">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" />
        <div>
          API:t kräver ingen inloggning – alla i ditt nätverk kan nå det. Exponera inte Veyra direkt mot internet. Behöver du nå det utifrån, använd
          VPN (t.ex. Tailscale/WireGuard) eller en omvänd proxy med inloggning.
        </div>
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Läsa</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Example title="Aktuellt läge för en sensor" code={`curl ${origin}/api/v1/sensors/${sensorId}/state`} />
            <Example title="Alla sensorer med läge" code={`curl ${origin}/api/v1/sensors`} />
            <Example title="Senaste statusändringar" code={`curl "${origin}/api/v1/events?type=state_changed&limit=20"`} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Göra saker</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Ändrande anrop kräver headern <code>x-veyra-csrf: 1</code>. Den skyddar mot att andra webbsidor styr Veyra via din webbläsare.
            </p>
            <Example title="Analysera en sensor nu" code={`curl -X POST -H "x-veyra-csrf: 1" \\\n  ${origin}/api/v1/sensors/${sensorId}/analyze`} />
            <Example
              title="Home Assistant (configuration.yaml)"
              code={`sensor:\n  - platform: rest\n    name: Veyra ${sensors.data?.[0]?.name ?? 'sensor'}\n    resource: ${origin}/api/v1/sensors/${sensorId}/state\n    value_template: "{{ value_json.valueLabel }}"\n    scan_interval: 60`}
            />
            <p className="text-xs text-muted-foreground">
              Fullständig specifikation: <a className="text-primary hover:underline" href="/api/v1/openapi.json">/api/v1/openapi.json</a>
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
