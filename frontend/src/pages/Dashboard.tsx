import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useAuthStore, useAppStore } from '../store';
import { StatCardSkeleton } from '../components/ui/Skeletons';

const STATUS_COLORS: Record<string, string> = {
  pending:     'text-amber-400 bg-amber-400/10 border-amber-400/20',
  applied:     'text-blue-400 bg-blue-400/10 border-blue-400/20',
  interviewing:'text-accent bg-accent/10 border-accent/20',
  rejected:    'text-red-400 bg-red-400/10 border-red-400/20',
  offer:       'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
};

export default function Dashboard() {
  const { user } = useAuthStore();
  const { applications, fetchApplications } = useAppStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!user) { navigate('/'); return; }
    fetchApplications();
  }, [user]);

  if (!user) return null;

  const stats = {
    total: applications.length,
    applied: applications.filter(a => a.status === 'applied').length,
    interviewing: applications.filter(a => a.status === 'interviewing').length,
    offers: applications.filter(a => a.status === 'offer').length,
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      {/* Header */}
      <motion.div
        className="mb-10"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <h1 className="font-display text-3xl text-white mb-1">
          Good to see you, {user.fullName?.split(' ')[0]}
        </h1>
        <p className="text-zinc-500 text-sm">Track your automated job applications.</p>
      </motion.div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
        {[
          { label: 'Total', value: stats.total, icon: '◈' },
          { label: 'Applied', value: stats.applied, icon: '◉' },
          { label: 'Interviewing', value: stats.interviewing, icon: '◎' },
          { label: 'Offers', value: stats.offers, icon: '◆' },
        ].map((stat, i) => (
          <motion.div
            key={stat.label}
            className="glass rounded-xl p-5"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.08 }}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-zinc-600 text-xs uppercase tracking-widest">{stat.label}</span>
              <span className="text-accent text-sm">{stat.icon}</span>
            </div>
            <div className="font-display text-3xl text-white">{stat.value}</div>
          </motion.div>
        ))}
      </div>

      {/* Applications table */}
      <div className="glass rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between">
          <h2 className="text-sm font-medium text-zinc-300">Recent Applications</h2>
          <button
            onClick={() => navigate('/')}
            className="btn-primary text-xs py-1.5 px-3"
          >
            + Find Jobs
          </button>
        </div>

        {applications.length === 0 ? (
          <div className="py-20 text-center text-zinc-600">
            <div className="text-4xl mb-3">◌</div>
            <p className="font-mono text-sm">No applications yet.</p>
            <button className="btn-primary mt-4 text-sm" onClick={() => navigate('/')}>
              Browse jobs
            </button>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {applications.map((app, i) => (
              <motion.div
                key={app.id}
                className="px-5 py-4 flex items-center gap-4 hover:bg-white/[0.02] transition-colors"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.04 }}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{app.title}</p>
                  <p className="text-xs text-zinc-500">{app.company}</p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_COLORS[app.status] || STATUS_COLORS.pending}`}>
                  {app.status}
                </span>
                <span className="text-xs text-zinc-600 font-mono whitespace-nowrap">
                  {new Date(app.appliedAt).toLocaleDateString()}
                </span>
                <a
                  href={app.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-zinc-600 hover:text-zinc-300 transition-colors"
                >
                  ↗
                </a>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
