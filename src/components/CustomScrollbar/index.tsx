'use client'
import React, { useState, useEffect, useRef, useCallback } from "react";

interface CustomScrollbarProps {
  children: React.ReactNode;
  config?: {
    thumbWidth?: number;       // Scrollbar thickness
    thumbColorActive?: string; // Color when clicked/hovered
    thumbColor?: string;       // Default color
    alwaysVisible?: boolean;   // Whether to always show the scrollbar
  },
  /** Scroll event, forwarded to the inner div */
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

export default function CustomScrollbar({ children, config, onScroll }: CustomScrollbarProps) {
  const { 
    thumbWidth = 6, 
    thumbColor = "#00000033", 
    thumbColorActive = "#00000077",
    alwaysVisible = false
  } = config || {};

  // Manage all scroll-related measurements in one place
  const [metrics, setMetrics] = useState({
    hasV: false,    // Whether vertical scrolling is present
    hasH: false,    // Whether horizontal scrolling is present
    vThumbH: 0,     // Vertical thumb height
    hThumbW: 0,     // Horizontal thumb width
    vPos: 0,        // Vertical thumb position
    hPos: 0,        // Horizontal thumb position
  });

  const [show, setShow] = useState(false);
  const [isDraggingV, setIsDraggingV] = useState(false);
  const [isDraggingH, setIsDraggingH] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const startPos = useRef({ x: 0, y: 0, scrollL: 0, scrollT: 0 });

  /**
   * Update the scrollbar's size and position
   */
  const updateMetrics = useCallback(() => {
    if (!contentRef.current) return;
    const { 
      clientHeight, scrollHeight, 
      clientWidth, scrollWidth, 
      scrollTop, scrollLeft 
    } = contentRef.current;

    const hasV = scrollHeight > clientHeight;
    const hasH = scrollWidth > clientWidth;

    setMetrics({
      hasV,
      hasH,
      // Compute the thumb length (proportionally), with a 30px minimum to keep it clickable
      vThumbH: hasV ? Math.max((clientHeight / scrollHeight) * clientHeight, 30) : 0,
      hThumbW: hasH ? Math.max((clientWidth / scrollWidth) * clientWidth, 30) : 0,
      // Compute the thumb's offset along the track
      vPos: (scrollTop / scrollHeight) * clientHeight,
      hPos: (scrollLeft / scrollWidth) * clientWidth,
    });
  }, []);
  // Scroll event handler
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    updateMetrics();
    onScroll?.(e);
  }, [updateMetrics, onScroll]);
  // Watch for container size changes and the initial load
  useEffect(() => {
    updateMetrics();
    const observer = new ResizeObserver(updateMetrics);
    if (contentRef.current) observer.observe(contentRef.current);
    window.addEventListener("resize", updateMetrics);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateMetrics);
    };
  }, [updateMetrics]);

  /**
   * Mouse drag handling
   */
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!contentRef.current) return;
      const { scrollHeight, clientHeight, scrollWidth, clientWidth } = contentRef.current;

      if (isDraggingV) {
        const deltaY = e.clientY - startPos.current.y;
        const ratio = scrollHeight / clientHeight;
        contentRef.current.scrollTop = startPos.current.scrollT + deltaY * ratio;
      }
      if (isDraggingH) {
        const deltaX = e.clientX - startPos.current.x;
        const ratio = scrollWidth / clientWidth;
        contentRef.current.scrollLeft = startPos.current.scrollL + deltaX * ratio;
      }
    };

    const onMouseUp = () => {
      setIsDraggingV(false);
      setIsDraggingH(false);
      document.body.style.userSelect = "";
    };

    if (isDraggingV || isDraggingH) {
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [isDraggingV, isDraggingH]);

  const onMouseDownV = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingV(true);
    startPos.current = { x: 0, y: e.clientY, scrollL: 0, scrollT: contentRef.current?.scrollTop || 0 };
    document.body.style.userSelect = "none";
  };

  const onMouseDownH = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingH(true);
    startPos.current = { x: e.clientX, y: 0, scrollL: contentRef.current?.scrollLeft || 0, scrollT: 0 };
    document.body.style.userSelect = "none";
  };

  const isAnyDragging = isDraggingV || isDraggingH;

  return (
    <div
      className="relative w-full h-full overflow-hidden group"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => !isAnyDragging && setShow(false)}
    >
      {/* Injected styles to hide the native scrollbar */}
      <style jsx>{`
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>

      {/* Content container */}
      <div
        ref={contentRef}
        onScroll={handleScroll}
        className="w-full h-full overflow-auto no-scrollbar"
      >
        {children}
      </div>

      {/* --- Vertical custom scrollbar --- */}
      {metrics.hasV && (
        <div
          className={`absolute right-0 top-0 bottom-0 z-30 transition-opacity duration-300 pointer-events-none ${
            alwaysVisible || show || isDraggingV ? "opacity-100" : "opacity-0"
          }`}
          style={{ width: `${thumbWidth + 4}px` }}
        >
          <div
            onMouseDown={onMouseDownV}
            className="absolute right-1 rounded-full cursor-pointer transition-colors pointer-events-auto"
            style={{
              backgroundColor: isDraggingV ? thumbColorActive : thumbColor,
              width: `${thumbWidth}px`,
              height: `${metrics.vThumbH}px`,
              top: `${metrics.vPos}px`,
            }}
          />
        </div>
      )}

      {/* --- Horizontal custom scrollbar --- */}
      {metrics.hasH && (
        <div
          className={`absolute bottom-0 left-0 right-0 z-30 transition-opacity duration-300 pointer-events-none ${
            alwaysVisible || show || isDraggingH ? "opacity-100" : "opacity-0"
          }`}
          style={{ height: `${thumbWidth + 4}px` }}
        >
          <div
            onMouseDown={onMouseDownH}
            className="absolute bottom-1 rounded-full cursor-pointer transition-colors pointer-events-auto"
            style={{
              backgroundColor: isDraggingH ? thumbColorActive : thumbColor,
              height: `${thumbWidth}px`,
              width: `${metrics.hThumbW}px`,
              left: `${metrics.hPos}px`,
            }}
          />
        </div>
      )}
    </div>
  );
}