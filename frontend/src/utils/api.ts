const BASE = import.meta.env.VITE_API_URL || '';

/**
 * Typed fetch wrapper with error handling and retry
 */
async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  retries = 2
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    // Retry on 5xx
    if (res.status >= 500 && retries > 0) {
      await new Promise(r => setTimeout(r, 1000));
      return apiFetch(path, options, retries - 1);
    }
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  /** Auth */
  register: (data: { email: string; password: string; fullName: string }) =>
    apiFetch('/api/auth/register', { method: 'POST', body: JSON.stringify(data) }),
  login: (data: { email: string; password: string; rememberMe: boolean }) =>
    apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify(data) }),
  logout: () =>
    apiFetch('/api/auth/logout', { method: 'POST' }),

  /** Jobs */
  getJobs: (params: Record<string, string | number>) => {
    const q = new URLSearchParams(params as Record<string, string>).toString();
    return apiFetch(`/api/jobs?${q}`);
  },
  applyJob: (jobId: string) =>
    apiFetch(`/api/jobs/apply/${jobId}`, { method: 'POST' }),

  /** User */
  getProfile: () =>
    apiFetch('/api/user/profile'),
  updateProfile: (data: Record<string, unknown>) =>
    apiFetch('/api/user/profile', { method: 'PUT', body: JSON.stringify(data) }),
  generateResume: (jobDescription: string) =>
    apiFetch('/api/user/resume/generate', { method: 'POST', body: JSON.stringify({ jobDescription }) }),
  getApplications: () =>
    apiFetch('/api/user/applications'),
};
