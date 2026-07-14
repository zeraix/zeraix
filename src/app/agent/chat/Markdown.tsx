"use client";

/**
 * Markdown rendering (based on markdown-it).
 *
 * - html:false — does not parse raw HTML, preventing LLM output from injecting scripts/tags (XSS protection).
 * - linkify:true — bare links (https://… / emails) automatically become clickable links.
 * - breaks:true — a single newline renders as <br>, matching the line-by-line feel of chat output.
 * Links all open in a new tab (target=_blank + rel=noreferrer noopener).
 * Typography uses Tailwind child-selector variants, reusing the project's design-system tokens (primary / surface / ink / line…),
 * automatically adapting to light/dark and the accent color.
 */
import MarkdownIt from "markdown-it";
import { memo } from "react";

// Module-level singleton, avoiding rebuilding the parser on every render.
const md = new MarkdownIt({
  html: false, // do not trust raw HTML from LLM output
  linkify: true, // bare URLs automatically become links
  breaks: true, // single newline → <br>
  typographer: false,
});

// Links all open in a new tab, with a safe rel added.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noreferrer noopener");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Wrap tables in a horizontal-scroll container: overly wide tables scroll horizontally within the container instead of breaking out of the message block.
md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table>';
md.renderer.rules.table_close = () => "</table></div>";

// Apply tokenized styles to the generated HTML using Tailwind child-selector variants (light/dark + accent-color adaptive).
const PROSE = [
  "space-y-1.5 text-sm leading-relaxed text-ink",
  // Paragraphs / headings
  "[&_p]:leading-relaxed",
  "[&_h1]:mt-2 [&_h1]:mb-0.5 [&_h1]:text-lg [&_h1]:font-bold [&_h1]:text-ink",
  "[&_h2]:mt-2 [&_h2]:mb-0.5 [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-ink",
  "[&_h3]:mt-2 [&_h3]:mb-0.5 [&_h3]:text-sm [&_h3]:font-bold [&_h3]:text-ink",
  "[&_h4]:mt-2 [&_h4]:mb-0.5 [&_h4]:text-sm [&_h4]:font-semibold [&_h4]:text-ink",
  // Links (accent color, adapting to the accent)
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-primary/80 [&_a]:break-words",
  // Inline code (excluding code inside code blocks)
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em]",
  // Code blocks
  "[&_pre]:my-1 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-neutral-900 [&_pre]:px-3 [&_pre]:py-2 [&_pre]:text-[12px] [&_pre]:leading-relaxed [&_pre]:text-neutral-100",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:font-mono",
  // Lists
  "[&_ul]:my-1 [&_ul]:ml-5 [&_ul]:list-disc [&_ul]:space-y-0.5",
  "[&_ol]:my-1 [&_ol]:ml-5 [&_ol]:list-decimal [&_ol]:space-y-0.5",
  "[&_li]:text-ink",
  // Blockquotes / horizontal rules
  "[&_blockquote]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_blockquote]:text-ink-muted",
  "[&_hr]:my-2 [&_hr]:border-line",
  // Tables: the outer .md-table-wrap handles horizontal scrolling; the table itself sizes to its content (w-max) but fills the container at minimum (min-w-full),
  // so overly wide content overflows into the scroll container rather than breaking out of the message block.
  "[&_.md-table-wrap]:my-1 [&_.md-table-wrap]:block [&_.md-table-wrap]:max-w-full [&_.md-table-wrap]:overflow-x-auto",
  "[&_table]:w-max [&_table]:min-w-full [&_table]:border-collapse [&_table]:text-[13px]",
  "[&_thead_tr]:border-b [&_thead_tr]:border-line-strong [&_thead_tr]:bg-surface-muted",
  "[&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_th]:text-ink",
  "[&_tbody_tr]:border-b [&_tbody_tr]:border-line [&_tbody_tr:last-child]:border-0",
  "[&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top [&_td]:text-ink-muted",
  // Emphasis
  "[&_strong]:font-semibold [&_strong]:text-ink",
  "[&_img]:my-1 [&_img]:max-w-full [&_img]:rounded-lg",
].join(" ");

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const html = md.render(content ?? "");
  return <div className={PROSE} dangerouslySetInnerHTML={{ __html: html }} />;
});
