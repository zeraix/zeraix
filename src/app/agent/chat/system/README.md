# Retain the dual-file prompt structure to preserve extensibility.

## Future directory structure
prompts/
  scenes/
    base.md                  # Scene Axis: General basic commands, most content
    development-mode.md      # Scene axis: Commands added in development mode
  models/
    deepseek.md              # Model axis: Only write this if there are differences between DeepSeek and the default behavior; the content should be very short.
    claude.md                # Same as above, regarding the differences for Claude
  environment/
    sandbox.md               # Environment Axis: Explanation of Sandbox Mode
    host.md                  # Environment Axis: Explanation of Native Mode


## Sequential Rollout

### Step 1: Build the skeleton first — no behavior change

1. Set up the directory structure and move the two existing files in as-is, **without changing any content**:
   ```
   prompts/scenes/base.md              ← formerly base
   prompts/scenes/development-mode.md  ← formerly development.mode.md
   prompts/environment/                ← empty for now
   prompts/models/                     ← empty for now
   ```
2. Refactor the assembly function from hardcoded if/else branching over two files into a generic "iterate an array, filter out empty entries" pattern (see the pseudocode from the earlier reply).
3. **Before closing out this step, run a full diff**: take a batch of real historical cases (at minimum, cases covering both the base-only and development-mode scenarios), assemble the final prompt string with both the old and new logic, and do a byte-for-byte comparison to confirm they're identical. Do not proceed until this passes.

Once this step is done, you have an extensible skeleton with **zero change** to production behavior — this is the lowest-risk part of the migration.

### Step 2: Wire the new "secure environment" toggle into the skeleton

1. Write `environment/sandbox.md` and `environment/host.md`.
2. Add one line to the assembly logic: based on the environment bound to the current session/project, conditionally insert the matching file.
3. Test this in isolation: create sessions in both sandbox and host states and confirm the assembled prompt contains the correct file's content, and that the two are mutually exclusive (never both present at once).

### Step 3: Leave `models/` empty — just lock in the admission criteria, no content needed yet

There's no need to write any model-specific prompt content right now. Just get the team aligned on one rule and put it in the docs (e.g. AGENTS.md):

> "Content may only be added to `models/{model}.md` when there's concrete eval data or a production case proving a specific instruction behaves differently on that model. These files may only contain deltas — never a full copy of base content with a few edits."

Locking this in now is far cheaper than cleaning up an accumulated pile of redundant content later.

## Bonus: document the assembly rules

Add a `README.md` under `prompts/` that spells out:
- The concatenation order (scenes → environment → models — which comes first, which comes last)
- How empty files/sections are handled (skipped automatically, no stray blank lines)
- Who to loop in and what process to follow when adding a new environment or model file

The point of this doc isn't for your own reference — it's to **stop the next engineer, six months from now, from having to reverse-engineer this logic by guessing**. If the reasoning behind these design decisions (why we split things this way, why this shape) isn't written down, whoever touches this code next will likely flatten your carefully orthogonal structure back into one big blob.

## Suggested time investment

- Step 1 (skeleton migration + regression testing): half a day to a day — most of the time goes into preparing test cases and running the diff, the code change itself is small
- Step 2 (secure environment integration): depends on how fast the copy gets finalized; the code itself is an hour-scale change
- Step 3 (documenting the rule): one to two hours