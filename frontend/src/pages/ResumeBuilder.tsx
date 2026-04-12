import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store';
import { api } from '../utils/api';

export default function ResumeBuilder() {
  const { user, fetchProfile } = useAuthStore();
  const navigate = useNavigate();
  const [jobDesc, setJobDesc] = useState('');
  const [generatedResume, setGeneratedResume] = useState('');
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    if (!user) { navigate('/'); return; }
  }, [user]);

  /** Use Web Worker for resume parsing to keep UI thread free */
  useEffect(() => {
    workerRef.current = new Worker(
      new URL('../workers/resumeParser.worker.ts', import.meta.url),
      { type: 'module' }
    );
    return () => workerRef.current?.terminate();
  }, []);

  const handleGenerate = async () => {
    if (!jobDesc.trim()) return;
    setGenerating(true);
    setError('');
    setGeneratedResume('');
    try {
      const result = await api.generateResume(jobDesc) as any;
      setGeneratedResume(result.resume || '');
      await fetchProfile();
    } catch (e: any) {
      setError(e.message || 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveProfile = async () => {
    const skills = user?.skills || [];
    await api.updateProfile({ skills });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (!user) return null;

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-8"
      >
        <h1 className="font-display text-3xl text-white mb-1">AI Resume Builder</h1>
        <p className="text-zinc-500 text-sm">Paste a job description. Get a tailored resume in seconds.</p>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Input */}
        <div className="space-y-5">
          {/* Profile Card */}
          <div className="glass rounded-xl p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-accent/20 border border-accent/30 flex items-center justify-center text-sm font-mono text-accent">
                {user.fullName?.[0]?.toUpperCase()}
              </div>
              <div>
                <p className="text-sm text-white font-medium">{user.fullName}</p>
                <p className="text-xs text-zinc-500">{user.title || 'No title set'}</p>
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-zinc-500 mb-1 block uppercase tracking-wider">Skills</label>
                <div className="flex flex-wrap gap-1">
                  {(user.skills || []).map(s => (
                    <span key={s} className="tag">{s}</span>
                  ))}
                  {!user.skills?.length && <span className="text-xs text-zinc-600">No skills added</span>}
                </div>
              </div>
            </div>
          </div>

          {/* Job Description Input */}
          <div className="glass rounded-xl p-5">
            <label className="text-xs text-zinc-500 mb-2 block uppercase tracking-wider">
              Job Description
            </label>
            <textarea
              className="input min-h-[200px] resize-none font-mono text-xs leading-relaxed"
              placeholder="Paste the full job description here..."
              value={jobDesc}
              onChange={e => setJobDesc(e.target.value)}
            />
            {error && (
              <p className="text-xs text-red-400 mt-2">{error}</p>
            )}
            <button
              className="btn-primary w-full mt-4 flex items-center justify-center gap-2"
              onClick={handleGenerate}
              disabled={generating || !jobDesc.trim()}
            >
              {generating ? (
                <>
                  <span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                  Generating with AI...
                </>
              ) : (
                <>⚡ Generate Tailored Resume</>
              )}
            </button>
          </div>
        </div>

        {/* Right: Generated Resume */}
        <div className="glass rounded-xl p-5 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <label className="text-xs text-zinc-500 uppercase tracking-wider">Generated Resume</label>
            {generatedResume && (
              <button
                className="text-xs btn-ghost py-1 px-3 border border-white/10"
                onClick={() => navigator.clipboard.writeText(generatedResume)}
              >
                Copy
              </button>
            )}
          </div>

          {generating ? (
            <div className="flex-1 space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="skeleton h-3" style={{ width: `${70 + Math.random() * 30}%` }} />
              ))}
            </div>
          ) : generatedResume ? (
            <pre className="flex-1 text-xs text-zinc-300 font-mono whitespace-pre-wrap leading-relaxed overflow-auto">
              {generatedResume}
            </pre>
          ) : (
            <div className="flex-1 flex items-center justify-center text-zinc-700">
              <div className="text-center">
                <div className="text-4xl mb-3">◌</div>
                <p className="font-mono text-sm">Resume will appear here</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
