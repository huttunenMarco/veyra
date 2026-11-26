import {
  Bell,
  Camera,
  ChevronRight,
  Code2,
  LayoutDashboard,
  Menu,
  Moon,
  Plug,
  Radar,
  ScrollText,
  Settings,
  Sun,
  Home,
  Workflow,
} from 'lucide-react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown';
import { ErrorState } from '@/components/ui/feedback';
import { useEvents, useInstance } from '@/hooks/queries';
import { eventTypeLabels } from '@/lib/labels';
import { useUi } from '@/lib/store';
import { cn, timeAgo } from '@/lib/utils';

const nav = [
  { to: '/dashboard', label: 'Översikt', icon: LayoutDashboard },
  { to: '/cameras', label: 'Kameror', icon: Camera },
  { to: '/sensors', label: 'Sensorer', icon: Radar },
  { to: '/events', label: 'Händelser', icon: ScrollText },
  { to: '/automations', label: 'Automatiseringar', icon: Workflow },
  { to: '/integrations', label: 'Integrationer', icon: Plug },
  { to: '/api', label: 'API', icon: Code2 },
  { to: '/settings', label: 'Inställningar', icon: Settings },
];

const segmentLabels: Record<string, string> = {
  dashboard: 'Översikt',
  cameras: 'Kameror',
  sensors: 'Sensorer',
  events: 'Händelser',
  automations: 'Automatiseringar',
  integrations: 'Integrationer',
  api: 'API',
  settings: 'Inställningar',
  new: 'Ny',
};

function Logo() {
  return (
    <Link to="/dashboard" className="flex items-center gap-2.5 px-2">
      <div className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <svg viewBox="0 0 32 32" className="size-5">
          <circle cx="16" cy="16" r="8" fill="none" stroke="currentColor" strokeWidth="3" />
          <circle cx="16" cy="16" r="3" fill="currentColor" />
        </svg>
      </div>
      <span className="text-[15px] font-semibold tracking-tight">Veyra</span>
    </Link>
  );
}

function Sidebar() {
  const { sidebarOpen, setSidebarOpen } = useUi();
  return (
    <>
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setSidebarOpen(false)} />}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-border bg-sidebar px-3 py-4 transition-transform lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <Logo />
        <nav className="mt-6 flex flex-1 flex-col gap-0.5">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                  isActive && 'bg-card text-foreground shadow-xs ring-1 ring-border',
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <p className="px-2 text-[11px] leading-snug text-muted-foreground">
          Kamerabilder analyseras av en extern AI-leverantör när AI-analys är aktiverad.
        </p>
      </aside>
    </>
  );
}

function Breadcrumbs() {
  const { pathname } = useLocation();
  const crumbs = useUi((s) => s.crumbs);
  const parts = pathname.split('/').filter(Boolean);
  return (
    <nav className="flex min-w-0 items-center gap-1 text-sm">
      {parts.map((p, i) => {
        const href = '/' + parts.slice(0, i + 1).join('/');
        const label = segmentLabels[p] ?? crumbs[p] ?? '…';
        const last = i === parts.length - 1;
        return (
          <span key={href} className="flex min-w-0 items-center gap-1">
            {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
            {last ? (
              <span className="truncate font-medium">{label}</span>
            ) : (
              <Link to={href} className="truncate text-muted-foreground hover:text-foreground">
                {label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function NotificationCenter() {
  const { data } = useEvents({ limit: '8' }, 15_000);
  const { lastSeenEventsAt, markEventsSeen } = useUi();
  const unread = (data?.data ?? []).filter((e) => new Date(e.occurredAt).getTime() > lastSeenEventsAt).length;
  return (
    <DropdownMenu onOpenChange={(o) => !o && markEventsSeen()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notiser">
          <Bell />
          {unread > 0 && (
            <span className="absolute right-1.5 top-1.5 grid min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
              {unread}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-80">
        <DropdownMenuLabel>Senaste händelser</DropdownMenuLabel>
        {(data?.data ?? []).length === 0 && <p className="px-2 py-4 text-center text-sm text-muted-foreground">Inga händelser ännu</p>}
        {(data?.data ?? []).map((e) => (
          <DropdownMenuItem key={e.id} asChild>
            <Link to={`/events?highlight=${e.id}`} className="flex flex-col items-start gap-0.5">
              <span className="text-sm font-medium">
                {e.sensor?.name ?? e.cameraName ?? 'Händelse'}
                {e.currentLabel && e.eventType === 'state_changed' ? ` → ${e.currentLabel}` : ''}
              </span>
              <span className="text-xs text-muted-foreground">
                {eventTypeLabels[e.eventType]} · {timeAgo(e.occurredAt)}
              </span>
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/events" className="justify-center text-primary">
            Visa alla händelser
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppLayout() {
  const instance = useInstance();
  const { theme, setTheme, setSidebarOpen } = useUi();

  if (instance.isError) {
    return (
      <div className="grid min-h-screen place-items-center px-4">
        <ErrorState error={instance.error} onRetry={() => instance.refetch()} />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Sidebar />
      <div className="lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur sm:px-6">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setSidebarOpen(true)} aria-label="Meny">
            <Menu />
          </Button>
          <div className="min-w-0 flex-1">
            <Breadcrumbs />
          </div>
          {instance.data && (
            <Link
              to="/settings"
              className="hidden items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm hover:bg-muted sm:flex"
              title="Installationens namn (ändras under Inställningar)"
            >
              <Home className="size-4 text-muted-foreground" />
              <span className="max-w-40 truncate font-medium">{instance.data.name}</span>
            </Link>
          )}
          <NotificationCenter />
          <Button variant="ghost" size="icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Byt tema">
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </header>
        <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 animate-in">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
