import { useNavigate } from 'react-router-dom';
import { CameraForm } from '@/components/CameraForm';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/feedback';

export function CameraNewPage() {
  const navigate = useNavigate();
  return (
    <div className="max-w-4xl">
      <PageHeader title="Lägg till kamera" description="Anslut en befintlig kamera. RTSP-strömmar exponeras aldrig mot internet." />
      <Card className="p-6">
        <CameraForm
          onSaved={(c) => navigate(`/cameras/${c.id}${c.connectionType === 'rtsp' || c.connectionType === 'http_snapshot' ? '?test=1' : ''}`)}
        />
      </Card>
    </div>
  );
}
