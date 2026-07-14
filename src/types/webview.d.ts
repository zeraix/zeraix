import type { DetailedHTMLProps, HTMLAttributes, Ref } from "react";

/** The minimal JSX type declaration for the Electron <webview> tag (only available in the rendering layer within Electron). */
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string;
          partition?: string;
          allowpopups?: boolean | "true";
          preload?: string;
          useragent?: string;
          ref?: Ref<HTMLElement>;
        },
        HTMLElement
      >;
    }
  }
}
