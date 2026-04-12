import { useState } from 'react';
import { motion } from 'framer-motion';
import { z } from 'zod';
import { useAuthStore } from '../../store';
import { useNavigate } from 'react-router-dom';

const loginSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Min 8 characters'),
  rememberMe: z.boolean(),
});

const registerSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Min 8 characters'),
  fullName: z.string().min(2, 'Name too short'),
});

interface Props { onClose: () => void; }

export default function AuthModal({ onClose }: Props) {
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ email: '', password: '', fullName: '', rememberMe: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [apiError, setApiError] = useState('');
  const { login, register, loading } = useAuthStore();
  const navigate = useNavigate();

  const set = (k: string, v: string | boolean) =>
    setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    setApiError('');
    setErrors({});
    const schema = tab === 'login' ? loginSchema : registerSchema;
    const result = schema.safeParse(form);
    if (!result.success) {
      const errs: Record<string, string> = {};
      result.error.issues.forEach(i => { errs[i.path[0] as string] = i.message; });
      setErrors(errs);
      return;
    }
    try {
      if (tab === 'login') {
        await login(form.email, form.password, form.rememberMe);
      } else {
        await register(form.email, form.password, form.fullName);
      }
      onClose();
      navigate('/dashboard');
    } catch (e: any) {
      setApiError(e.message || 'Something went wrong');
    }
  };

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-start justify-end"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />

      {/* Panel — slides from right */}
      <motion.div
        className="relative h-full w-full max-w-md glass-strong border-l border-white/10 flex flex-col p-8"
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Close */}
        <button onClick={onClose} className="absolute top-5 right-5 text-zinc-500 hover:text-white text-xl">×</button>

        <h2 className="font-display text-2xl text-white mb-1">Welcome back</h2>
        <p className="text-zinc-500 text-sm mb-6">Your AI job agent awaits.</p>

        {/* Tabs */}
        <div className="flex gap-1 p-1 bg-white/5 rounded-lg mb-6">
          {(['login', 'register'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-1.5 text-sm rounded-md transition-all duration-200 ${
                tab === t ? 'bg-white/10 text-white' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t === 'login' ? 'Sign in' : 'Create account'}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-4 flex-1">
          {tab === 'register' && (
            <Field label="Full name" error={errors.fullName}>
              <input
                className="input"
                placeholder="Jane Smith"
                value={form.fullName}
                onChange={e => set('fullName', e.target.value)}
              />
            </Field>
          )}

          <Field label="Email" error={errors.email}>
            <input
              className="input"
              type="email"
              placeholder="you@example.com"
              value={form.email}
              onChange={e => set('email', e.target.value)}
            />
          </Field>

          <Field label="Password" error={errors.password}>
            <input
              className="input"
              type="password"
              placeholder="••••••••"
              value={form.password}
              onChange={e => set('password', e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}
            />
          </Field>

          {tab === 'login' && (
            <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                className="accent-accent"
                checked={form.rememberMe}
                onChange={e => set('rememberMe', e.target.checked)}
              />
              Remember me for 7 days
            </label>
          )}

          {apiError && (
            <p className="text-red-400 text-sm bg-red-400/10 border border-red-400/20 px-3 py-2 rounded-lg">
              {apiError}
            </p>
          )}

          <button
            className="btn-primary w-full mt-2 flex items-center justify-center gap-2"
            onClick={submit}
            disabled={loading}
          >
            {loading ? (
              <span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
            ) : null}
            {tab === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm text-zinc-400">{label}</label>
      {children}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
