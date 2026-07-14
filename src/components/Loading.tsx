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
        
        {/* 背景呼吸光晕：提供环境氛围 */}
        <div 
          className="absolute rounded-full bg-primary/15 blur-3xl animate-pulse"
          style={{ width: size * 1.8, height: size * 1.8 }}
        />

        {/* 主体容器：负责整体的呼吸节奏 */}
        <div className="h-full relative animate-[breath_3s_ease-in-out_infinite] flex items-center justify-center">
          
          {/* Logo 图片 */}
          <Image 
            src="/logo.png" 
            alt="Loading" 
            width={size} 
            height={size} 
            unoptimized 
            className="relative z-10"
          />

          {/* 扫光层：利用 mask-image 确保扫光只出现在 Logo 形状内部（如果是透明 PNG） */}
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
        /* 呼吸动画：缩放 + 透明度 */
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

        /* 扫光动画：斜向快速划过 */
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