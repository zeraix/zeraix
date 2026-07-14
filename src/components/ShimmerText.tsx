'use client';

import React from 'react';

interface ShimmerTextProps {
  /**
   * 文本内容
   */
  children: React.ReactNode;
  
  /**
   * 自定义类名
   */
  className?: string;
  
  /**
   * 动画持续时间(秒),默认 2s
   */
  duration?: number;
  
  /**
   * 扫光宽度百分比,默认 30%
   */
  shimmerWidth?: number;
  
  /**
   * 扫光颜色,默认白色半透明
   */
  shimmerColor?: string;
  
  /**
   * 是否暂停动画
   */
  paused?: boolean;
}

/**
 * 扫白光文本组件
 * 用于展示"正在思考中..."等状态文本,带有白光扫过的动效
 * 
 * @example
 * ```tsx
 * <ShimmerText>正在思考中...</ShimmerText>
 * <ShimmerText duration={3} shimmerWidth={40}>加载中...</ShimmerText>
 * ```
 */
export const ShimmerText: React.FC<ShimmerTextProps> = ({
  children,
  className = '',
  duration = 2,
  shimmerWidth = 100,
  shimmerColor = 'from-transparent via-white/60 to-transparent',
  paused = false,
}) => {
  return (
    <span className={`relative overflow-hidden inline-block ${className}`}>
      {children}
      <span
        className={`absolute inset-0 bg-gradient-to-r ${shimmerColor}`}
        style={{
          width: `${shimmerWidth}%`,
          left: `-${shimmerWidth}%`,
          animation: `shimmer ${duration}s infinite${paused ? ' paused' : ''}`,
        }}
      />
      <style jsx>{`
        @keyframes shimmer {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(calc(100% + ${shimmerWidth}%));
          }
        }
      `}</style>
    </span>
  );
};

export default ShimmerText;
