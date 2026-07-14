import type { Metadata } from "next";
// import localFont from "next/font/local";
import "@/app/globals.css";
import SafetyRootLayout from "./SafetyRootLayout";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ThemeProvider from "@/components/theme/ThemeProvider";
import VoiceConnectionPanel from "@/components/VoiceConnectionPanel";
import TitleBar from "@/components/electron/TitleBar";

export const metadata: Metadata = {
  title:{
    default:"Zeraix",
    template:"%s | Zeraix"
  },
  description: "An all-in-one platform featuring an AI library, a workspace, and a community.",
  keywords: [
    "AI",
    "ChatGPT",
    "AI Platform"
  ],
  alternates: {
    canonical: "/",
  },
  robots:{
    index:true,
    follow:true
  },
  openGraph: {
    title: "AI Platform",
    description: "An all-in-one platform featuring an AI library, a workspace, and a community.",
    url: "https://zeraix.com/",
    siteName: "Zeraix",
    images: [
      {
        url: "/image/logo-white.png",
        width: 1200,
        height: 630,
      },
    ],
  },
};


export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html suppressHydrationWarning>
      <body className={`antialiased bg-surface-muted text-foreground`}>
        <ThemeProvider>
          <div className="flex h-screen flex-col overflow-hidden">
            <TitleBar />
            <div className="min-h-0 flex-1 overflow-auto">
              <TooltipProvider>
                <SafetyRootLayout>{children}</SafetyRootLayout>
              </TooltipProvider>
            </div>
          </div>
          <Toaster position="top-center" richColors theme="system" expand />
        </ThemeProvider>
      </body>
    </html>
  )
}
