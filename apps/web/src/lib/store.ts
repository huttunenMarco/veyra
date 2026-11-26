import { useEffect } from 'react';
import { create } from 'zustand';

type Theme = 'light' | 'dark';

function readTheme(): Theme {
  try {
    return localStorage.getItem('veyra-theme') === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

interface UiState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (v: boolean) => void;
  crumbs: Record<string, string>;
  setCrumb: (id: string, label: string) => void;
  lastSeenEventsAt: number;
  markEventsSeen: () => void;
}

export const useUi = create<UiState>((set) => ({
  theme: readTheme(),
  setTheme: (theme) => {
    try {
      localStorage.setItem('veyra-theme', theme);
    } catch {
      /* ignore */
    }
    document.documentElement.classList.toggle('dark', theme === 'dark');
    set({ theme });
  },
  sidebarOpen: false,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  crumbs: {},
  setCrumb: (id, label) => set((s) => (s.crumbs[id] === label ? s : { crumbs: { ...s.crumbs, [id]: label } })),
  lastSeenEventsAt: (() => {
    try {
      return Number(localStorage.getItem('veyra-events-seen') ?? 0);
    } catch {
      return 0;
    }
  })(),
  markEventsSeen: () => {
    const now = Date.now();
    try {
      localStorage.setItem('veyra-events-seen', String(now));
    } catch {
      /* ignore */
    }
    set({ lastSeenEventsAt: now });
  },
}));

/** Register a human-readable breadcrumb label for a dynamic route segment (e.g. a camera id). */
export function useCrumb(id: string | undefined, label: string | undefined) {
  const setCrumb = useUi((s) => s.setCrumb);
  useEffect(() => {
    if (id && label) setCrumb(id, label);
  }, [id, label, setCrumb]);
}
