'use client';

import React from 'react';

interface ShimmerTextProps {
  /**
   * Text content
   */
  children: React.ReactNode;

  /**
   * Custom class name
   */
  className?: string;

  /**
   * Animation duration (seconds), default 2s
   */
  duration?: number;

  /**
   * Shimmer width percentage, default 30%
   */
  shimmerWidth?: number;

  /**
   * Shimmer color, default translucent white
   */
  shimmerColor?: string;

  /**
   * Whether to pause the animation
   */
  paused?: boolean;
}

/**
 * Shimmering white-light text component
 * Used to display status text such as "Thinking...", with a white light sweeping across it
 *
 * @example
 * ```tsx
 * <ShimmerText>Thinking...</ShimmerText>
 * <ShimmerText duration={3} shimmerWidth={40}>Loading...</ShimmerText>
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
