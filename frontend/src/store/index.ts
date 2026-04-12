import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, Job, Application } from '../types';
import { api } from '../utils/api';

interface AuthStore {
  user: User | null;
  loading: boolean;
  setUser: (u: User | null) => void;
  login: (email: string, password: string, rememberMe: boolean) => Promise<void>;
  register: (email: string, password: string, fullName: string) => Promise<void>;
  logout: () => Promise<void>;
  fetchProfile: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      user: null,
      loading: false,
      setUser: (user) => set({ user }),

      login: async (email, password, rememberMe) => {
        set({ loading: true });
        try {
          const user = await api.login({ email, password, rememberMe }) as User;
          set({ user, loading: false });
        } catch (e) {
          set({ loading: false });
          throw e;
        }
      },

      register: async (email, password, fullName) => {
        set({ loading: true });
        try {
          const user = await api.register({ email, password, fullName }) as User;
          set({ user: { ...user, skills: [], experience: [], education: [] }, loading: false });
        } catch (e) {
          set({ loading: false });
          throw e;
        }
      },

      logout: async () => {
        await api.logout().catch(() => {});
        set({ user: null });
      },

      fetchProfile: async () => {
        try {
          const user = await api.getProfile() as User;
          set({ user });
        } catch { /* session expired */ }
      },
    }),
    { name: 'auth', partialize: (s) => ({ user: s.user }) }
  )
);

interface JobStore {
  jobs: Job[];
  total: number;
  page: number;
  loading: boolean;
  search: string;
  source: string;
  setSearch: (s: string) => void;
  setSource: (s: string) => void;
  fetchJobs: (page?: number) => Promise<void>;
  applyToJob: (jobId: string) => Promise<void>;
}

export const useJobStore = create<JobStore>((set, get) => ({
  jobs: [],
  total: 0,
  page: 1,
  loading: false,
  search: '',
  source: '',

  setSearch: (search) => set({ search }),
  setSource: (source) => set({ source }),

  fetchJobs: async (page = 1) => {
    set({ loading: true });
    const { search, source } = get();
    const params: Record<string, string | number> = { page, limit: 20 };
    if (search) params.search = search;
    if (source) params.source = source;
    try {
      const data = await api.getJobs(params) as any;
      set({ jobs: data.jobs, total: data.total, page, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  applyToJob: async (jobId) => {
    await api.applyJob(jobId);
  },
}));

interface AppStore {
  theme: 'dark' | 'light';
  toggleTheme: () => void;
  cookieConsent: boolean | null;
  setCookieConsent: (v: boolean) => void;
  applications: Application[];
  fetchApplications: () => Promise<void>;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      theme: 'dark',
      toggleTheme: () =>
        set((s) => {
          const next = s.theme === 'dark' ? 'light' : 'dark';
          document.documentElement.classList.toggle('dark', next === 'dark');
          return { theme: next };
        }),
      cookieConsent: null,
      setCookieConsent: (cookieConsent) => set({ cookieConsent }),
      applications: [],
      fetchApplications: async () => {
        try {
          const apps = await api.getApplications() as Application[];
          set({ applications: apps });
        } catch { /* ignore */ }
      },
    }),
    { name: 'app-prefs', partialize: (s) => ({ theme: s.theme, cookieConsent: s.cookieConsent }) }
  )
);
