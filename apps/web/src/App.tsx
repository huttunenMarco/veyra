import { Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/layout/AppLayout';
import { ApiPage } from './pages/ApiPage';
import { AutomationsPage } from './pages/Automations';
import { CameraDetailPage } from './pages/CameraDetail';
import { CameraNewPage } from './pages/CameraNew';
import { CamerasPage } from './pages/Cameras';
import { DashboardPage } from './pages/Dashboard';
import { EventsPage } from './pages/Events';
import { IntegrationsPage } from './pages/Integrations';
import { SensorDetailPage } from './pages/SensorDetail';
import { SensorsPage } from './pages/Sensors';
import { SettingsPage } from './pages/Settings';

export function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/cameras" element={<CamerasPage />} />
        <Route path="/cameras/new" element={<CameraNewPage />} />
        <Route path="/cameras/:cameraId" element={<CameraDetailPage />} />
        <Route path="/sensors" element={<SensorsPage />} />
        <Route path="/sensors/:sensorId" element={<SensorDetailPage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/automations" element={<AutomationsPage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/api" element={<ApiPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
