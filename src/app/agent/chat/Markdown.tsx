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
 *
 * Math is rendered with KaTeX through the rules added below — see the note above them for which delimiters
 * are recognised and, more importantly, which deliberately are not.
 */
import MarkdownIt from "markdown-it";
import katex from "katex";
// Local stylesheet, never a CDN: this ships as a packaged Electron app, and the cn edition runs where CDNs
// are unreliable. Importing it here lets the bundler emit KaTeX's woff2 fonts as build assets.
import "katex/dist/katex.min.css";
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

/**
 * Math, via KaTeX.
 *
 * Recognised: `$$…$$` and `\[…\]` as display math, `\(…\)` and `$…$` inline.
 *
 * Bare `$…$` was left out at first, on the grounds that "it costs $5 and $10 to ship" would silently become
 * an equation in a general chat window. That was the wrong trade: models write `$\frac{1}{6}$ 池/小时` inline
 * constantly, so refusing it left literal LaTeX all over ordinary answers — a certain, frequent bug traded
 * against a rare one. It is accepted under the guards in mathInlineDollar below, which reject the currency
 * shape rather than the delimiter.
 *
 * All three are INLINE rules rather than block rules, which is what lets `$$…$$` work both on a line of its
 * own (the common case) and mid-sentence. Display mode renders as `<span class="katex-display">`, a span, so
 * it stays valid inside the paragraph markdown-it wraps around it.
 *
 * Registered BEFORE markdown-it's `escape` rule on purpose: `(` and `[` are CommonMark-escapable, so left to
 * run first that rule would turn `\(` into a literal `(` and the delimiter would never be seen.
 */
function renderMath(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode,
      // Render KaTeX's own red error text in place instead of throwing: a model typo in one formula must not
      // blank out the whole message, and showing the broken source is what lets anyone see why.
      throwOnError: false,
      // The toolchain answers in Chinese, and `\text{ 小时}` — CJK inside \text — is precisely what strict mode
      // complains about. It is valid and common here.
      strict: false,
      // No \htmlClass / \href style escapes out of KaTeX into raw markup. `html:false` above exists to keep
      // model output from injecting anything; this keeps that true through the math path too.
      trust: false,
    });
  } catch {
    // Anything KaTeX could not handle at all falls back to the literal source, escaped.
    return md.utils.escapeHtml(latex);
  }
}

function addMathRule(name: string, open: string, close: string, displayMode: boolean) {
  md.inline.ruler.before("escape", name, (state, silent) => {
    const start = state.pos;
    if (!state.src.startsWith(open, start)) return false;
    const from = start + open.length;
    const end = state.src.indexOf(close, from);
    if (end < 0) return false; // unterminated → not math, leave the text alone
    const latex = state.src.slice(from, end);
    if (!latex.trim()) return false; // `$$$$` is not an equation
    if (!silent) state.push(name, "math", 0).content = latex;
    state.pos = end + close.length;
    return true;
  });
  md.renderer.rules[name] = (tokens, idx) => renderMath(tokens[idx].content, displayMode);
}

// `$$` MUST be registered before the single-`$` rule below: ruler.before("escape", …) appends in call order
// ahead of `escape`, so registering `$$` first is what stops `$…$` claiming the first half of a `$$…$$`.
addMathRule("math_block_dollar", "$$", "$$", true);
addMathRule("math_block_bracket", "\\[", "\\]", true);
addMathRule("math_inline_paren", "\\(", "\\)", false);

/**
 * `$…$` inline math, with the guards that separate an equation from a price.
 *
 * Three tests, all of which real inline math passes and the currency shape fails:
 *  - the opening `$` is followed by non-whitespace, and the closing `$` is preceded by non-whitespace, so a
 *    delimiter has to hug its content. This alone kills "$5 and $10 to ship": the only candidate closer has
 *    a space before it, and no other `$` follows.
 *  - the closing `$` is not followed by a digit, which catches the run-together "$5+$3".
 *  - no newline inside. Inline math does not span lines, and without this one stray `$` in a long message
 *    could swallow a paragraph before finding a partner.
 * A backslash-escaped `\$` is never a delimiter — markdown-it's own escape rule consumes it before this rule
 * sees it as an opener, and the closer scan skips it explicitly.
 */
md.inline.ruler.before("escape", "math_inline_dollar", (state, silent) => {
  const src = state.src;
  const start = state.pos;
  if (src[start] !== "$" || src.startsWith("$$", start)) return false;
  if (!src[start + 1] || /\s/.test(src[start + 1])) return false;
  let end = -1;
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] !== "$" || src[i - 1] === "\\" || /\s/.test(src[i - 1])) continue;
    end = i;
    break;
  }
  if (end < 0) return false;
  if (/[0-9]/.test(src[end + 1] ?? "")) return false;
  const latex = src.slice(start + 1, end);
  if (!latex.trim() || latex.includes("\n")) return false;
  if (!silent) state.push("math_inline_dollar", "math", 0).content = latex;
  state.pos = end + 1;
  return true;
});
md.renderer.rules.math_inline_dollar = (tokens, idx) => renderMath(tokens[idx].content, false);

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
  // Display math: a long equation scrolls inside its own strip rather than widening the message bubble,
  // the same rule the tables above follow. overflow-y stays hidden so tall fractions are not given a
  // spurious vertical scrollbar by the horizontal one.
  "[&_.katex-display]:my-2 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-0.5",
  // Emphasis
  "[&_strong]:font-semibold [&_strong]:text-ink",
  "[&_img]:my-1 [&_img]:max-w-full [&_img]:rounded-lg",
].join(" ");

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  const html = md.render(content ?? "");
  return <div className={PROSE} dangerouslySetInnerHTML={{ __html: html }} />;
});
