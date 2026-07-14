"use client";

import { useEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  Volume1,
  Volume2,
  VolumeX,
  Maximize,
  Download,
  PictureInPicture2,
  MoreVertical,
} from "lucide-react";

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

const fmtTime = (s: number): string => {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
};

const fileNameOf = (url: string): string => {
  const last = url.split(/[?#]/)[0].split("/").pop();
  return last && last.includes(".") ? decodeURIComponent(last) : "video.mp4";
};

export interface HoverVideoPlayerProps {
  /** Video source URL */
  src: string;
  /** Extra class name for the outer container (fills the parent with a black background by default) */
  className?: string;
}

/**
 * Hover-to-play video card: shows the first frame as a cover by default, loads and plays on hover,
 * then pauses and returns to the cover when the pointer leaves.
 * Comes with a themed gold control bar (play/progress/time/mute/speed/picture-in-picture/download/fullscreen)
 * that replaces the browser's native controls for a consistent look under Chromium/Electron.
 * Double-click the video to toggle fullscreen.
 */
export default function HoverVideoPlayer({
  src,
  className,
}: HoverVideoPlayerProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const clickTimerRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const volHudTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // Flag set while dragging the progress bar: keeps rAF from overwriting the drag position with the video's actual time
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  // Records whether playback was active before the drag, so it can be resumed on release
  const wasPlayingRef = useRef(false);
  const menuOpenRef = useRef(false);
  const [hovering, setHovering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isFs, setIsFs] = useState(false);
  const [rate, setRate] = useState(1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pipOk, setPipOk] = useState(false);
  // active: recent mouse activity (shows the control bar and cursor); set to false after 3 seconds of inactivity
  const [active, setActive] = useState(true);
  const [volume, setVolume] = useState(1);
  // volHud: the volume indicator shown briefly while adjusting the volume
  const [volHud, setVolHud] = useState(false);

  // Initially muted: hover autoplay is subject to browser policy, which only allows gesture-free playback when muted.
  // React's muted attribute doesn't always take effect, so set it imperatively to be sure. Also probe picture-in-picture availability.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = true;
    setPipOk(
      typeof document !== "undefined" &&
        Boolean(document.pictureInPictureEnabled),
    );
  }, []);

  useEffect(() => {
    const onFs = () => setIsFs(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Clear any pending timers on unmount to avoid leaks
  useEffect(() => {
    return () => {
      if (clickTimerRef.current != null) clearTimeout(clickTimerRef.current);
      if (idleTimerRef.current != null) clearTimeout(idleTimerRef.current);
      if (volHudTimerRef.current != null) clearTimeout(volHudTimerRef.current);
    };
  }, []);

  // Briefly show the volume indicator (fades out after 1.2 seconds)
  const showVolHud = () => {
    setVolHud(true);
    if (volHudTimerRef.current != null) clearTimeout(volHudTimerRef.current);
    volHudTimerRef.current = window.setTimeout(() => {
      volHudTimerRef.current = null;
      setVolHud(false);
    }, 1200);
  };

  // Keep the timer callback reading the latest menu-open state (avoids stale closures)
  useEffect(() => {
    menuOpenRef.current = menuOpen;
  }, [menuOpen]);

  // During playback, use requestAnimationFrame to read the real progress each frame and advance the progress bar frame by frame,
  // which is far smoother than timeupdate (only ~4 times per second, which looks steppy); stop when paused to save resources.
  useEffect(() => {
    if (!playing) return;
    const tick = () => {
      const v = videoRef.current;
      if (v && !draggingRef.current) setCurrent(v.currentTime);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [playing]);

  // Mark mouse activity: show the control bar and cursor, and reset the 3-second idle timer.
  // Only hide on idle timeout while playing and when the menu is not open.
  const markActive = () => {
    setActive(true);
    if (idleTimerRef.current != null) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      const v = videoRef.current;
      if (v && !v.paused && !menuOpenRef.current) setActive(false);
    }, 3000);
  };
  const clearIdle = () => {
    if (idleTimerRef.current != null) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    setActive(true);
  };

  const handleEnter = () => {
    setHovering(true);
    markActive();
    // Grab focus on hover (without scrolling the page) so the arrow keys work without an extra click
    wrapRef.current?.focus({ preventScroll: true });
    const v = videoRef.current;
    if (!v) return;
    v.preload = "auto";
    v.play().catch(() => {});
  };
  const handleLeave = () => {
    if (isFs) return; // In fullscreen, don't pause just because the mouse left
    if (draggingRef.current) return; // While dragging the progress bar, don't pause/reset so the drag isn't interrupted
    setHovering(false);
    setMenuOpen(false);
    clearIdle();
    wrapRef.current?.blur();
    const v = videoRef.current;
    if (!v) return;
    v.pause();
    try {
      v.currentTime = 0;
    } catch {
      // Setting currentTime before metadata is ready can throw; ignore it
    }
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };
  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
    showVolHud();
  };
  // Set the volume uniformly: clamp to [0,1]; a volume of 0 means muted, >0 unmutes
  const applyVolume = (next: number) => {
    const v = videoRef.current;
    if (!v) return;
    const vol = Math.min(1, Math.max(0, Math.round(next * 100) / 100));
    v.volume = vol;
    v.muted = vol === 0;
    setVolume(vol);
    setMuted(vol === 0);
  };
  // Adjust volume with the wheel: scroll up to increase, down to decrease, 5% per notch
  const onVolumeWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const base = muted ? 0 : volume;
    applyVolume(base + (e.deltaY < 0 ? 0.05 : -0.05));
    showVolHud();
    markActive();
  };
  // Seek to the time matching the pointer's x position: update the displayed progress immediately (without waiting for buffering) so the bar tracks the pointer
  const seekToClientX = (clientX: number) => {
    const v = videoRef.current;
    const el = trackRef.current;
    if (!v || !el) return;
    const dur = v.duration;
    if (!dur || !isFinite(dur)) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
    const t = ratio * dur;
    v.currentTime = t;
    setCurrent(t);
  };
  // Start dragging on pointer-down and attach the subsequent move/up handlers to window,
  // so the drag keeps tracking even when the pointer leaves the track (or the player), ending on release
  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const v = videoRef.current;
    // Pause during the drag to avoid audio/video glitches from frequent seeks while playing; resume on release
    wasPlayingRef.current = !!v && !v.paused;
    if (v && !v.paused) v.pause();
    draggingRef.current = true;
    setDragging(true);
    seekToClientX(e.clientX);
    markActive();
    const onMove = (ev: PointerEvent) => {
      seekToClientX(ev.clientX);
      markActive();
    };
    const onUp = () => {
      draggingRef.current = false;
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // On release, resume playback from where the drag landed, with audio also starting there
      if (wasPlayingRef.current) videoRef.current?.play().catch(() => {});
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const toggleFs = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  };
  // Single-click to play / double-click for fullscreen: a double-click fires two clicks first, so delay the single click by 220ms,
  // canceling it if a double-click arrives, to keep single and double clicks from fighting and toggling playback back and forth
  const handleVideoClick = () => {
    if (clickTimerRef.current != null) return; // A single click is already pending; let the double-click handle it
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      togglePlay();
    }, 220);
  };
  const handleVideoDoubleClick = () => {
    if (clickTimerRef.current != null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    toggleFs();
  };
  // Step size for ←/→: 5 seconds normally, scaled down proportionally for short videos (minimum 0.5 seconds) to avoid jumping straight to the end
  const seekStep = (): number => {
    const d = videoRef.current?.duration || 0;
    if (!d || !isFinite(d)) return 5;
    return Math.min(5, Math.max(0.5, d / 10));
  };
  // Arrow keys: ←/→ seek back/forward (step adapts to duration), ↑/↓ adjust volume by 10%
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const v = videoRef.current;
    if (!v) return;
    switch (e.key) {
      case " ":
      case "Spacebar": // For older browsers
        e.preventDefault();
        if (v.ended) {
          // After playback ends, Space restarts from the beginning
          v.currentTime = 0;
          v.play().catch(() => {});
        } else {
          togglePlay();
        }
        markActive();
        break;
      case "ArrowLeft": {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - seekStep());
        setCurrent(v.currentTime);
        markActive();
        break;
      }
      case "ArrowRight": {
        e.preventDefault();
        // Don't jump straight to the end; leave a tiny margin so a short video doesn't end in a single step
        const end = (v.duration || 0) - 0.01;
        v.currentTime = Math.min(Math.max(0, end), v.currentTime + seekStep());
        setCurrent(v.currentTime);
        markActive();
        break;
      }
      case "ArrowUp":
        e.preventDefault();
        v.volume = Math.min(1, Math.round((v.volume + 0.1) * 10) / 10);
        v.muted = false; // Raising the volume unmutes
        setMuted(false);
        setVolume(v.volume);
        showVolHud();
        markActive();
        break;
      case "ArrowDown":
        e.preventDefault();
        v.volume = Math.max(0, Math.round((v.volume - 0.1) * 10) / 10);
        if (v.volume === 0) v.muted = true; // Dropping to 0 counts as muted
        setMuted(v.muted);
        setVolume(v.volume);
        showVolHud();
        markActive();
        break;
      default:
        break;
    }
  };
  const togglePip = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await v.requestPictureInPicture();
      }
    } catch {
      // Ignore when the user cancels or the browser doesn't support it
    }
  };
  const changeRate = (r: number) => {
    const v = videoRef.current;
    if (v) v.playbackRate = r;
    setRate(r);
  };
  const download = async () => {
    const name = fileNameOf(src);
    // Prefer a blob-based forced download (handles cross-origin, avoids opening in a new tab); fall back to a plain link download on failure
    try {
      const res = await fetch(src, { mode: "cors" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch {
      const a = document.createElement("a");
      a.href = src;
      a.download = name;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  };

  const progress = duration ? (current / duration) * 100 : 0;
  // Control bar / cursor visibility: when hovering or in fullscreen and there was recent mouse activity (hidden after 3 seconds of idle)
  const barVisible = (hovering || isFs) && active;
  const cursorHidden = (hovering || isFs) && !active;
  const iconBtn =
    "hover:text-primary transition-colors cursor-pointer shrink-0";

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      className={`relative w-full h-full bg-black outline-none focus-visible:ring-2 focus-visible:ring-primary ${cursorHidden ? "cursor-none" : ""} ${className || ""}`}
      onMouseEnter={handleEnter}
      onMouseMove={markActive}
      onMouseLeave={handleLeave}
      onKeyDown={handleKeyDown}
    >
      {/* #t=0.1 makes the browser jump to the first frame to use as the cover */}
      <video
        ref={videoRef}
        src={`${src}#t=0.1`}
        className="w-full h-full object-contain"
        muted={muted}
        preload="metadata"
        playsInline
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => {
          // While dragging, don't overwrite the tracked position with the video's actual time (currentTime lags during a seek)
          if (!draggingRef.current) setCurrent(e.currentTarget.currentTime);
        }}
        onPlay={() => {
          setPlaying(true);
          markActive();
        }}
        onPause={() => {
          setPlaying(false);
          clearIdle();
        }}
        onEnded={() => {
          setPlaying(false);
          clearIdle();
        }}
        onClick={handleVideoClick}
        onDoubleClick={handleVideoDoubleClick}
      />

      {/* Centered play indicator: shown while paused (hidden during the temporary pause while dragging to avoid flicker) */}
      {!playing && !dragging && (
        <button
          type="button"
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center"
          aria-label="Play"
        >
          <span className="flex items-center justify-center w-12 h-12 rounded-full bg-black/45 backdrop-blur-sm transition-transform hover:scale-105">
            <Play className="w-6 h-6 text-white fill-white translate-x-[1px]" />
          </span>
        </button>
      )}

      {/* Volume indicator: shown briefly in the center while adjusting the volume */}
      <div
        className={`pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-200 ${
          volHud ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-black/60 backdrop-blur-sm text-white">
          {muted || volume === 0 ? (
            <VolumeX className="w-5 h-5 shrink-0" />
          ) : volume <= 0.5 ? (
            <Volume1 className="w-5 h-5 shrink-0" />
          ) : (
            <Volume2 className="w-5 h-5 shrink-0" />
          )}
          <div className="w-20 h-1 rounded-full bg-white/30">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${muted ? 0 : Math.round(volume * 100)}%` }}
            />
          </div>
          <span className="text-[11px] tabular-nums w-7 text-right">
            {muted ? 0 : Math.round(volume * 100)}%
          </span>
        </div>
      </div>

      {/* Custom control bar */}
      <div
        className={`absolute inset-x-0 bottom-0 px-2.5 pb-2 pt-6 bg-gradient-to-t from-black/70 to-transparent select-none transition-opacity duration-200 ${
          barVisible ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* Progress bar */}
        <div
          ref={trackRef}
          className="group/track relative h-3 flex items-center cursor-pointer touch-none select-none"
          onPointerDown={onTrackPointerDown}
        >
          <div className="relative w-full h-1 rounded-full bg-white/30">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div
            className={`absolute w-3 h-3 rounded-full bg-primary shadow -translate-x-1/2 transition-opacity group-hover/track:opacity-100 ${
              dragging ? "opacity-100" : "opacity-0"
            }`}
            style={{ left: `${progress}%` }}
          />
        </div>

        {/* Button row: common controls stay on the bar; speed/picture-in-picture/download go into the overflow menu */}
        <div className="flex items-center gap-3 mt-1 text-white">
          <button
            type="button"
            onClick={togglePlay}
            className={iconBtn}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? (
              <Pause className="w-4 h-4" />
            ) : (
              <Play className="w-4 h-4 fill-current" />
            )}
          </button>
          {/* Volume: shows only the icon by default, with the slider expanding on hover; the whole group supports wheel adjustment */}
          <div
            className="group/vol flex items-center"
            onWheel={onVolumeWheel}
          >
            <button
              type="button"
              onClick={toggleMute}
              className={iconBtn}
              aria-label={muted ? "Unmute" : "Mute"}
            >
              {muted || volume === 0 ? (
                <VolumeX className="w-4 h-4" />
              ) : volume <= 0.5 ? (
                <Volume1 className="w-4 h-4" />
              ) : (
                <Volume2 className="w-4 h-4" />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => applyVolume(Number(e.target.value))}
              className="h-1 accent-primary cursor-pointer w-0 opacity-0 pointer-events-none transition-[width,opacity,margin] duration-200 group-hover/vol:w-16 group-hover/vol:ml-1.5 group-hover/vol:opacity-100 group-hover/vol:pointer-events-auto"
              aria-label="Volume"
              title="Volume (scroll to adjust)"
            />
          </div>
          <span className="text-[11px] tabular-nums select-none whitespace-nowrap">
            {fmtTime(current)} / {fmtTime(duration)}
          </span>

          <div className="ml-auto flex items-center gap-3">
            {/* Overflow menu: speed / picture-in-picture / download */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                className={iconBtn}
                aria-label="More"
              >
                <MoreVertical className="w-4 h-4" />
              </button>
              {menuOpen && (
                <div className="absolute bottom-full right-0 mb-1.5 w-36 rounded-lg bg-black/90 backdrop-blur-sm shadow-lg overflow-hidden text-white">
                  {/* Playback speed */}
                  <div className="grid grid-cols-3 gap-1 p-1.5">
                    {PLAYBACK_RATES.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => changeRate(r)}
                        className={`py-0.5 rounded text-[11px] tabular-nums transition-colors ${
                          r === rate
                            ? "bg-primary text-white"
                            : "bg-white/10 hover:bg-white/20"
                        }`}
                      >
                        {r}x
                      </button>
                    ))}
                  </div>
                  <div className="h-px bg-white/10" />
                  {/* Picture-in-picture / download, side by side */}
                  <div className={pipOk ? "grid grid-cols-2" : ""}>
                    {pipOk && (
                      <button
                        type="button"
                        onClick={() => {
                          togglePip();
                          setMenuOpen(false);
                        }}
                        className="flex items-center justify-center gap-1.5 py-2 text-[11px] hover:bg-white/10 transition-colors"
                      >
                        <PictureInPicture2 className="w-3.5 h-3.5" />
                        Picture-in-picture
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        download();
                        setMenuOpen(false);
                      }}
                      className="flex items-center justify-center gap-1.5 py-2 text-[11px] hover:bg-white/10 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Fullscreen */}
            <button
              type="button"
              onClick={toggleFs}
              className={iconBtn}
              aria-label="Fullscreen"
              title="Fullscreen"
            >
              <Maximize className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
