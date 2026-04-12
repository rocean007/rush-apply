import { motion } from 'framer-motion';
import type { Job } from '../../types';
import { useAuthStore, useJobStore } from '../../store';
import { useState } from 'react';

interface Props {
  job: Job;
  index: number;
}

const sourceColors: Record<string, string> = {
  remoteok: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  weworkremotely: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  default: 'text-zinc-400 bg-zinc-400/10 border-zinc-400/20',
};

/** Single job listing card with apply action */
export default function JobCard({ job, index }: Props) {
  const { user } = useAuthStore();
  const { applyToJob } = useJobStore();
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState('');

  const handleApply = async () => {
    if (!user) return;
    setApplying(true);
    setError('');
    try {
      await applyToJob(job.id);
      setApplied(true);
    } catch (e: any) {
      setError(e.message || 'Failed to apply');
    } finally {
      setApplying(false);
    }
  };

  const tags = typeof job.tags === 'string' ? JSON.parse(job.tags) : job.tags;
  const sourceColor = sourceColors[job.source] || sourceColors.default;
  const timeAgo = getTimeAgo(job.scrapedAt);

  return (
    <motion.div
      className="glass rounded-xl p-5 hover:border-white/15 transition-colors duration-200 group"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04, duration: 0.35 }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-medium text-white truncate group-hover:text-accent transition-colors">
            {job.title}
          </h3>
          <p className="text-sm text-zinc-400 mt-0.5">{job.company}</p>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full border whitespace-nowrap ${sourceColor}`}>
          {job.source}
        </span>
      </div>

      {job.description && (
        <p className="text-xs text-zinc-500 mt-3 leading-relaxed line-clamp-2">
          {job.description}
        </p>
      )}

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        {tags.slice(0, 4).map((tag: string) => (
          <span key={tag} className="tag">{tag}</span>
        ))}
        {job.isRemote && <span className="tag text-accent border-accent/20">remote</span>}
      </div>

      <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/[0.05]">
        <span className="text-xs text-zinc-600 font-mono">{timeAgo}</span>

        <div className="flex items-center gap-2">
          <a
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            View ↗
          </a>
          {user && !applied && (
            <button
              onClick={handleApply}
              disabled={applying}
              className="text-xs btn-primary py-1.5 px-3 flex items-center gap-1.5"
            >
              {applying ? (
                <span className="w-3 h-3 border-2 border-black/30 border-t-black rounded-full animate-spin" />
              ) : '⚡'}
              Auto-apply
            </button>
          )}
          {applied && (
            <span className="text-xs text-accent font-mono">✓ Applied</span>
          )}
          {error && <span className="text-xs text-red-400">{error}</span>}
        </div>
      </div>
    </motion.div>
  );
}

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
