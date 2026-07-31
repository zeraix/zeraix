"use client";

/**
 * Placeholder transcript, shown in the message area while a conversation is being swapped in
 * (see loadConversation in page.tsx). Switching conversations reads the project archive from disk
 * and rebuilds the whole display list, so the area would otherwise sit on the previous
 * conversation's messages and then jump — the skeleton makes the swap read as a load.
 *
 * The shapes deliberately mirror MessageItem's layout (user = right-aligned bubble capped at 80%,
 * assistant = full-width text block) so the placeholder settles into the real content instead of
 * shifting it. Widths are fixed rather than random: this renders under SSR, and a random width
 * would differ between the server and client markup.
 */

/** One placeholder turn: the user bubble's width, then the assistant reply's line widths. */
const TURNS: { bubble: string; lines: string[] }[] = [
  { bubble: "w-40", lines: ["w-[92%]", "w-[76%]", "w-[84%]"] },
  { bubble: "w-56", lines: ["w-[88%]", "w-[61%]"] },
  { bubble: "w-32", lines: ["w-[94%]", "w-[80%]", "w-[68%]", "w-[42%]"] },
];

export function TranscriptSkeleton({ label }: { label: string }) {
  // Each bar's pulse is offset a little from the one above it, so the placeholder reads as a wave
  // travelling down the list rather than the whole area blinking in unison.
  let bar = 0;
  const pulse = () => ({ animationDelay: `${(bar++ % 6) * -0.15}s` });
  return (
    <div role="status" aria-busy="true" aria-label={label} className="flex flex-col gap-4">
      {TURNS.map((turn, ti) => (
        <div key={ti} className="flex flex-col gap-4">
          {/* User bubble */}
          <div className="flex flex-row-reverse" aria-hidden>
            <div
              className={`h-9 animate-pulse rounded-2xl rounded-tr-md bg-surface-muted ${turn.bubble}`}
              style={pulse()}
            />
          </div>
          {/* Assistant reply */}
          <div className="flex w-full flex-col gap-2.5 px-1 py-0.5" aria-hidden>
            {turn.lines.map((w, li) => (
              <div key={li} className={`h-3.5 animate-pulse rounded bg-surface-muted ${w}`} style={pulse()} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
