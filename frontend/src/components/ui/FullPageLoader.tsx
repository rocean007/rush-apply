import { motion } from 'framer-motion';
import { useAppStore } from '../../store';

/** Full-page loading indicator for Suspense fallback */
export default function FullPageLoader() {
  return (
    <div className="min-h-screen mesh-bg flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-8 h-8 border-2 border-white/10 border-t-accent rounded-full animate-spin" />
        <p className="text-zinc-600 text-sm font-mono">loading...</p>
      </div>
    </div>
  );
}
