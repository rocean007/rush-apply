import { motion } from 'framer-motion';
import { useState } from 'react';
import type { Job } from '../../types';
import { useAuthStore, useJobStore } from '../../store';

interface Props { job: Job; index: number; }

const SOURCE_COLORS: Record<string, string> = {
  remoteok:       'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  wwr:            'text-sky-400 bg-sky-400/10 border-sky-400/20',
  remotive:       'text-violet-400 bg-violet-400/10 border-violet-400/20',
  jobicy:         'text-amber-400 bg-amber-400/10 border-amber-400/20',
  arbeitnow:      'text-rose-400 bg-rose-400/10 border-rose-400/20',
  himalayas:      'text-teal-400 bg-teal-400/10 border-teal-400/20',
  default:        'text-zinc-400 bg-zinc-400/10 border-zinc-400/20',
};

/** Format salary range as human-readable string */
function formatSalary(min: number | null, max: number | null, currency = 'USD'): string | null {
  if (!min && !max) return null;
  const sym = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '$';
  const fmt = (n: number) => n >= 1000 ? `${sym}${(n / 1000).toFixed(0)}k` : `${sym}${n}`;
  if (min && max) return `${fmt(min)} – ${fmt(max)}`;
  if (min) return `${fmt(min)}+`;
  if (max) return `up to ${fmt(max)}`;
  return null;
}

function timeAgo(dateStr: string): string {
  const h = Math.floor((Date.now() - new Date(dateStr).getTime()) / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function JobCard({ job, index }: Props) {
  const { user } = useAuthStore();
  const { applyToJob } = useJobStore();
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState('');

  const tags = Array.isArray(job.tags) ? job.tags : (() => { try { return JSON.parse(job.tags as any || '[]'); } catch { return []; } })();
  const salary = formatSalary(job.salaryMin ?? null, job.salaryMax ?? null, job.salaryCurrency);
  const srcColor = SOURCE_COLORS[job.source?.split('-')[0]] || SOURCE_COLORS.default;
  const applyUrl = (job as any).applyUrl || job.url;

  const handleApply = async () => {
    if (!user) return;
    setApplying(true); setError('');
    try {
      await applyToJob(job.id);
      setApplied(true);
    } catch (e: any) {
      setError(e.message || 'Failed');
    } finally { setApplying(false); }
  };

  return (
    <motion.div
      className="glass rounded-xl p-5 hover:border-white/15 transition-colors duration-200 group flex flex-col gap-3"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.35 }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-white group-hover:text-accent transition-colors truncate leading-snug">
            {job.title}
          </h3>
          <p className="text-sm text-zinc-400 mt-0.5 truncate">{job.company}</p>
        </div>
        <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border shrink-0 ${srcColor}`}>
          {job.source?.replace(/-gh|-lv|-direct/, '')}
        </span>
      </div>

      {/* Meta row — location + salary */}
      <div className="flex items-center gap-3 flex-wrap text-xs">
        {/* Location */}
        <span className="flex items-center gap-1 text-zinc-400">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" className="shrink-0">
            <path d="M8 0a5 5 0 0 0-5 5c0 4 5 11 5 11s5-7 5-11a5 5 0 0 0-5-5zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>
          </svg>
          {job.location || 'Remote'}
        </span>

        {/* Remote badge */}
        {job.isRemote && job.location !== 'Remote' && (
          <span className="tag text-accent border-accent/20 text-[10px]">remote ✓</span>
        )}

        {/* Salary */}
        {salary && (
          <span className="flex items-center gap-1 text-accent font-mono">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm.5 11.5v1h-1v-1a3 3 0 0 1-2.3-1.1l.8-.9c.4.5 1 .9 1.7.9.7 0 1.3-.4 1.3-1s-.4-.9-1.4-1.2C6.3 7.9 5.5 7.2 5.5 6c0-1.1.8-2 1.8-2.3V2.5h1v1.2c.7.2 1.3.7 1.7 1.4l-.9.7c-.3-.6-.8-1-1.5-1-.7 0-1.1.4-1.1.9 0 .5.4.8 1.4 1.1 1.3.4 2 1.1 2 2.2 0 1.1-.8 2-1.9 2.3l.5.2z"/>
            </svg>
            {salary}
          </span>
        )}
      </div>

      {/* Description snippet */}
      {job.description && (
        <p className="text-xs text-zinc-500 leading-relaxed line-clamp-2">{job.description}</p>
      )}

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tags.slice(0, 5).map((tag: string) => (
            <span key={tag} className="tag text-[10px]">{tag}</span>
          ))}
          {tags.length > 5 && (
            <span className="tag text-[10px] text-zinc-600">+{tags.length - 5}</span>
          )}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-2 border-t border-white/[0.05] mt-auto">
        <span className="text-[10px] text-zinc-700 font-mono">{timeAgo(job.scrapedAt)}</span>

        <div className="flex items-center gap-2">
          {/* View job link */}
          <a
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
            title="View listing"
          >
            Details ↗
          </a>

          {/* Direct apply link */}
          <a
            href={applyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs btn-ghost py-1 px-2.5 border border-white/10 hover:border-white/20"
            title="Go to application page"
          >
            Apply ↗
          </a>

          {/* AI auto-apply (logged-in users) */}
          {user && !applied && (
            <button
              onClick={handleApply}
              disabled={applying}
              className="text-xs btn-primary py-1.5 px-3 flex items-center gap-1"
            >
              {applying
                ? <span className="w-3 h-3 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                : '⚡'}
              Auto
            </button>
          )}
          {applied && <span className="text-xs text-accent font-mono">✓ Queued</span>}
          {error   && <span className="text-xs text-red-400">{error}</span>}
        </div>
      </div>
    </motion.div>
  );
}
