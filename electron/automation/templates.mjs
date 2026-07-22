/**
 * Starter workflow templates.
 *
 * A blank canvas teaches nothing: the concepts that matter here — one step feeding the next, running
 * a step once per item, pausing for approval — are far easier to read from a working example than to
 * assemble from an empty editor.
 *
 * Deliberately **AI-step-first**, with no shell commands. Most people cannot write shell, and an
 * example built from commands would teach the wrong default: the agent runtime already has file,
 * search and fetch tools, so "ask the AI to save this to a file" covers the same ground in words the
 * user actually understands.
 *
 * Lives in the main process (no `electron` import) so the same validateDefinition() that gates a
 * save also covers these — a shipped template that fails validation would be a bad first impression,
 * and there is a test asserting every template validates.
 */

export const TEMPLATE_IDS = ["blank", "digest", "actions", "article", "stocks", "intel"];

/**
 * Build a template definition.
 * @param {string} templateId one of TEMPLATE_IDS
 * @param {{ id: string, name: string }} opts  workflow id + display name (already translated)
 * @returns {object|null} a definition ready to save, or null for an unknown template
 */
export function buildTemplate(templateId, { id, name }) {
  const base = {
    id,
    name,
    triggers: [{ id: "manual", type: "manual", config: {} }],
    // Every template ships with a ceiling. A starter workflow is exactly what gets edited into
    // something bigger and left running, and an unbounded one is how that becomes a surprise bill.
    limits: { concurrency: "single", maxTokens: 200_000 },
  };

  switch (templateId) {
    case "blank":
      return {
        ...base,
        nodes: [
          {
            id: "step1",
            runtime: "agent",
            config: { prompt: "Write a short haiku about automation." },
            inputs: [],
            position: { x: 40, y: 0 },
          },
        ],
        edges: [],
      };

    /* Two chained AI steps: the smallest example that shows output flowing between steps. */
    case "digest":
      return {
        ...base,
        variables: [
          { key: "topic", type: "string", default: "AI research", label: "Topic to follow" },
        ],
        nodes: [
          {
            id: "research",
            runtime: "agent",
            config: {
              prompt:
                "Search the web for news about {{inputs.topic}} from the last 7 days. " +
                "Pick the 5 most important items and summarize each in two sentences.",
            },
            inputs: [{ as: "topic", ref: "var://topic" }],
            position: { x: 40, y: 0 },
          },
          {
            id: "save",
            runtime: "agent",
            config: {
              prompt:
                "Save the following digest to a file named digest.md in the working folder, " +
                "then reply with the file path:\n\n{{inputs.summary}}",
            },
            // This binding is what makes step 2 read step 1's result.
            inputs: [{ as: "summary", ref: "run://research/text" }],
            position: { x: 40, y: 140 },
          },
        ],
        edges: [{ from: "research", to: "save" }],
      };

    /* The full shape: a required file input, fan-out over results, and approval before anything is
       written.

       Modelled on turning meeting notes into actions, because it is the rare automation that earns
       its keep on the first run: everyone already has the input file, everyone already owes someone
       this output, and nobody enjoys doing it. It is also the one job on this list where an agent's
       weakness is visible and containable -- a model will happily invent an owner and a deadline, so
       the middle step is built around separating what the notes SAY from what it inferred, and the
       last step will not write anything until a human has read the difference. */
    case "actions":
      return {
        ...base,
        variables: [
          { key: "notes", type: "file", required: true, label: "Meeting notes or transcript" },
          {
            key: "owner",
            type: "string",
            default: "me",
            label: "Who owns anything the notes leave unassigned",
          },
        ],
        nodes: [
          {
            id: "extract",
            runtime: "agent",
            config: {
              system: "You extract what was said. You never improve on it.",
              prompt:
                "Read the meeting notes at {{inputs.notes}}.\n\n" +
                "Pull out every commitment — anything someone said they would do. Skip discussion, " +
                "opinions and decisions that carry no action.\n" +
                'For each one quote the line it came from, so the next step can check you.\n' +
                'Reply with ONLY a JSON array of {"task":"…","owner":"…or null","due":"…or null",' +
                '"quote":"…"}. Use null rather than guessing. No preamble, no code fence.',
              // Reads one local file. No network, no writes -- an extraction step that can reach the
              // web is an extraction step that can start filling gaps with things it found there.
              toolPolicy: { allow: ["read_file"] },
            },
            inputs: [{ as: "notes", ref: "var://notes" }],
            position: { x: 40, y: 0 },
          },
          {
            id: "expand",
            runtime: "agent",
            config: {
              prompt:
                "Commitment: {{inputs.item}}\n\n" +
                "Turn it into something someone can actually pick up:\n" +
                "- the first concrete step\n" +
                "- who owns it (use {{inputs.owner}} only if the notes truly name nobody)\n" +
                "- when it is due, if a date was actually said\n" +
                "- what is unclear and would need asking\n\n" +
                "Mark every field as either STATED (it is in the quote) or ASSUMED (you filled it in). " +
                "An honest ASSUMED is worth more here than a confident guess.",
              toolPolicy: { deny: ["write_file", "edit_file", "run_command"] },
            },
            inputs: [{ as: "owner", ref: "var://owner" }],
            // One pass per commitment. The cap matters: the list comes from a model, so without it a
            // bad answer could fan out into hundreds of paid calls.
            forEach: "run://extract/text",
            maxItems: 25,
            // A meeting where one item cannot be worked out is not a meeting with no actions.
            onItemError: "continue",
            position: { x: 40, y: 140 },
          },
          {
            id: "save",
            runtime: "agent",
            config: {
              prompt:
                "Write these up as actions.md in the working folder — a checklist, owner and date on " +
                "each line, and a clearly separated section at the end for anything marked ASSUMED or " +
                "unclear, so it can be confirmed with the room.\n" +
                "Reply with the file path.\n\n{{inputs.actions}}",
              toolPolicy: { allow: ["read_file", "write_file"] },
            },
            inputs: [{ as: "actions", ref: "run://expand/items" }],
            // Nothing is written until a human has seen exactly what it says -- which here is also
            // the moment the ASSUMED fields get caught, before they harden into someone's to-do list.
            requiresApproval: true,
            approvalTimeoutMs: 24 * 60 * 60 * 1000,
            position: { x: 40, y: 280 },
          },
        ],
        edges: [
          { from: "extract", to: "expand" },
          { from: "expand", to: "save" },
        ],
      };

    /* Audience research to platform-ready drafts.

       The fan-out here is over a VARIABLE, not over a model's answer: each platform's layout rules
       live in an editable json variable, so adding LinkedIn is a line of JSON rather than a new step
       and a new prompt. That is also what makes the "layout" part real — the constraints are data
       the user can correct, not paragraphs buried in a prompt where nobody will find them.

       It stops at files ready to post. The engine has no X or Reddit credentials and no posting
       tool, so a step claiming to publish would be a step that quietly does nothing. */
    case "article":
      return {
        ...base,
        limits: { concurrency: "single", maxTokens: 600_000, maxCostUsd: 2 },
        variables: [
          { key: "topic", type: "string", default: "local-first software", label: "What are you writing about?" },
          {
            key: "audience",
            type: "string",
            default: "indie developers shipping their first desktop app",
            label: "Who is it for?",
          },
          // A json variable rather than prose in a prompt: this is the knob most likely to be
          // edited, and the one most likely to be wrong a year from now when a limit changes.
          {
            key: "platforms",
            type: "json",
            label: "Platforms and their layout rules",
            default: [
              {
                platform: "X",
                format: "thread",
                perPostChars: 280,
                rules:
                  "Post 1 is a hook that stands alone and makes no promise the thread does not keep. " +
                  "One idea per post. No thread-length announcement. Links only in the final post, " +
                  "because early links suppress reach.",
              },
              {
                platform: "Reddit",
                format: "self post",
                titleMaxChars: 300,
                rules:
                  "Title is a plain statement or a real question, never clickbait. Answer it in the " +
                  "first paragraph — a reader must get value without clicking anything. Markdown body, " +
                  "no marketing voice, disclose that you built the thing, and end with a question you " +
                  "genuinely want answered.",
              },
            ],
          },
        ],
        nodes: [
          {
            id: "listen",
            runtime: "agent",
            config: {
              system: "You report what people actually said. Quote them; do not paraphrase into agreement.",
              prompt:
                "Audience: {{inputs.audience}}\nSubject area: {{inputs.topic}}\n\n" +
                "Find where these people are already asking for help — forum threads, Reddit posts, " +
                "issue trackers, Q&A sites — and collect the questions they ask in their own words.\n" +
                "Prefer a question asked five times badly over one asked once eloquently: frequency is " +
                "the signal, phrasing is not.\n" +
                'Reply with ONLY a JSON array of {"need":"…","theirWords":"…","url":"…","seenTimes":1}. ' +
                "No preamble, no code fence.",
              maxRounds: 16,
              toolPolicy: { allow: ["web_search", "fetch_url"] },
            },
            inputs: [
              { as: "topic", ref: "var://topic" },
              { as: "audience", ref: "var://audience" },
            ],
            retry: { attempts: 2, delayMs: 3_000, backoff: "exponential" },
            timeoutMs: 8 * 60 * 1000,
            position: { x: 40, y: 0 },
          },
          {
            id: "angle",
            runtime: "agent",
            config: {
              prompt:
                "Here is what the audience is actually asking:\n\n{{inputs.needs}}\n\n" +
                "Pick the ONE need with the most evidence behind it that you can answer concretely. " +
                "Not the most interesting — the most asked.\n" +
                "Then outline an article that answers it: the promise in one sentence, the four or five " +
                "sections, and for each section the specific thing it teaches. Name what you are " +
                "deliberately leaving out.",
              toolPolicy: { deny: ["write_file", "edit_file", "run_command"] },
            },
            inputs: [{ as: "needs", ref: "run://listen/text" }],
            position: { x: 40, y: 140 },
          },
          {
            id: "draft",
            runtime: "agent",
            config: {
              system:
                "Write like someone who has done the thing, for someone about to do it. No throat-clearing, " +
                "no 'in today's fast-paced world', no summary of what you are about to say.",
              prompt:
                "Write the article from this outline:\n\n{{inputs.outline}}\n\n" +
                "Markdown. Open with the reader's actual problem in their own words. Every claim gets a " +
                "concrete example. If a step has a failure mode, say what it looks like when it fails.\n" +
                "Reply with the article only.",
              maxRounds: 6,
              toolPolicy: { deny: ["write_file", "edit_file", "run_command"] },
            },
            inputs: [{ as: "outline", ref: "run://angle/text" }],
            timeoutMs: 8 * 60 * 1000,
            position: { x: 40, y: 280 },
          },
          {
            id: "adapt",
            runtime: "agent",
            config: {
              prompt:
                "Target platform and its layout rules:\n{{inputs.item}}\n\n" +
                "Article:\n\n{{inputs.article}}\n\n" +
                "Rewrite it to sit natively on that platform, obeying every field above — the character " +
                "limits are limits, not suggestions, so count them.\n" +
                "This is a rewrite, not a trim: a thread is not the article with line breaks, and a " +
                "Reddit post that reads like a press release gets removed by a moderator.\n" +
                "Label each part so it can be pasted in order (POST 1/n, or TITLE / BODY).",
              toolPolicy: { deny: ["write_file", "edit_file", "run_command"] },
            },
            inputs: [{ as: "article", ref: "run://draft/text" }],
            // Over the variable, so the set of platforms is configuration rather than graph shape.
            forEach: "var://platforms",
            maxItems: 6,
            onItemError: "continue",
            position: { x: 40, y: 420 },
          },
          {
            id: "save",
            runtime: "agent",
            config: {
              prompt:
                "Save these to the working folder: the full article as article.md, and one file per " +
                "platform named after it (article-x.md, article-reddit.md, …) containing only what gets " +
                "pasted there.\n" +
                "Reply with the list of paths.\n\n{{inputs.versions}}",
              toolPolicy: { allow: ["read_file", "write_file"] },
            },
            inputs: [{ as: "versions", ref: "run://adapt/items" }],
            // The last checkpoint before this becomes something you paste in public under your name.
            requiresApproval: true,
            approvalTimeoutMs: 24 * 60 * 60 * 1000,
            onApprovalTimeout: "reject",
            position: { x: 40, y: 560 },
          },
        ],
        edges: [
          { from: "listen", to: "angle" },
          { from: "angle", to: "draft" },
          { from: "draft", to: "adapt" },
          { from: "adapt", to: "save" },
        ],
      };

    /* Stock research.

       Built around the one thing a language model is worst at and this task needs most: numbers it
       did not look up. Every figure has to arrive with a source and a date, `verify` exists purely to
       throw out the ones that did not, and the brief is instructed to state what would change its
       mind. It produces research to argue with, not a recommendation to act on — the prompts say so,
       and the saved file says so, because the file is what gets reread six months later. */
    case "stocks":
      return {
        ...base,
        limits: { concurrency: "single", maxTokens: 800_000, maxCostUsd: 3 },
        variables: [
          { key: "tickers", type: "json", default: ["AAPL", "MSFT"], label: "Tickers to look at" },
          {
            key: "question",
            type: "string",
            default: "How durable is each company's core revenue over the next two quarters?",
            label: "What are you actually trying to decide?",
          },
        ],
        nodes: [
          {
            id: "gather",
            runtime: "agent",
            config: {
              system:
                "You are a research assistant with no memory of prices. Every number you report was " +
                "read from a page during this task, or it is null. You never estimate a figure.",
              prompt:
                "Ticker: {{inputs.item}}\n\n" +
                "Look up, from primary sources where possible (company filings, investor relations, " +
                "the exchange) and reputable financial sites otherwise:\n" +
                "- last close and the date of that close\n" +
                "- market cap\n" +
                "- most recent reported quarter: revenue, growth vs the year-ago quarter, margin\n" +
                "- guidance or outlook language from the last earnings release\n" +
                "- anything in the last 90 days that a holder would want to know\n\n" +
                "Every single figure carries the URL it came from and the date it refers to. A figure " +
                "you could not source is null with a note saying so — that is a correct answer here, " +
                "and far more useful than a plausible one.\n" +
                'Reply with ONLY JSON: {"ticker":"…","asOf":"YYYY-MM-DD","figures":[{"name":"…",' +
                '"value":"…or null","asOf":"…","source":"https://…"}],"notes":"…"}. No code fence.',
              maxRounds: 16,
              toolPolicy: { allow: ["web_search", "fetch_url"] },
            },
            inputs: [],
            forEach: "var://tickers",
            maxItems: 12,
            // One unreachable ticker should not cost you the other eleven.
            onItemError: "continue",
            retry: { attempts: 3, delayMs: 5_000, backoff: "exponential" },
            timeoutMs: 12 * 60 * 1000,
            position: { x: 40, y: 0 },
          },
          {
            id: "verify",
            runtime: "agent",
            config: {
              system: "Your job is to find what is wrong. A clean report you did not check is a failure.",
              prompt:
                "Research to audit:\n\n{{inputs.data}}\n\n" +
                "For every figure, check three things: it has a source URL, that URL plausibly reports " +
                "that figure, and its date is recent enough to still mean something. Open the ones that " +
                "matter most rather than trusting the citation.\n" +
                "Strike out anything that fails. Do not repair it by looking up a replacement — a figure " +
                "that survived scrutiny and a figure that was quietly swapped in look identical later.\n" +
                'Reply with the same JSON structure plus, per figure, "verified": true/false and a reason ' +
                "when false.",
              maxRounds: 14,
              // Read-only on purpose: an auditor that can also write is an auditor that can rewrite
              // the thing it was auditing.
              toolPolicy: { allow: ["fetch_url"] },
            },
            inputs: [{ as: "data", ref: "run://gather/items" }],
            timeoutMs: 10 * 60 * 1000,
            position: { x: 40, y: 140 },
          },
          {
            id: "brief",
            runtime: "agent",
            config: {
              prompt:
                "Question to answer: {{inputs.question}}\n\n" +
                "Verified research:\n\n{{inputs.checked}}\n\n" +
                "Write the brief. Use only figures marked verified, and say plainly where the gaps are — " +
                "a comparison missing half its data is worth reading only if it admits which half.\n" +
                "Structure: the answer to the question first, then the evidence per company, then " +
                "**What would change this view** — the specific, checkable events that would make this " +
                "wrong. That section is the point of the exercise.\n" +
                "End with: this is research, assembled by a language model from public sources, not " +
                "investment advice; verify every figure before acting on it.",
              toolPolicy: { deny: ["write_file", "edit_file", "run_command"] },
            },
            inputs: [
              { as: "checked", ref: "run://verify/text" },
              { as: "question", ref: "var://question" },
            ],
            timeoutMs: 8 * 60 * 1000,
            position: { x: 40, y: 280 },
          },
          {
            id: "save",
            runtime: "agent",
            config: {
              prompt:
                "Save this to stock-brief.md in the working folder, keeping the source links and the " +
                "closing note intact, and reply with the path:\n\n{{inputs.brief}}",
              toolPolicy: { allow: ["read_file", "write_file"] },
            },
            inputs: [{ as: "brief", ref: "run://brief/text" }],
            // A saved brief outlives the session that produced it and gets reread as if it were fact.
            // The gate is where a human decides it is worth keeping in that form.
            requiresApproval: true,
            approvalTimeoutMs: 24 * 60 * 60 * 1000,
            onApprovalTimeout: "reject",
            position: { x: 40, y: 420 },
          },
        ],
        edges: [
          { from: "gather", to: "verify" },
          { from: "verify", to: "brief" },
          { from: "brief", to: "save" },
        ],
      };

    /* The deep end. Everything the engine can do, in one chain that still reads as one job:
       optional and required inputs, capped fan-out with per-item retry, cross-item synthesis,
       per-node tool policy, a wait for an outside reply, and approval before anything is written.

       Deliberately a domain with none of this app in it — the point is to show the *shape* of a
       hard workflow, not to demo a feature of the product it happens to run in. */
    case "intel":
      return {
        ...base,
        limits: {
          concurrency: "single",
          // Six steps, one of them fanned out eight ways, all of them web research: the digest
          // template's 200k ceiling would stop this one halfway and look like a crash.
          maxTokens: 1_500_000,
          maxCostUsd: 5,
          // No maxDurationMs on purpose. It is wall-clock from run start (policyGuard.mjs), and the
          // review step can legitimately sit idle for two days waiting for a person — any duration
          // ceiling honest enough to cover that is too loose to bound anything.
        },
        variables: [
          {
            key: "market",
            type: "string",
            default: "project management software",
            label: "Market or product category",
          },
          // Blank on purpose: the first step infers the field when you do not name it, which is the
          // more useful default when you are looking at a market you do not know well yet.
          {
            key: "rivals",
            type: "string",
            default: "",
            label: "Competitors to track (comma-separated, or leave blank)",
          },
          { key: "lookbackDays", type: "number", default: 14, label: "How far back to look (days)" },
          // Required, so the run dialog makes you pick it. Without your own positioning the analysis
          // can only say what changed, never whether it matters to you.
          { key: "positioning", type: "file", required: true, label: "Your positioning or product one-pager" },
          {
            key: "reviewer",
            type: "string",
            default: "me",
            label: "Who signs off on the draft",
          },
        ],
        nodes: [
          {
            id: "scope",
            runtime: "agent",
            config: {
              system: "You are a market analyst. You answer with data, not adjectives.",
              prompt:
                "Market: {{inputs.market}}\nCompetitors named by the user: {{inputs.rivals}}\n\n" +
                "If no competitors were named, find the 5 most significant players in this market. " +
                "Otherwise use exactly the ones named.\n" +
                "For each, decide the single most informative thing to check in the last {{inputs.days}} days " +
                "(pricing page, changelog, hiring, funding, docs — whatever moves first for that company).\n" +
                "Budget: at most one search per competitor. This step decides *what* to look at; the " +
                "next step does the actual reading.\n" +
                'Reply with ONLY a JSON array of {"competitor":"…","angle":"…","startingUrl":"…"}. ' +
                "No preamble, no code fence, no other text.",
              // Five competitors at a search each, plus room to recover from a bad result and still
              // answer. A ceiling that only just covers the happy path fails on the first hiccup.
              maxRounds: 18,
              // Research, not filesystem work. Scoping this per node rather than per workflow is the
              // point: the step that writes the report needs write_file, this one must not have it.
              toolPolicy: { allow: ["web_search", "fetch_url"] },
            },
            inputs: [
              { as: "market", ref: "var://market" },
              { as: "rivals", ref: "var://rivals" },
              { as: "days", ref: "var://lookbackDays" },
            ],
            // Search APIs fail transiently far more often than models do; one immediate retry turns
            // most of that into a slower run instead of a dead one.
            retry: { attempts: 2, delayMs: 2_000, backoff: "exponential" },
            timeoutMs: 5 * 60 * 1000,
            position: { x: 40, y: 0 },
          },
          {
            id: "dig",
            runtime: "agent",
            config: {
              system: "Report only what a source actually says. If you cannot find it, say so.",
              prompt:
                "Research target: {{inputs.item}}\nWindow: the last {{inputs.days}} days.\n\n" +
                "Find what actually changed in that window. Read the sources; do not guess from the " +
                "company name.\n" +
                'Reply with ONLY JSON: {"competitor":"…","changes":[{"what":"…","when":"…","url":"…"}],' +
                '"nothingFound":false}. An empty changes list with nothingFound:true is a valid, useful answer.',
              maxRounds: 14,
              toolPolicy: { allow: ["web_search", "fetch_url"] },
            },
            inputs: [{ as: "days", ref: "var://lookbackDays" }],
            // One research pass per target from the step above. maxItems is the wallet guard: the
            // list is model-generated, so a bad answer must not turn into fifty paid research runs.
            forEach: "run://scope/text",
            maxItems: 8,
            // One competitor being un-researchable is not a reason to lose the other seven; the
            // synthesis step is told how many landed so a thin briefing is visibly thin.
            onItemError: "continue",
            retry: { attempts: 3, delayMs: 5_000, backoff: "exponential" },
            timeoutMs: 10 * 60 * 1000,
            position: { x: 40, y: 140 },
          },
          {
            id: "synthesize",
            runtime: "agent",
            config: {
              prompt:
                "Here is this period's research on {{inputs.market}} — {{inputs.count}} competitor(s) came " +
                "back:\n\n{{inputs.findings}}\n\n" +
                "Read my positioning document at {{inputs.positioning}}.\n\n" +
                "Now do the part a per-competitor summary cannot: look across all of them at once.\n" +
                "1. Which changes are the same move by different companies (a trend), and which is one " +
                "company acting alone?\n" +
                "2. Which of them touch a claim my positioning document depends on?\n" +
                "3. What is the single most consequential thing here, and what would make it wrong?\n" +
                "Be explicit about how much of this rests on few sources.",
              maxRounds: 8,
              // Reads the user's document; must not reach back out to the network or write anything.
              toolPolicy: { allow: ["read_file"] },
            },
            inputs: [
              { as: "findings", ref: "run://dig/items" },
              { as: "count", ref: "run://dig/count" },
              { as: "positioning", ref: "var://positioning" },
              { as: "market", ref: "var://market" },
            ],
            timeoutMs: 5 * 60 * 1000,
            position: { x: 40, y: 280 },
          },
          {
            id: "draft",
            runtime: "agent",
            config: {
              prompt:
                "Turn this analysis into a briefing someone will read in three minutes:\n\n{{inputs.analysis}}\n\n" +
                "Markdown. Lead with the one thing that matters, then the trend, then per-competitor " +
                "detail, then what you are unsure about. Every claim keeps its source link.\n" +
                "Reply with the briefing itself and nothing else — it is not being saved yet.",
              // Pure writing. Deny is the right shape here: this step has no business touching disk or
              // the shell no matter what the draft text talks the model into.
              toolPolicy: { deny: ["write_file", "edit_file", "run_command"] },
            },
            inputs: [{ as: "analysis", ref: "run://synthesize/text" }],
            timeoutMs: 5 * 60 * 1000,
            position: { x: 40, y: 420 },
          },
          {
            id: "review",
            runtime: "agent",
            config: {
              prompt:
                "Draft briefing:\n\n{{inputs.draft}}\n\n" +
                "Reviewer notes:\n{{inputs.event}}\n\n" +
                "Fold the notes into the draft and reply with the revised briefing.\n" +
                "If the notes section above still shows a literal {{ }} placeholder, no notes arrived " +
                "before the deadline — reply with the draft unchanged.",
              toolPolicy: { deny: ["write_file", "edit_file", "run_command"] },
            },
            inputs: [
              { as: "draft", ref: "run://draft/text" },
              { as: "market", ref: "var://market" },
              { as: "reviewer", ref: "var://reviewer" },
            ],
            // Suspend until someone sends this key in. The run is checkpointed and the app can be
            // closed and reopened meanwhile. The key is scoped by market so two briefings running for
            // different categories do not answer each other's wait.
            waitFor: {
              key: "brief-review/{{market}}",
              timeoutMs: 48 * 60 * 60 * 1000,
              // A reviewer who is on holiday should cost you a rougher briefing, not the whole run.
              onTimeout: "continue",
            },
            timeoutMs: 5 * 60 * 1000,
            position: { x: 40, y: 560 },
          },
          {
            id: "publish",
            runtime: "agent",
            config: {
              prompt:
                "Save this briefing to competitive-brief.md in the working folder, then reply with the " +
                "file path and a one-line summary of what changed this period:\n\n{{inputs.brief}}",
              toolPolicy: { allow: ["read_file", "write_file"] },
            },
            inputs: [{ as: "brief", ref: "run://review/text" }],
            // The only step that writes, so it is the only step that needs a human. Everything above
            // it can be re-run for free; this is where a run stops being reversible.
            requiresApproval: true,
            approvalTimeoutMs: 24 * 60 * 60 * 1000,
            // Explicit: an unanswered gate must not publish on a timer. A briefing nobody approved is
            // exactly the one that should not land in the folder people trust.
            onApprovalTimeout: "reject",
            position: { x: 40, y: 700 },
          },
        ],
        edges: [
          { from: "scope", to: "dig" },
          { from: "dig", to: "synthesize" },
          { from: "synthesize", to: "draft" },
          { from: "draft", to: "review" },
          { from: "review", to: "publish" },
        ],
      };

    default:
      return null;
  }
}
