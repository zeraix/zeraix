"use client";
import { Toast } from "@/lib/toast";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const rawMessage = error?.message;
  const digestId = error?.digest;
  
  const fallbackMessage = "An unresolved client-side exception occurred.";
  const finalErrorText = rawMessage || (digestId ? `Error Digest: ${digestId}` : fallbackMessage);

  const handleClearCacheAndReset = async () => {
    try {
      localStorage.clear();
      sessionStorage.clear();
      if (window.caches) {
        const names = await caches.keys();
        await Promise.all(names.map((name) => caches.delete(name)));
      }
      document.cookie.split(";").forEach((c) => {
        document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
      });
      Toast.success("Core logic for clearing the cache and refreshing");
    } catch (e) {
      console.error("Failed to clear cache.:", e);
    }
    window.location.reload();
  };

  const handleCopyLog = () => {
    const logText = `[Error Log]\nMsg: ${rawMessage || 'None'}\nDigest: ${digestId || 'None'}`;
    navigator.clipboard.writeText(logText);
    Toast.success("Error log copied.");
  };

  return (
    <div style={styles.viewport}>
      <div style={styles.ambientGlow} />

      <div style={styles.mainLayout}>
        <div style={styles.iconVisual}>
          <div style={styles.iconCore} />
        </div>

        <h1 style={styles.headline}>APPLICATION ERROR</h1>
        
        <p style={styles.subline}>
          A client-side exception occurred during application runtime. This is typically caused by local cache conflicts resulting from live version updates or failures in loading and parsing static assets.
        </p>

        <div style={styles.consoleContainer} onClick={handleCopyLog} title="Click to copy the full error log">
          <div style={styles.consoleHeader}>
            <span style={styles.consoleDot} />
            <span style={styles.consoleTitle}>EXCEPTION_TRACE</span>
          </div>
          <div style={styles.consoleBody}>
            {finalErrorText}
          </div>
        </div>

        <div style={styles.controlGroup}>
          <button 
            onClick={handleClearCacheAndReset} 
            style={styles.metallicPrimaryBtn}
            onMouseEnter={(e) => {
              e.currentTarget.style.filter = "brightness(1.15)";
              e.currentTarget.style.transform = "scale(1.01)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.filter = "none";
              e.currentTarget.style.transform = "scale(1)";
            }}
          >
            Clear the cache and rebuild the page.
          </button>
          
          <button 
            onClick={() => reset()} 
            style={styles.flatSecondaryBtn}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--surface-hover)";
              e.currentTarget.style.color = "var(--ink)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = "var(--ink-muted)";
            }}
          >
            Retry immediately
          </button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  viewport: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    width: '100vw',
    backgroundColor: 'var(--background)',
    color: 'var(--ink)',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
    padding: '32px',
    boxSizing: 'border-box' as const,
    position: 'relative' as const,
    overflow: 'hidden',
  },
  ambientGlow: {
    position: 'absolute' as const,
    width: '600px',
    height: '300px',
    background: 'radial-gradient(circle, rgba(218, 55, 55, 0.04) 0%, rgba(0,0,0,0) 70%)',
    top: '15%',
    left: '50%',
    transform: 'translateX(-50%)',
    pointerEvents: 'none' as const,
    zIndex: 0,
  },
  mainLayout: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    textAlign: 'center' as const,
    maxWidth: '560px',
    width: '100%',
    zIndex: 1,
  },
  iconVisual: {
    width: '40px',
    height: '40px',
    border: '1px solid var(--line)',
    transform: 'rotate(45deg)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: '32px',
    backgroundColor: 'var(--surface-muted)',
  },
  iconCore: {
    width: '8px',
    height: '8px',
    backgroundColor: '#da3737', 
  },
  headline: {
    fontSize: '14px',
    fontWeight: 700,
    letterSpacing: '0.25em',
    color: 'var(--ink)',
    marginBottom: '16px',
  },
  subline: {
    fontSize: '13px',
    color: 'var(--ink-muted)',
    lineHeight: '1.68',
    marginBottom: '28px',
    fontWeight: 400,
  },
  consoleContainer: {
    width: '100%',
    backgroundColor: 'var(--surface-muted)',
    border: '1px solid var(--line)',
    borderRadius: '6px',
    textAlign: 'left' as const,
    fontFamily: 'SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.25)',
    cursor: 'pointer',
    marginBottom: '36px',
  },
  consoleHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 14px',
    borderBottom: '1px solid var(--line)',
    backgroundColor: 'var(--surface-hover)',
  },
  consoleDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    backgroundColor: '#da3737',
  },
  consoleTitle: {
    fontSize: '10px',
    fontWeight: 600,
    color: 'var(--ink-subtle)',
    letterSpacing: '0.08em',
  },
  consoleBody: {
    padding: '14px',
    fontSize: '12px',
    color: 'var(--ink)',
    lineHeight: '1.5',
    maxHeight: '160px',
    overflowY: 'auto' as const,
    wordBreak: 'break-all' as const,
  },
  controlGroup: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
    width: '100%',
  },
  metallicPrimaryBtn: {
    width: '100%',
    padding: '14px',
    fontSize: '13px',
    fontWeight: 600,
    letterSpacing: '0.05em',
    color: 'var(--primary-foreground)',
    background: 'var(--primary)',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
    transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  flatSecondaryBtn: {
    width: '100%',
    padding: '12px',
    fontSize: '13px',
    fontWeight: 500,
    color: 'var(--ink-muted)',
    backgroundColor: 'transparent',
    border: 'none',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
};