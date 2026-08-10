/** ask_user / update_todos / openBrowser tool declarations (OpenAI-compatible, handled by the render layer). */
/** Tool declaration for opening the built-in browser (OpenAI-compatible). Handled by the render layer; expands the browser panel on the right.
 *  The description is mode-specific: in dev mode the browser is off-limits unless the user asks for it, because opening it to
 *  investigate or to show off a fix is pure latency — the model cannot see the page, so it learns nothing the code wouldn't tell it.
 *  In daily mode it stays available for pages that genuinely cannot be read headlessly (login / interaction / JS rendering). */
export function openBrowserTool(mode: "daily" | "dev" = "daily") {
  const description =
    mode === "dev"
      ? "Open the app's built-in browser panel and (optionally) visit a given URL. " +
        "IN THIS MODE THIS TOOL IS OFF-LIMITS. Do not call it unless the user explicitly asked you to open a browser " +
        "or to show them a page — that request is the ONLY thing that permits it. " +
        "It is not permitted for investigating a problem, reproducing a bug, checking your progress, confirming a fix " +
        "looks right, or presenting a finished result. None of those are reasons: you cannot see the page, so it tells " +
        "you nothing, while the user waits. The code, the file, the error message and check_project give you the real " +
        "answer, faster. If you believe the user would want to look at the page, finish the work, say so, and let them ask. " +
        "For looking anything up, use web_search (results come back directly, no browser) and fetch_url to read a result. " +
        "Under no circumstances use run_command to launch the system browser."
      : "Open the app's built-in browser panel and (optionally) visit a given URL. " +
        "Only call this when the user explicitly wants to watch you work in a browser, or when a page genuinely cannot be " +
        "read any other way (it needs interaction, a login, or JavaScript rendering). " +
        "Looking something up is NOT a reason to open it: use web_search (results come back directly, no browser), " +
        "then fetch_url to read a result — that is faster and needs no browser. " +
        "Under no circumstances use run_command to launch the system browser.";
  return {
    type: "function" as const,
    function: {
      name: "openBrowser",
      description,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            // No example search URL here: it used to be edition-dependent (Google vs Baidu), which made the tool block — and so
            // the whole prompt prefix on templates that render tools first — differ between the international and China builds.
            description: "The URL to visit; it may be a search-engine URL with a query. Omit to just open the browser.",
          },
        },
        required: [],
      },
    },
  };
}

/** Tool declaration for controlling the built-in browser (drives the current page via CDP / puppeteer). */
export function browserTool() {
  return {
    type: "function" as const,
    function: {
      name: "browser",
      description:
        "Control the already-open built-in browser (drives the current page via CDP) — this is how you 'take over' the browser to click / read pages. " +
        "Open a page with openBrowser first, then interact with it using this tool. action values: " +
        "read = read the visible text of the current page; links = list the page's links (with index i / text / href); " +
        "click = click an element (pass selector or text); type = type into an input (pass selector + text; optionally clear to empty it first, submit to press Enter); " +
        "navigate = go to url; eval = evaluate a JS expression in the page context (pass expr) and return the result; " +
        "a11y = export the accessibility tree (role/name/state, handy for locating elements; pass root to limit to a subtree, full to include secondary nodes); " +
        "list = list open pages/tabs (url); shot = take a screenshot (pass path, full for the whole page). " +
        "Typical 'open the Nth result': first use links to get the list, then navigate to the Nth item's href (or use click + text).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["read", "links", "click", "type", "navigate", "eval", "a11y", "list", "shot"],
            description: "The page action to perform.",
          },
          url: { type: "string", description: "The target URL for navigate." },
          selector: { type: "string", description: "CSS selector for click / type." },
          text: { type: "string", description: "For click, matches by visible text; for type, the text to enter." },
          clear: { type: "boolean", description: "Whether to clear the input before type." },
          submit: { type: "boolean", description: "Whether to press Enter to submit after type." },
          expr: { type: "string", description: "The JS expression for eval to evaluate in the page context." },
          root: { type: "string", description: "CSS selector of the root element to scope the a11y snapshot." },
          full: { type: "boolean", description: "For a11y, include secondary nodes; for shot, capture the whole page." },
          path: { type: "string", description: "Save path for shot (defaults to a temp directory)." },
          max: { type: "number", description: "Maximum number of links to return (default 40)." },
        },
        required: ["action"],
      },
    },
  };
}

