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
  /** 视频地址 */
  src: string;
  /** 外层容器额外类名（默认填满父级、黑底） */
  className?: string;
}

/**
 * 悬停播放视频卡片：默认展示首帧封面，鼠标悬停时加载并播放，移开后暂停回到封面。
 * 自带主题金色控制条（播放/进度/时间/静音/倍速/画中画/下载/全屏），替代浏览器原生控制条，
 * 在 Chromium/Electron 下外观一致。双击视频切换全屏。
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
  // 拖拽进度条时的标记：让 rAF 不要用视频实际时间覆盖拖拽位置
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  // 记录拖拽前是否在播放，松手后据此恢复播放
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
  // active：近期有鼠标活动（显示控制条与光标）；无活动 3 秒后置否
  const [active, setActive] = useState(true);
  const [volume, setVolume] = useState(1);
  // volHud：调节音量时短暂显示的音量指示
  const [volHud, setVolHud] = useState(false);

  // 初始静音：悬停自动播放受浏览器策略限制，必须静音才允许无手势播放。
  // React 的 muted 属性不一定生效，这里用命令式设置确保到位。同时探测画中画可用性。
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

  // 卸载时清掉未触发的计时器，避免泄漏
  useEffect(() => {
    return () => {
      if (clickTimerRef.current != null) clearTimeout(clickTimerRef.current);
      if (idleTimerRef.current != null) clearTimeout(idleTimerRef.current);
      if (volHudTimerRef.current != null) clearTimeout(volHudTimerRef.current);
    };
  }, []);

  // 短暂显示音量指示（1.2 秒后淡出）
  const showVolHud = () => {
    setVolHud(true);
    if (volHudTimerRef.current != null) clearTimeout(volHudTimerRef.current);
    volHudTimerRef.current = window.setTimeout(() => {
      volHudTimerRef.current = null;
      setVolHud(false);
    }, 1200);
  };

  // 让计时器回调读到最新的菜单开关状态（避免闭包过期）
  useEffect(() => {
    menuOpenRef.current = menuOpen;
  }, [menuOpen]);

  // 播放期间用 requestAnimationFrame 按帧读取真实进度，逐帧推进进度条，
  // 比 timeupdate（每秒仅 ~4 次、会出现台阶感）平滑得多；暂停时停止以省资源。
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

  // 标记鼠标活动：显示控制条与光标，并重置 3 秒空闲计时器。
  // 仅在播放中、且菜单未打开时，空闲到时才隐藏。
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
    // 悬停即取得焦点（不滚动页面），让方向键无需额外点击即可生效
    wrapRef.current?.focus({ preventScroll: true });
    const v = videoRef.current;
    if (!v) return;
    v.preload = "auto";
    v.play().catch(() => {});
  };
  const handleLeave = () => {
    if (isFs) return; // 全屏时不因鼠标移出而暂停
    if (draggingRef.current) return; // 拖拽进度时不暂停/复位，避免打断拖动
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
      // 元数据未就绪时设置 currentTime 可能抛错，忽略
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
  // 统一设置音量：钳制到 [0,1]，音量为 0 即静音，>0 则取消静音
  const applyVolume = (next: number) => {
    const v = videoRef.current;
    if (!v) return;
    const vol = Math.min(1, Math.max(0, Math.round(next * 100) / 100));
    v.volume = vol;
    v.muted = vol === 0;
    setVolume(vol);
    setMuted(vol === 0);
  };
  // 滚轮调节音量：上滚增大、下滚减小，每格 5%
  const onVolumeWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const base = muted ? 0 : volume;
    applyVolume(base + (e.deltaY < 0 ? 0.05 : -0.05));
    showVolHud();
    markActive();
  };
  // 根据指针横坐标定位到对应时间：立即更新显示进度（不等视频缓冲），让进度条跟手
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
  // 按下即开始拖拽，并把后续移动/松开挂到 window 上，
  // 这样指针移出轨道（甚至移出播放器）也能继续跟手，松手即结束
  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const v = videoRef.current;
    // 拖拽期间暂停，避免边播边频繁 seek 导致音画错乱；松手后恢复
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
      // 松手后从拖拽落点继续播放，声音也从该处开始
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
  // 单击播放 / 双击全屏：双击会先派发两次单击，这里把单击延迟 220ms，
  // 若期间到来双击则取消，避免单击与双击争抢导致播放状态来回切换
  const handleVideoClick = () => {
    if (clickTimerRef.current != null) return; // 已有待触发的单击，交给双击处理
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
  // ←/→ 的步长：常规 5 秒，短视频按时长按比例缩小（最小 0.5 秒），避免一步跳到结尾
  const seekStep = (): number => {
    const d = videoRef.current?.duration || 0;
    if (!d || !isFinite(d)) return 5;
    return Math.min(5, Math.max(0.5, d / 10));
  };
  // 方向键：←/→ 进退（步长随时长自适应），↑/↓ 调节音量 10%
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const v = videoRef.current;
    if (!v) return;
    switch (e.key) {
      case " ":
      case "Spacebar": // 兼容旧浏览器
        e.preventDefault();
        if (v.ended) {
          // 播放结束后按空格从头重播
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
        // 不直接跳到结尾，留出极小余量避免短视频一步到底即结束
        const end = (v.duration || 0) - 0.01;
        v.currentTime = Math.min(Math.max(0, end), v.currentTime + seekStep());
        setCurrent(v.currentTime);
        markActive();
        break;
      }
      case "ArrowUp":
        e.preventDefault();
        v.volume = Math.min(1, Math.round((v.volume + 0.1) * 10) / 10);
        v.muted = false; // 调高音量即取消静音
        setMuted(false);
        setVolume(v.volume);
        showVolHud();
        markActive();
        break;
      case "ArrowDown":
        e.preventDefault();
        v.volume = Math.max(0, Math.round((v.volume - 0.1) * 10) / 10);
        if (v.volume === 0) v.muted = true; // 降到 0 视为静音
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
      // 用户取消或浏览器不支持时忽略
    }
  };
  const changeRate = (r: number) => {
    const v = videoRef.current;
    if (v) v.playbackRate = r;
    setRate(r);
  };
  const download = async () => {
    const name = fileNameOf(src);
    // 优先以 blob 强制下载（兼容跨域，避免在新标签打开），失败回退到普通链接下载
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
  // 控制条/光标可见性：悬停或全屏时，且近期有鼠标活动（空闲 3 秒后隐藏）
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
      {/* #t=0.1 让浏览器跳到首帧作为封面 */}
      <video
        ref={videoRef}
        src={`${src}#t=0.1`}
        className="w-full h-full object-contain"
        muted={muted}
        preload="metadata"
        playsInline
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => {
          // 拖拽中不要用视频实际时间覆盖跟手位置（seek 时 currentTime 会滞后）
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

      {/* 居中播放标识：暂停时显示（拖拽进度时临时暂停，不显示以免闪烁） */}
      {!playing && !dragging && (
        <button
          type="button"
          onClick={togglePlay}
          className="absolute inset-0 flex items-center justify-center"
          aria-label="播放"
        >
          <span className="flex items-center justify-center w-12 h-12 rounded-full bg-black/45 backdrop-blur-sm transition-transform hover:scale-105">
            <Play className="w-6 h-6 text-white fill-white translate-x-[1px]" />
          </span>
        </button>
      )}

      {/* 音量指示：调节音量时短暂居中显示 */}
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

      {/* 自定义控制条 */}
      <div
        className={`absolute inset-x-0 bottom-0 px-2.5 pb-2 pt-6 bg-gradient-to-t from-black/70 to-transparent select-none transition-opacity duration-200 ${
          barVisible ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        {/* 进度条 */}
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

        {/* 按钮行：常用控件留在条上，倍速/画中画/下载收进溢出菜单 */}
        <div className="flex items-center gap-3 mt-1 text-white">
          <button
            type="button"
            onClick={togglePlay}
            className={iconBtn}
            aria-label={playing ? "暂停" : "播放"}
          >
            {playing ? (
              <Pause className="w-4 h-4" />
            ) : (
              <Play className="w-4 h-4 fill-current" />
            )}
          </button>
          {/* 音量：默认仅显示图标，悬停时滑块展开；整组支持滚轮调节 */}
          <div
            className="group/vol flex items-center"
            onWheel={onVolumeWheel}
          >
            <button
              type="button"
              onClick={toggleMute}
              className={iconBtn}
              aria-label={muted ? "取消静音" : "静音"}
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
              aria-label="音量"
              title="音量（可滚轮调节）"
            />
          </div>
          <span className="text-[11px] tabular-nums select-none whitespace-nowrap">
            {fmtTime(current)} / {fmtTime(duration)}
          </span>

          <div className="ml-auto flex items-center gap-3">
            {/* 溢出菜单：倍速 / 画中画 / 下载 */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                className={iconBtn}
                aria-label="更多"
              >
                <MoreVertical className="w-4 h-4" />
              </button>
              {menuOpen && (
                <div className="absolute bottom-full right-0 mb-1.5 w-36 rounded-lg bg-black/90 backdrop-blur-sm shadow-lg overflow-hidden text-white">
                  {/* 倍速 */}
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
                  {/* 画中画 / 下载 并排 */}
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
                        画中画
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
                      下载
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 全屏 */}
            <button
              type="button"
              onClick={toggleFs}
              className={iconBtn}
              aria-label="全屏"
              title="全屏"
            >
              <Maximize className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
