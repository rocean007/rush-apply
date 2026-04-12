import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useAuthStore, useAppStore } from '../../store';
import AuthModal from '../features/AuthModal';

export default function Navbar() {
  const { user, logout } = useAuthStore();
  const { theme, toggleTheme } = useAppStore();
  const [authOpen, setAuthOpen] = useState(false);
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <>
      <nav className="sticky top-0 z-40 border-b border-white/[0.06] glass">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-accent flex items-center justify-center">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="black">
                <path d="M8 1L15 5v6L8 15 1 11V5L8 1z" />
              </svg>
            </span>
            <span className="font-display font-700 text-white tracking-tight">Applybot</span>
          </Link>

          {/* Nav actions */}
          <div className="flex items-center gap-2">
            {/* Theme toggle */}
            <button
              onClick={toggleTheme}
              className="btn-ghost text-xl w-9 h-9 flex items-center justify-center"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? '☀' : '◑'}
            </button>

            {user ? (
              <>
                <Link to="/dashboard" className="btn-ghost text-sm">Dashboard</Link>
                <Link to="/resume" className="btn-ghost text-sm">Resume</Link>
                <button onClick={handleLogout} className="btn-ghost text-sm text-zinc-500">
                  Sign out
                </button>
                <div className="w-8 h-8 rounded-full bg-accent/20 border border-accent/30 flex items-center justify-center text-xs font-mono text-accent">
                  {user.fullName?.[0]?.toUpperCase() || '?'}
                </div>
              </>
            ) : (
              <button onClick={() => setAuthOpen(true)} className="btn-primary text-sm">
                Sign in
              </button>
            )}
          </div>
        </div>
      </nav>

      <AnimatePresence>
        {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
      </AnimatePresence>
    </>
  );
}
