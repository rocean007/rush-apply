import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useJobStore, useAuthStore } from '../store';
import JobCard from '../components/features/JobCard';
import { JobCardSkeleton } from '../components/ui/Skeletons';

const SOURCES = ['', 'remoteok', 'weworkremotely'];

export default function Landing() {
  const { jobs, total, page, loading, search, source, setSearch, setSource, fetchJobs } = useJobStore();
  const { user } = useAuthStore();
  const [inputVal, setInputVal] = useState(search);

  useEffect(() => { fetchJobs(1); }, [source]);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(inputVal);
      fetchJobs(1);
    }, 400);
    return () => clearTimeout(t);
  }, [inputVal]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      {/* Hero */}
      <motion.div
        className="text-center mb-14"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-accent/10 border border-accent/20 text-accent text-xs font-mono mb-6">
          <span className="w-1.5 h-1.5 bg-accent rounded-full animate-pulse-soft" />
          AI-powered job applications
        </div>
        <h1 className="font-display text-5xl md:text-6xl text-white tracking-tight leading-none mb-4">
          Apply to 100 jobs<br />
          <span className="text-accent">while you sleep.</span>
        </h1>
        <p className="text-zinc-500 text-lg max-w-xl mx-auto">
          Applybot scrapes remote jobs, tailors your resume with AI, and auto-fills applications — hands-free.
        </p>

        {!user && (
          <motion.div
            className="flex items-center justify-center gap-4 mt-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
          >
            <div className="flex -space-x-2">
              {['#84cc16','#fbbf24','#34d399','#a78bfa'].map((c, i) => (
                <div key={i} className="w-8 h-8 rounded-full border-2 border-surface-950" style={{ background: c }} />
              ))}
            </div>
            <span className="text-zinc-500 text-sm">Join 2,400+ job seekers</span>
          </motion.div>
        )}
      </motion.div>

      {/* Search + Filter */}
      <div className="flex flex-col sm:flex-row gap-3 mb-8">
        <div className="relative flex-1">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500 text-sm">⌕</span>
          <input
            className="input pl-9"
            placeholder="Search jobs, companies, skills..."
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          {SOURCES.map(s => (
            <button
              key={s || 'all'}
              onClick={() => setSource(s)}
              className={`px-4 py-2 rounded-lg text-sm transition-all duration-150 ${
                source === s
                  ? 'bg-white/10 text-white border border-white/15'
                  : 'text-zinc-500 hover:text-zinc-300 border border-transparent hover:border-white/10'
              }`}
            >
              {s || 'All'}
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 mb-6">
        <span className="text-zinc-600 text-sm font-mono">
          {loading ? '...' : `${total.toLocaleString()} jobs found`}
        </span>
        {total > 20 && (
          <span className="text-zinc-700 text-xs">Page {page}</span>
        )}
      </div>

      {/* Job Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => <JobCardSkeleton key={i} />)
          : jobs.map((job, i) => <JobCard key={job.id} job={job} index={i} />)
        }
      </div>

      {/* Pagination */}
      {!loading && jobs.length > 0 && (
        <div className="flex items-center justify-center gap-3 mt-10">
          <button
            onClick={() => fetchJobs(page - 1)}
            disabled={page <= 1}
            className="btn-ghost text-sm disabled:opacity-30"
          >
            ← Prev
          </button>
          <span className="text-zinc-600 font-mono text-sm">
            {page} / {Math.ceil(total / 20)}
          </span>
          <button
            onClick={() => fetchJobs(page + 1)}
            disabled={page >= Math.ceil(total / 20)}
            className="btn-ghost text-sm disabled:opacity-30"
          >
            Next →
          </button>
        </div>
      )}

      {/* Empty state */}
      {!loading && jobs.length === 0 && (
        <div className="text-center py-20 text-zinc-600">
          <div className="text-5xl mb-4">◌</div>
          <p className="font-mono text-sm">No jobs found. Try a different search.</p>
        </div>
      )}
    </div>
  );
}
