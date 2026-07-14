"use client";

import React, {
  useState,
  useEffect,
  useImperativeHandle,
  forwardRef,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import CustomScrollbar from "./CustomScrollbar";

export type DrawerDirection = "top" | "right" | "bottom" | "left";

export interface DrawerProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;

  direction?: DrawerDirection;

  /** Default standard header title */
  title?: React.ReactNode;
  /** Fully externally controlled header content (takes priority over title) */
  header?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;

  className?: string;

  style?: React.CSSProperties;
  maskStyle?: React.CSSProperties;

  /** Whether clicking the mask or outside closes the drawer */
  maskClosable?: boolean;
  /** Whether to show the mask */
  mask?: boolean;
}

export interface DrawerRef {
  open: () => void;
  close: () => void;
}

const DrawerEl = forwardRef<DrawerRef, DrawerProps>((props, ref) => {
  const {
    open: controlledOpen,
    onOpenChange,
    defaultOpen = false,

    direction = "right",

    title,
    header,
    footer,
    children,

    className = "",

    style = {},
    maskStyle = {},

    maskClosable = true,
    mask = true,
  } = props;

  // =========================================
  // state & refs
  // =========================================

  const [internalOpen, setInternalOpen] = useState(defaultOpen);

  const isControlled = controlledOpen !== undefined;

  const isOpen = isControlled ? controlledOpen : internalOpen;

  const drawerRef = useRef<HTMLDivElement>(null);

  // =========================================
  // radius
  // =========================================

  const radius = 24;

  // =========================================
  // ref
  // =========================================

  useImperativeHandle(ref, () => ({
    open: () => {
      if (!isControlled) {
        setInternalOpen(true);
      }
    },

    close: () => {
      handleClose();
    },
  }));

  // =========================================
  // close
  // =========================================

  const handleClose = () => {
    if (!isControlled) {
      setInternalOpen(false);
    }

    onOpenChange?.(false);
  };

  // =========================================
  // Global listener for click-outside-to-close
  // =========================================

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (
        !isOpen ||
        !drawerRef.current ||
        drawerRef.current.contains(event.target as Node)
      ) {
        return;
      }

      if (maskClosable) {
        handleClose();
      }
    };

    if (isOpen) {
      const timer = setTimeout(() => {
        window.addEventListener("click", handleOutsideClick);
      }, 0);
      return () => {
        clearTimeout(timer);
        window.removeEventListener("click", handleOutsideClick);
      };
    }
  }, [isOpen, mask, maskClosable]);

  // =========================================
  // body scroll lock
  // =========================================

  useEffect(() => {
    if (isOpen && mask) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen, mask]);

  // =========================================
  // mounted
  // =========================================

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  // =========================================
  // position
  // =========================================

  const getPositionStyle = (): React.CSSProperties => {
    switch (direction) {
      case "left":
        return {
          top: 0,
          left: 0,
          bottom: 0,
          width: "400px",
        };

      case "right":
        return {
          top: 0,
          right: 0,
          bottom: 0,
          width: "400px",
        };

      case "top":
        return {
          top: 0,
          left: 0,
          right: 0,
          width: "100%",
          height: "320px",
        };

      case "bottom":
        return {
          left: 0,
          right: 0,
          bottom: 0,
          width: "100%",
          height: "320px",
        };

      default:
        return {};
    }
  };

  // =========================================
  // transform
  // =========================================

  const getTransform = () => {
    if (isOpen) {
      return "translate3d(0,0,0)";
    }

    switch (direction) {
      case "left":
        return "translate3d(-100%,0,0)";

      case "right":
        return "translate3d(100%,0,0)";

      case "top":
        return "translate3d(0,-100%,0)";

      case "bottom":
        return "translate3d(0,100%,0)";

      default:
        return "translate3d(100%,0,0)";
    }
  };

  // =========================================
  // drawer radius
  // =========================================

  const getRadiusStyle = (): React.CSSProperties => {
    switch (direction) {
      case "left":
        return {
          borderTopRightRadius: radius,
          borderBottomRightRadius: radius,
        };

      case "right":
        return {
          borderTopLeftRadius: radius,
          borderBottomLeftRadius: radius,
        };

      case "top":
        return {
          borderBottomLeftRadius: radius,
          borderBottomRightRadius: radius,
        };

      case "bottom":
        return {
          borderTopLeftRadius: radius,
          borderTopRightRadius: radius,
        };

      default:
        return {};
    }
  };

  // =========================================
  // header radius
  // =========================================

  const getHeaderRadiusStyle = (): React.CSSProperties => {
    switch (direction) {
      case "left":
        return {
          borderTopRightRadius: radius,
        };

      case "right":
        return {
          borderTopLeftRadius: radius,
        };

      case "bottom":
        return {
          borderTopLeftRadius: radius,
          borderTopRightRadius: radius,
        };

      default:
        return {};
    }
  };

  // =========================================
  // footer radius
  // =========================================

  const getFooterRadiusStyle = (): React.CSSProperties => {
    switch (direction) {
      case "left":
        return {
          borderBottomRightRadius: radius,
        };

      case "right":
        return {
          borderBottomLeftRadius: radius,
        };

      case "top":
        return {
          borderBottomLeftRadius: radius,
          borderBottomRightRadius: radius,
        };

      default:
        return {};
    }
  };

  // =========================================
  // shadow
  // =========================================

  const getShadowStyle = (): React.CSSProperties => {
    if (!isOpen) {
      return { boxShadow: "none" };
    }

    switch (direction) {
      case "left":
        return {
          boxShadow: "10px 0 30px rgba(0,0,0,0.12)",
        };

      case "right":
        return {
          boxShadow: "-10px 0 30px rgba(0,0,0,0.12)",
        };

      case "top":
        return {
          boxShadow: "0 10px 30px rgba(0,0,0,0.12)",
        };

      case "bottom":
        return {
          boxShadow: "0 -10px 30px rgba(0,0,0,0.12)",
        };

      default:
        return {};
    }
  };

  // =========================================
  // Core change: priority-based conditional rendering of Header vs Title
  // =========================================
  const renderHeader = () => {
    // 1. If header is provided, use external control unconditionally (header has the highest priority)
    if (header) {
      return (
        <div className="shrink-0" style={{ ...getHeaderRadiusStyle() }}>
          {header}
        </div>
      );
    }

    // 2. If header isn't provided but title is, use the standard header layout with a close button
    if (title) {
      return (
        <div
          className="shrink-0 border-b border-line bg-surface px-6 py-4"
          style={{ ...getHeaderRadiusStyle() }}
        >
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold text-ink">{title}</div>
            <button
              onClick={handleClose}
              className="flex items-center justify-center w-9 h-9 rounded-full text-ink-muted hover:bg-surface-hover transition-colors"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      );
    }

    // 3. If neither is provided, render no header
    return null;
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[9999]"
      style={{
        pointerEvents: isOpen ? "auto" : "none",
      }}
    >
      {/* mask */}
      {mask && (
        <div
          className="absolute inset-0 bg-black/50 transition-opacity duration-300"
          style={{
            opacity: isOpen ? 1 : 0,
            backdropFilter: "blur(4px)",
            ...maskStyle,
          }}
        />
      )}

      {/* drawer */}
      <div
        ref={drawerRef}
        className={`
          fixed
          flex
          flex-col
          overflow-visible
          transition-transform
          duration-300
          ease-out
          will-change-transform
          ${className}
        `}
        style={{
          ...getPositionStyle(),
          ...getShadowStyle(),
          transform: getTransform(),
          pointerEvents: "auto",
          ...style,
        }}
      >
        {/* rounded container */}
        <div
          className="flex flex-col w-full h-full overflow-hidden bg-surface"
          style={{
            ...getRadiusStyle(),
          }}
        >
          {/* Render header */}
          {renderHeader()}

          {/* content */}
          <div className="flex-1 min-h-0 p-6 text-ink">{children}</div>

          {/* footer */}
          {footer && (
            <div
              className="shrink-0 border-t border-line bg-surface-muted px-6 py-4"
              style={{
                ...getFooterRadiusStyle(),
              }}
            >
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
});

DrawerEl.displayName = "DrawerEl";

export default DrawerEl;