/** Tool declaration for asking the user to make a choice (OpenAI-compatible). Handled by the render layer, without going through the main process. */
export function askUserTool() {
  return {
    type: "function" as const,
    function: {
      name: "ask_user",
      description:
        "Call this when the user needs to decide something: pass one or more questions with the options you " +
        "recommend, and the UI renders them as a card of clickable options, automatically appending a " +
        "'Discuss this' item to each. It returns what the user picked. " +
        "Prefer this over merely listing options in your reply when you are seeking a decision (a colour " +
        "scheme, a plan, a direction to take). " +
        "Ask several questions in ONE call when they are all part of the same decision — they become tabs on a " +
        "single card and the user answers them together, which is far less disruptive than being asked, " +
        "answering, and then immediately being asked again. Do not use it to ask the same thing twice, and do " +
        "not split one decision across consecutive calls. " +
        // The screenshot case: the model wrote options like "My first name (type it)" because it had no way
        // to ask for text, turning an option into an instruction the card could not carry out.
        "Every question also gets a free-text box automatically, so the user can always answer in their own " +
        "words. Options should therefore be real choices — never write an option that tells the user to type " +
        "something, and do not add an 'Other' option. " +
        // Without this, "which of these do you want?" had to be asked as one yes/no question per item, or as
        // one question whose options were guessed combinations of the real ones.
        "Set multiSelect on a question whose options are not mutually exclusive — features to enable, files to " +
        "include, topics to cover — and the user can tick several; leave it off for a genuine either/or.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            description:
              "The questions to put to the user, all at once. Only genuinely related questions belong in one " +
              "call — the user answers every one of them before anything comes back to you.",
            items: {
              type: "object",
              properties: {
                question: { type: "string", description: "The question to ask." },
                options: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "The options you recommend (2-4, short). Do not include 'Discuss this'; the system " +
                    "appends it automatically.",
                },
                multiSelect: {
                  type: "boolean",
                  description:
                    "True if the user may pick several of these options at once (they are not mutually " +
                    "exclusive). Defaults to false — exactly one option. Do not add a 'Submit' or 'Done' " +
                    "option; the card provides one.",
                },
              },
              required: ["question", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
  };
}

/** Tool declaration for writing a memory (OpenAI-compatible). Handled by the render layer; writes a single memory as its own Markdown file. */
/**
 * Tool declaration for text-to-image (OpenAI-compatible).
 *
 * Prompt-only by design (docs/generation-capabilities-design.md §4.1): there are no size/quality/
 * style parameters, so any look the user asks for has exactly one route into the request — the
 * prompt text. Hence the instruction to fold it in.
 *
 * The engine is NOT chosen here. It is derived from the user's configured API keys
 * (generation/registry.ts selectEngine): their chat vendor first, then any vendor they hold a key
 * for. The model neither knows nor picks it.
 */
export function imageGenerationTool() {
  return {
    type: "function" as const,
    function: {
      name: "image_generation",
      description:
        "Generate an image from a text description. Use this when the user asks you to create, draw, generate, or design a picture, illustration, poster, logo, icon, or any other visual. " +
        "Do NOT use it to find images that already exist — use web_search for that. " +
        "Takes 5-20 seconds. Call it once per image the user asks for; do not call it speculatively to 'preview' an idea.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "A vivid, self-contained description of the image: subject, setting, lighting, composition and style. " +
              "Expand the user's request into a full scene rather than quoting it back. " +
              "There are no separate parameters for shape, quality or style, so fold everything the user asked for into these words " +
              "(e.g. \"a wide 16:9 cinematic shot of…\", \"in soft watercolour…\", \"photorealistic, shallow depth of field…\").",
          },
        },
        required: ["prompt"],
      },
    },
  };
}

export function saveMemoryTool() {
  return {
    type: "function" as const,
    function: {
      name: "save_memory",
      description:
        "Write information worth remembering long-term into the memory store (each memory is saved as its own Markdown file, kept across sessions). " +
        "Good for recording the user's stable preferences, identity/facts, long-term goals, agreements, important decisions, and so on; " +
        "do not record one-off small talk or transient context. When an existing memory needs updating, pass its id to overwrite it rather than adding a new one.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "A short title for the memory (a one-sentence summary, used as the file title).",
          },
          content: {
            type: "string",
            description: "The memory body (Markdown). Use concise third-person statements; clearly capture reusable facts/preferences/agreements.",
          },
          id: {
            type: "string",
            description: "Optional: the id of an existing memory to update (from the injected memory list). Omit to create a new one.",
          },
        },
        required: ["title", "content"],
      },
    },
  };
}

/** Tool declaration for deleting a memory (OpenAI-compatible). Handled by the render layer; permanently deletes the corresponding Markdown file by id. */
export function deleteMemoryTool() {
  return {
    type: "function" as const,
    function: {
      name: "delete_memory",
      description:
        "Permanently delete a saved memory (deletes its Markdown file by id). Call this when the user asks to delete / forget a memory, " +
        "or when a memory has permanently become invalid. Note: this is a real deletion — do not fake it by using save_memory to change the content to 'deleted'.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The id of the memory to delete (the id shown in square brackets in the injected memory list).",
          },
        },
        required: ["id"],
      },
    },
  };
}

