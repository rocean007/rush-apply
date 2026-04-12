import { motion, AnimatePresence } from 'framer-motion';
import { useAppStore } from '../../store';

/** GDPR-compliant cookie consent banner */
export default function CookieBanner() {
  const { cookieConsent, setCookieConsent } = useAppStore();

  return (
    <AnimatePresence>
      {cookieConsent === null && (
        <motion.div
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-full max-w-xl px-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 20 }}
        >
          <div className="glass-strong rounded-xl p-4 flex items-center gap-4">
            <p className="text-sm text-zinc-400 flex-1">
              We use only functional cookies for session management. No tracking or analytics.
            </p>
            <div className="flex gap-2 shrink-0">
              <button
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                onClick={() => setCookieConsent(false)}
              >
                Decline
              </button>
              <button
                className="btn-primary text-xs py-1.5 px-3"
                onClick={() => setCookieConsent(true)}
              >
                Accept
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
