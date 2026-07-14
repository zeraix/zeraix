'use client';
import Image from 'next/image';

interface LoadingProps {
  size?: number;
  className?: string;
}

export const Loading = ({ size = 100, className = "" }: LoadingProps) => {
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <div className="relative flex items-center justify-center h-full">
        
        {/* Background breathing glow: provides ambient atmosphere */}
        <div 
          className="absolute rounded-full bg-primary/15 blur-3xl animate-pulse"
          style={{ width: size * 1.8, height: size * 1.8 }}
        />

        {/* Main container: drives the overall breathing rhythm */}
        <div className="h-full relative animate-[breath_3s_ease-in-out_infinite] flex items-center justify-center">
          
          {/* Logo image */}
          <Image 
            src="/logo.png" 
            alt="Loading" 
            width={size} 
            height={size} 
            unoptimized 
            className="relative z-10"
          />

          {/* Shimmer layer: uses mask-image to ensure the shimmer only appears within the Logo shape (if it's a transparent PNG) */}
          <div 
            className="absolute inset-0 z-20 pointer-events-none overflow-hidden"
            style={{
              maskImage: 'url("/logo.png")',
              WebkitMaskImage: 'url("/logo.png")',
              maskSize: 'contain',
              WebkitMaskSize: 'contain',
              maskRepeat: 'no-repeat',
              WebkitMaskRepeat: 'no-repeat'
            }}
          >
            <div className="shimmer-line absolute inset-0 bg-gradient-to-r from-transparent via-white/80 to-transparent" />
          </div>
        </div>
      </div>

      <style jsx>{`
        /* Breathing animation: scale + opacity */
        @keyframes breath {
          0%, 100% {
            transform: scale(0.92);
            opacity: 0.7;
          }
          50% {
            transform: scale(1.05);
            opacity: 1;
          }
        }

        /* Shimmer animation: a quick diagonal sweep */
        @keyframes shimmer {
          0% { transform: translateX(-150%) skewX(-25deg); }
          50% { transform: translateX(150%) skewX(-25deg); }
          100% { transform: translateX(150%) skewX(-25deg); }
        }

        .shimmer-line {
          width: 50%;
          height: 100%;
          animation: shimmer 2.5s infinite ease-in-out;
        }
      `}</style>
    </div>
  );
};