/** Tool declaration for searching memories (OpenAI-compatible). Handled by the render layer: on call, it reads the current memory files and returns the full text of relevant memories by query. */
export function searchMemoryTool() {
  return {
    type: "function" as const,
    function: {
      name: "search_memory",
      description:
        "Search the memories you keep long-term for the user (one Markdown file each, kept across sessions, and possibly added / modified during this conversation). " +
        "Pass a one-sentence query to get the full text of the most relevant memories; omit the query to return all (newest first). " +
        "This tool reads the current memory files on every call, so the results are always up to date. " +
        "Call it when you need to recall the user's identity / preferences / facts / agreements, or when the user asks 'do you remember…', 'I told you…', 'what do you know about me'; " +
        "especially after the user says they just added / changed a memory, be sure to call this tool to read the latest state rather than answering from the stale snapshot taken at the start of the conversation.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "A one-sentence query / keywords to search with; omit or leave empty to return all memories (newest first).",
          },
          limit: { type: "number", description: "Maximum number to return (default 20)." },
        },
        required: [],
      },
    },
  };
}

/** Tool declaration for the task checklist (OpenAI-compatible). Handled by the render layer; pinned above the input box. */
/**
 * set_task_state — record your mission state (Task Memory) for YOURSELF. This brief is pinned into your
 * context every turn and preserved verbatim across compaction, so it is where the plan/goal/constraints
 * must live to survive a long task. It is internal working memory: it is NOT shown to the user (that is what
 * update_todos is for), so write it for your own recall, not as a user-facing report.
 */
export function setTaskStateTool() {
  return {
    type: "function" as const,
    function: {
      name: "set_task_state",
      description:
        "Record your mission brief for your OWN recall — the plan, goal, key decisions and hard constraints for this task. " +
        "It is pinned into your context and preserved verbatim across compaction, so you will not forget the task. INTERNAL working " +
        "memory: NOT shown to the user (use update_todos for a user-facing checklist).\n" +
        "Call this SPARINGLY — usually just ONCE, right after you form the plan. Call it again ONLY if the goal or overall approach " +
        "MATERIALLY changes (a new objective, an abandoned strategy, a newly-stated hard constraint). Do NOT call it for routine " +
        "progress, after every step, or for minor wording tweaks — the brief already stays in your context, so re-recording it each " +
        "turn is wasteful and unnecessary. When you do call it, pass the full brief (it overwrites the previous one).",
      parameters: {
        type: "object",
        properties: {
          notes: {
            type: "string",
            description:
              "The task brief in your own words: the mission/goal, the plan or phases, hard constraints, and key decisions + why. Markdown is fine. Overwrites the previous brief.",
          },
        },
        required: ["notes"],
      },
    },
  };
}

/**
 * The dispatcher for tools listed in the catalog but not declared here (see src/lib/ai/toolRouter.ts).
 *
 * Wording is doing real work in two places. It says the catalog is COMPLETE, because the failure this design cannot afford is a
 * discovery round trip: a model call costs 50-80K prompt tokens against the ~1,800 the whole change saves per call, so one "which
 * tools do I have?" exchange would undo the saving for the next thirty calls. And it points at the catalog's signatures, because a
 * routed tool's parameters are not on the wire — the signature is all the model has to go on until a call actually fails.
 *
 * No `enum` of tool names in the parameters. llama.cpp re-serialises tool `parameters` through an order-preserving JSON parser, so
 * an enum would put a per-build list into the frozen prefix bytes; loadSkillTool avoids it for the same reason.
 */
export function callToolTool() {
  return {
    type: "function" as const,
    function: {
      name: "call_tool",
      description:
        "Invoke a tool that is listed in the tool catalog in your system prompt but is not declared in this tool list. " +
        "Pass the tool's exact name from the catalog and its arguments, named as its catalog signature shows. " +
        "This PERFORMS the call — there is no separate discovery or loading step, and no need to ask which tools exist: " +
        "the catalog is the complete list. If a call is rejected, the reply tells you the tool's full parameters; fix them and call again.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The tool's exact name, exactly as written in the tool catalog.",
          },
          arguments: {
            type: "object",
            description:
              "The tool's arguments, using the parameter names from its catalog signature. Pass an empty object for a tool that takes none.",
          },
        },
        required: ["name", "arguments"],
      },
    },
  };
}

export function updateTodosTool() {
  return {
    type: "function" as const,
    function: {
      name: "update_todos",
      description:
        "Create / update a task checklist (to-do items); the UI pins it above the input box and shows a progress bar. " +
        "Before starting a multi-step task, use it to list what needs to be done; then call it again after finishing each step, " +
        "changing that item's status to completed (set the one in progress to in_progress). Pass the full checklist every time (it overwrites the previous one).",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "The complete to-do list (pass it in full every time; it overwrites the previous one).",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "A brief description of the item (one short sentence)." },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description: "Status: pending / in progress / completed.",
                },
              },
              required: ["title", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  };
}
