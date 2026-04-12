import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useJobStore, useAuthStore } from '../store';
import JobCard from '../components/features/JobCard';
import { JobCardSkeleton } from '../components/ui/Skeletons';
import { api } from '../utils/api';

export default function Landing() {
  const { jobs, total, page, loading, search, source, setSearch, setSource, fetchJobs } = useJobStore();
  const { user } = useAuthStore();
  const [inputVal, setInputVal]     = useState(search);
  const [sources, setSources]       = useState<string[]>([]);
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [salaryMin, setSalaryMin]   = useState('');
  debounce(inputVal, () => { setSearch(inputVal); fetchJobs(1); });

  // Load source list once
  useEffect(() => {
    api.getJobs({ limit: 1 }).then(() =>
      fetch('/api/jobs/sources').then(r => r.json()).then(setSources).catch(() => {})
    );
  }, []);

  useEffect(() => { fetchJobs(1); }, [source, remoteOnly]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      {/* Hero */}
      <motion.div
        className="text-center mb-12"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55 }}
      >
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent/10 border border-accent/20 text-accent text-xs font-mono mb-5">
          <span className="w-1.5 h-1.5 bg-accent rounded-full animate-pulse-soft" />
          {total > 0 ? `${total.toLocaleString()} live jobs` : 'AI-powered job agent'}
        </div>
        <h1 className="font-display text-5xl md:text-6xl text-white tracking-tight leading-[1.05] mb-4">
          Apply to 100 jobs<br />
          <span className="text-accent">while you sleep.</span>
        </h1>
        <p className="text-zinc-500 text-lg max-w-lg mx-auto leading-relaxed">
          Scraped from 100+ sources every 30 min. AI tailors your resume. One click applies.
        </p>
      </motion.div>

      {/* Search bar */}
      <div className="relative mb-4">
        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M11.4 10H10.7l-.3-.3A6.5 6.5 0 0 0 6.5 1a6.5 6.5 0 1 0 4.9 10.8l.3.3v.7l5 5-1.5 1.5-5-5zm-6 0A4.5 4.5 0 1 1 10 5.5 4.5 4.5 0 0 1 5.5 10z"/>
          </svg>
        </span>
        <input
          className="input pl-10 pr-4 py-3 text-base"
          placeholder="Job title, company, skill, keyword..."
          value={inputVal}
          onChange={e => setInputVal(e.target.value)}
        />
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap gap-2 mb-8">
        {/* Remote toggle */}
        <button
          onClick={() => setRemoteOnly(v => !v)}
          className={`px-3 py-1.5 rounded-lg text-xs border transition-all ${
            remoteOnly
              ? 'bg-accent/10 text-accent border-accent/30'
              : 'text-zinc-500 border-white/10 hover:border-white/20 hover:text-zinc-300'
          }`}
        >
          🌍 Remote only
        </button>

        {/* Salary filter */}
        <div className="flex items-center gap-1">
          <span className="text-zinc-600 text-xs">Min $</span>
          <select
            className="bg-white/5 border border-white/10 rounded-lg text-xs text-zinc-300 px-2 py-1.5 focus:outline-none focus:border-accent/40"
            value={salaryMin}
            onChange={e => { setSalaryMin(e.target.value); fetchJobs(1); }}
          >
            <option value="">Any salary</option>
            <option value="40000">40k+</option>
            <option value="60000">60k+</option>
            <option value="80000">80k+</option>
            <option value="100000">100k+</option>
            <option value="120000">120k+</option>
            <option value="150000">150k+</option>
          </select>
        </div>

        {/* Source filter pills */}
        <div className="flex flex-wrap gap-1.5">
          {['', ...(sources.length ? sources.slice(0, 12) : [])].map(s => (
            <button
              key={s || '__all'}
              onClick={() => setSource(s)}
              className={`px-3 py-1 rounded-full text-[11px] border transition-all ${
                source === s
                  ? 'bg-white/10 text-white border-white/20'
                  : 'text-zinc-600 border-white/5 hover:text-zinc-400 hover:border-white/15'
              }`}
            >
              {s || 'All'}
            </button>
          ))}
        </div>
      </div>

      {/* Result count */}
      <div className="flex items-center justify-between mb-5">
        <p className="text-zinc-600 text-sm font-mono">
          {loading ? 'Fetching...' : `${total.toLocaleString()} jobs`}
          {source && <span className="text-zinc-700"> · {source}</span>}
          {remoteOnly && <span className="text-zinc-700"> · remote</span>}
        </p>
        {!loading && total > 20 && (
          <span className="text-zinc-700 text-xs font-mono">pg {page}/{Math.ceil(total/20)}</span>
        )}
      </div>

      {/* Job grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {loading
          ? Array.from({ length: 8 }).map((_, i) => <JobCardSkeleton key={i} />)
          : jobs.map((job, i) => <JobCard key={job.id} job={job} index={i} />)
        }
      </div>

      {/* Empty state */}
      {!loading && jobs.length === 0 && (
        <div className="py-24 text-center text-zinc-600">
          <div className="text-5xl mb-4 opacity-30">◌</div>
          <p className="font-mono text-sm">No jobs found. Try a different search.</p>
          <button className="btn-ghost mt-4 text-sm" onClick={() => { setInputVal(''); setSearch(''); setSource(''); fetchJobs(1); }}>
            Clear filters
          </button>
        </div>
      )}

      {/* Pagination */}
      {!loading && jobs.length > 0 && (
        <div className="flex items-center justify-center gap-4 mt-10">
          <button onClick={() => fetchJobs(page - 1)} disabled={page <= 1} className="btn-ghost text-sm disabled:opacity-25">← Prev</button>
          <span className="text-zinc-600 font-mono text-sm">{page} / {Math.ceil(total / 20)}</span>
          <button onClick={() => fetchJobs(page + 1)} disabled={page >= Math.ceil(total / 20)} className="btn-ghost text-sm disabled:opacity-25">Next →</button>
        </div>
      )}
    </div>
  );
}

/** Simple hook — debounce side effect on value change */
function debounce(value: string, fn: () => void) {
  const ref = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    ref.current = setTimeout(fn, 420);
    return () => clearTimeout(ref.current);
  }, [value]);
}
