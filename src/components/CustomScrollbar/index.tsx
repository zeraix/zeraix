'use client'
import React, { useState, useEffect, useRef, useCallback } from "react";

interface CustomScrollbarProps {
  children: React.ReactNode;
  config?: {
    thumbWidth?: number;       // 滚动条粗细
    thumbColorActive?: string; // 点击/悬浮颜色
    thumbColor?: string;       // 默认颜色
    alwaysVisible?: boolean;   // 是否始终显示滚动条
  },
  /** 滚动事件，透传给内部的 div */
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

export default function CustomScrollbar({ children, config, onScroll }: CustomScrollbarProps) {
  const { 
    thumbWidth = 6, 
    thumbColor = "#00000033", 
    thumbColorActive = "#00000077",
    alwaysVisible = false
  } = config || {};

  // 统一管理所有滚动相关的测量值
  const [metrics, setMetrics] = useState({
    hasV: false,    // 是否有纵向滚动
    hasH: false,    // 是否有横向滚动
    vThumbH: 0,     // 纵向滑块高度
    hThumbW: 0,     // 横向滑块宽度
    vPos: 0,        // 纵向滑块位置
    hPos: 0,        // 横向滑块位置
  });

  const [show, setShow] = useState(false);
  const [isDraggingV, setIsDraggingV] = useState(false);
  const [isDraggingH, setIsDraggingH] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const startPos = useRef({ x: 0, y: 0, scrollL: 0, scrollT: 0 });

  /**
   * 更新滚动条的大小和位置
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
      // 计算滑块长度（按比例），最小 30px 保证能点到
      vThumbH: hasV ? Math.max((clientHeight / scrollHeight) * clientHeight, 30) : 0,
      hThumbW: hasH ? Math.max((clientWidth / scrollWidth) * clientWidth, 30) : 0,
      // 计算滑块在轨道上的位置偏移
      vPos: (scrollTop / scrollHeight) * clientHeight,
      hPos: (scrollLeft / scrollWidth) * clientWidth,
    });
  }, []);
  // 滚动事件处理
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    updateMetrics();
    onScroll?.(e);
  }, [updateMetrics, onScroll]);
  // 监听容器大小变化和初始加载
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
   * 鼠标拖拽逻辑处理
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
      {/* 隐藏原生滚动条的样式注入 */}
      <style jsx>{`
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>

      {/* 内容承载容器 */}
      <div
        ref={contentRef}
        onScroll={handleScroll}
        className="w-full h-full overflow-auto no-scrollbar"
      >
        {children}
      </div>

      {/* --- 纵向自定义滚动条 --- */}
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

      {/* --- 横向自定义滚动条 --- */}
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