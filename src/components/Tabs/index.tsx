"use client";
import React, { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface TabsProps {
  tabs: { id: string; label: string; content: React.ReactNode }[];
  type?: "pill" | "line" | "brush";
  orientation?: "horizontal" | "vertical";
  activeTextColor?: string;
  inactiveColor?: string;
  pillColor?: string;
  brushColor?: string;
  lineColor?: string;
  padding?: string;
  unmountOnExit?: boolean;
  // New Slot props
  leftSlot?: React.ReactNode;
  rightSlot?: React.ReactNode;
  className?: string; // Allows callers to customize the container style
  // New external control props
  onTabChange?: (id: string) => void; // Tab change callback
}

export default function Tabs({
  tabs = [],
  type = "brush",
  orientation = "horizontal",
  // Default colors now use theme tokens, switching with light/dark mode and the accent color; callers can still pass specific colors to override
  activeTextColor = "var(--primary)",
  inactiveColor = "var(--ink-muted)",
  pillColor = "var(--surface)",
  brushColor = "var(--brand)",
  lineColor = "var(--primary)",
  padding = "0",
  unmountOnExit = true,
  leftSlot,
  rightSlot,
  className = "",
  onTabChange,
}: TabsProps) {
  if (!tabs || (Array.isArray(tabs) && tabs.length === 0)) return null;

  const [activeTab, setActiveTab] = useState(tabs[0].id);
  const prevIndex = useRef(0);
  const currentIndex = tabs.findIndex((tab) => tab.id === activeTab);
  const isVertical = orientation === "vertical";

  const handleTabClick = (id: string, index: number) => {
    prevIndex.current = currentIndex;
    setActiveTab(id);
    // Invoke external callback
    if (onTabChange) {
      onTabChange(id);
    }
  };

  const direction = currentIndex >= prevIndex.current ? 1 : -1;

  const contentVariants = {
    initial: (dir: number) => ({
      opacity: 0,
      [isVertical ? "y" : "x"]: 10 * dir,
    }),
    animate: {
      opacity: 1,
      [isVertical ? "y" : "x"]: 0,
    },
    exit: (dir: number) => ({
      opacity: 0,
      [isVertical ? "y" : "x"]: -10 * dir,
    }),
  };

  return (
    <div className={`w-full sticky flex ${isVertical ? "flex-row gap-8" : "flex-col"} ${className}`}>
      {/* Nav bar outer container: handles Slot layout */}
      <div 
        className={`flex items-center ${
          isVertical ? "flex-col" : "flex-row  border-line"
        } ${type === "pill" ? "bg-surface-muted p-1 rounded-xl border-none!" : ""}`}
      >
        {/* Left Slot */}
        {leftSlot && <div className={`${isVertical ? "mb-2" : "mr-2"} flex-shrink-0`}>{leftSlot}</div>}

        {/* Middle scrollable Tab area */}
        <div 
          className={`flex-1 relative flex overflow-x-auto scrollbar-hide transition-all duration-300 ${
            isVertical ? "flex-col pr-2 overflow-y-auto" : "flex-row"
          }`}
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }} // Hide the standard scrollbar
        >
          {tabs.map((tab, index) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => handleTabClick(tab.id, index)}
                style={{ color: isActive ? activeTextColor : inactiveColor }}
                className={`relative px-4 py-2.5 text-sm font-medium transition-colors duration-300 outline-none flex-shrink-0 flex items-center justify-center ${
                  isVertical ? "w-32 justify-start" : "min-w-fit"
                }`}
              >
                <span className="relative z-10 whitespace-nowrap">{tab.label}</span>
                <AnimatePresence custom={direction}>
                  {isActive && (
                    <>
                      {type === "pill" && (
                        <motion.div 
                          layoutId="active-pill" 
                          style={{ backgroundColor: pillColor }} 
                          className="absolute inset-0 rounded-lg shadow-sm z-0" 
                          transition={{ type: "spring", bounce: 0.2, duration: 0.5 }} 
                        />
                      )}
                      {type === "line" && (
                        <motion.div 
                          layoutId="active-line" 
                          style={{ backgroundColor: lineColor }} 
                          className={`absolute ${isVertical ? "right-[-9px] top-0 bottom-0 w-0.5" : "bottom-0 left-0 right-0 h-0.5"}`} 
                          transition={{ type: "spring", bounce: 0, duration: 0.4 }} 
                        />
                      )}
                      {type === "brush" && (
                        <div className={`absolute pointer-events-none ${isVertical ? "right-[-12px] top-0 bottom-0 w-[12px] flex items-center" : "bottom-0 left-0 right-0 h-[12px]"}`}>
                          <svg viewBox="0 0 60 10" preserveAspectRatio="none" className={`${isVertical ? "rotate-90 w-[40px] h-[12px]" : "w-full h-full"} px-2`}>
                            <motion.path 
                              d="M1.5 7.5C12.3148 5.03811 33.4111 0.852885 31.2778 3.80716C29.1444 6.76143 47.8704 3.5 57.5 1.5" 
                              stroke={brushColor} strokeWidth="3" strokeLinecap="round" fill="none" 
                              custom={direction} 
                              variants={{ 
                                initial: (dir) => ({ pathLength: 0, pathOffset: dir === 1 ? 0 : 1, opacity: 0 }), 
                                animate: { pathLength: 1, pathOffset: 0, opacity: 1, transition: { pathLength: { duration: 0.5 }, pathOffset: { duration: 0.5 }, opacity: { duration: 0.2 } } }, 
                                exit: (dir) => ({ pathLength: 0, pathOffset: dir === 1 ? 1 : 0, opacity: [1, 1, 0], transition: { pathLength: { duration: 0.4 }, pathOffset: { duration: 0.4 }, opacity: { duration: 0.4 } } }) 
                              }} 
                              initial="initial" animate="animate" exit="exit" 
                            />
                          </svg>
                        </div>
                      )}
                    </>
                  )}
                </AnimatePresence>
              </button>
            );
          })}
        </div>

        {/* Right Slot */}
        {rightSlot && <div className={`${isVertical ? "mt-2" : "ml-2"} flex-shrink-0`}>{rightSlot}</div>}
      </div>

      {/* Content area keeps the original logic */}
      {/* Add min-h-0 to ensure flex children can shrink correctly */}
      <div className="flex-1 relative min-h-0 overflow-hidden">
        {unmountOnExit ? (
          <AnimatePresence mode="wait" custom={direction}>
            <motion.div
              key={activeTab}
              custom={direction}
              variants={contentVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={{ duration: 0.2 }}
              className="h-full"
              style={{ paddingTop: padding }}
            >
              {tabs[currentIndex]?.content}
            </motion.div>
          </AnimatePresence>
        ) : (
          <div className="relative w-full h-full">
             {tabs.map((tab) => (
                <motion.div
                  key={tab.id}
                  animate={activeTab === tab.id ? "animate" : "initial"}
                  variants={contentVariants}
                  className="h-full"
                  style={{ 
                    display: activeTab === tab.id ? "block" : "none",
                    paddingTop: padding 
                  }}
                >
                  {tab.content}
                </motion.div>
             ))}
          </div>
        )}
      </div>
    </div>
  );
}