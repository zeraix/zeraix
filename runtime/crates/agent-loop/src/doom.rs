//! Doom-loop detection — is this turn still going anywhere?
//!
//! Ported from `src/lib/agent/doomLoop.ts` (spec §12). There is exactly one detector in the system: two of
//! them was the failure the TypeScript milestone M5d removed, where the page ran its own detector and
//! withdrew tools while the loop ran another and stopped the turn, and the user saw one outcome decided in two
//! places.
//!
//! ## What counts as a repeat
//!
//! Repetition is counted per **(call, result)** pairing rather than per call. A `run_command` that runs the
//! test suite five times while the code changes underneath it returns five different results and is
//! productive every time — the case a naive "same call again" counter would flag, and this one does not. That
//! single decision is what makes the detector safe to act on: without the result in the key, re-running the
//! suite after an edit would be reported as a loop.
//!
//! Four signals, in decreasing specificity:
//!
//!  - **identical** — the same call returning the same result.
//!  - **equivalent** — the same call after cosmetic differences are removed (`./a.ts` and `a.ts` are one
//!    call wearing two spellings), returning the same result.
//!  - **failing** — a run of failures from one tool.
//!  - **resource** — the turn keeps going back to one file or one query, however it phrases the request.
//!
//! The response stays proportional: a repetition is recorded, repeated behaviour earns a reminder, and only a
//! run of rounds that produced nothing new escalates to a stop.

use std::collections::HashMap;

/// A second identical call+result earns a reminder. The first repeat is where a loop becomes visible at all.
pub const REPEAT_NOTE_AT: u32 = 2;

/// A run of failures from one tool. Higher than the identical threshold: a tool that fails twice is often
/// being used correctly against something genuinely broken, and saying so early trains the model to give up.
pub const FAIL_NOTE_AT: u32 = 3;

/// Repeated access to one resource. Higher again, on purpose: reading three different parts of a large file
/// is a sequential walk, not a loop, and flagging it would push a model off a legitimate strategy.
pub const RESOURCE_NOTE_AT: u32 = 4;

/// Consecutive rounds in which every call was unproductive before the detector escalates to a stop.
pub const STALLED_ROUNDS_TO_ESCALATE: u32 = 3;

/// Which diagnosis a verdict carries. Most specific wins — see [`DoomLoop::observe`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoomSignal {
    Identical,
    Equivalent,
    Resource,
    Failing,
}

/// One call, as the detector sees it.
#[derive(Debug, Clone)]
pub struct CallObservation<'a> {
    pub name: &'a str,
    /// Arguments as executed, after routing resolved them.
    pub args: &'a serde_json::Value,
    /// The text fed back to the model.
    pub result: &'a str,
    pub ok: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallVerdict {
    /// How many times this exact call has produced this exact result, including now.
    pub repeat: u32,
    pub fail_streak: u32,
    pub resource_hits: u32,
    pub unproductive: bool,
    pub signal: Option<DoomSignal>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoundVerdict {
    pub stalled_rounds: u32,
    /// Escalate to a stop. Fires once per turn: a detector that re-escalates every round would turn one
    /// diagnosis into a stream of them.
    pub escalate: bool,
}

/// Argument keys that name the thing a call is *about*.
///
/// `path` and its relatives identify a file; `query` identifies a search. Both are resources in the sense §12
/// means — "repeated access to the same resource, repeated searches" — even though a file and a query are
/// nothing alike, because the failure mode is identical: the turn keeps going back to one thing.
const RESOURCE_KEYS: [&str; 8] = ["path", "file", "filename", "dir", "directory", "query", "pattern", "url"];

#[derive(Debug, Default)]
pub struct DoomLoop {
    /// Normalised call key → result hash → occurrences.
    seen: HashMap<String, HashMap<u64, u32>>,
    /// Cosmetically-normalised call key + result hash → occurrences.
    equivalents: HashMap<String, u32>,
    /// "tool:resource" → occurrences.
    resources: HashMap<String, u32>,
    fail_streaks: HashMap<String, u32>,
    stalled_rounds: u32,
    escalated: bool,
}

impl DoomLoop {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn stalled_rounds(&self) -> u32 {
        self.stalled_rounds
    }

    /// Record one call and say what it was worth.
    pub fn observe(&mut self, obs: &CallObservation<'_>) -> CallVerdict {
        let hash = result_hash(obs.result);

        let key = call_key(obs.name, obs.args);
        let by_hash = self.seen.entry(key).or_default();
        let repeat = by_hash.entry(hash).or_insert(0);
        *repeat += 1;
        let repeat = *repeat;

        // Keyed on the RESULT as well as the normalised call, for the same reason the identical signal is: a
        // call that returned something new taught the model something, however similar its arguments looked.
        let eq_key = format!("{}\u{0}{hash}", equivalent_key(obs.name, obs.args));
        let equivalent = self.equivalents.entry(eq_key).or_insert(0);
        *equivalent += 1;
        let equivalent = *equivalent;

        let mut resource_hits = 0;
        if let Some(resource) = resource_of(obs.args) {
            let counter = self.resources.entry(format!("{}:{resource}", obs.name)).or_insert(0);
            *counter += 1;
            resource_hits = *counter;
        }

        let fail_streak = if obs.ok {
            self.fail_streaks.insert(obs.name.to_owned(), 0);
            0
        } else {
            let counter = self.fail_streaks.entry(obs.name.to_owned()).or_insert(0);
            *counter += 1;
            *counter
        };

        let identical = repeat >= REPEAT_NOTE_AT;
        // Only counts once byte-identity has been ruled out — otherwise every identical call would also report
        // as "equivalent", and the reminder would name the vaguer of the two diagnoses.
        let equivalent_repeat = !identical && equivalent >= REPEAT_NOTE_AT;
        let over_resource = resource_hits >= RESOURCE_NOTE_AT;
        let failing = fail_streak >= FAIL_NOTE_AT;

        CallVerdict {
            repeat,
            fail_streak,
            resource_hits,
            unproductive: identical || equivalent_repeat || over_resource || failing,
            // Most specific first: "you made this exact call again" is actionable in a way "you keep touching
            // this file" is not, and a model told the vaguer thing tends to vary its arguments rather than
            // change course.
            signal: if identical {
                Some(DoomSignal::Identical)
            } else if equivalent_repeat {
                Some(DoomSignal::Equivalent)
            } else if failing {
                Some(DoomSignal::Failing)
            } else if over_resource {
                Some(DoomSignal::Resource)
            } else {
                None
            },
        }
    }

    /// Close a round and decide whether the turn is still going anywhere.
    ///
    /// A round with no tool calls is not a round the detector sees (the loop exits on it), so an empty slice
    /// leaves the streak alone rather than counting as either productive or stalled.
    pub fn close_round(&mut self, verdicts: &[CallVerdict]) -> RoundVerdict {
        if verdicts.is_empty() {
            return RoundVerdict { stalled_rounds: self.stalled_rounds, escalate: false };
        }
        let stalled = verdicts.iter().all(|v| v.unproductive);
        self.stalled_rounds = if stalled { self.stalled_rounds + 1 } else { 0 };
        let escalate = !self.escalated && self.stalled_rounds >= STALLED_ROUNDS_TO_ESCALATE;
        if escalate {
            self.escalated = true;
        }
        RoundVerdict { stalled_rounds: self.stalled_rounds, escalate }
    }
}

/// Stable identity for "the same call again": name plus arguments with object keys sorted.
pub fn call_key(name: &str, args: &serde_json::Value) -> String {
    let mut out = String::from(name);
    out.push(' ');
    stable(args, &mut out);
    out
}

/// Identity after cosmetic differences are removed.
///
/// Strings are trimmed, lower-cased, internal whitespace collapsed, and a leading `./` dropped — the four ways
/// a model rephrases an argument without changing what it asked for. Numbers and booleans are left alone: a
/// different `limit` is a genuinely different read, and treating it as equivalent would flag a sequential walk
/// through a file as a loop.
///
/// Deliberately NOT path resolution. Resolving `../` against a working directory would need I/O and would be
/// wrong for the many arguments that are not paths; this is a similarity test used only to decide whether to
/// warn, so over-normalising costs more than it saves.
pub fn equivalent_key(name: &str, args: &serde_json::Value) -> String {
    let mut out = String::from(name);
    out.push(' ');
    normalized(args, &mut out);
    out
}

fn stable(v: &serde_json::Value, out: &mut String) {
    write_json(v, out, false);
}

fn normalized(v: &serde_json::Value, out: &mut String) {
    write_json(v, out, true);
}

/// One writer for both keys, differing only in whether strings are folded.
///
/// Object keys are sorted so that two calls whose arguments differ only in emission order are one call —
/// which they are, and which a plain `to_string()` would miss.
fn write_json(v: &serde_json::Value, out: &mut String, fold_strings: bool) {
    match v {
        serde_json::Value::String(s) => {
            let text = if fold_strings { fold(s) } else { s.clone() };
            out.push_str(&serde_json::Value::String(text).to_string());
        }
        serde_json::Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(item, out, fold_strings);
            }
            out.push(']');
        }
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::Value::String(k.clone()).to_string());
                out.push(':');
                write_json(&map[k], out, fold_strings);
            }
            out.push('}');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// Trim, lower-case, collapse internal whitespace, drop a leading `./`.
fn fold(s: &str) -> String {
    let lowered = s.trim().to_lowercase();
    let mut collapsed = String::with_capacity(lowered.len());
    let mut in_space = false;
    for c in lowered.chars() {
        if c.is_whitespace() {
            if !in_space {
                collapsed.push(' ');
                in_space = true;
            }
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    collapsed.strip_prefix("./").map(str::to_owned).unwrap_or(collapsed)
}

/// The resource a call touches, folded, or `None` when it touches none the detector can name.
pub fn resource_of(args: &serde_json::Value) -> Option<String> {
    let map = args.as_object()?;
    for key in RESOURCE_KEYS {
        if let Some(serde_json::Value::String(s)) = map.get(key) {
            if !s.trim().is_empty() {
                return Some(fold(s));
            }
        }
    }
    None
}

/// FNV-1a over the result text, with the length folded in.
///
/// A hash because a turn can hold hundreds of results, several of them large; the detector only ever asks "is
/// this the same output as last time". The length guards the collision: two different results must collide in
/// the hash AND share a length to be mistaken for one, and the consequence would be a single spurious
/// reminder.
///
/// Iterates UTF-16 code units rather than bytes or `char`s, which is what the TypeScript detector does. That
/// is not an accident of the port: while both detectors exist, two runtimes disagreeing about whether a call
/// repeated would be a difference nobody could see and nobody could explain.
pub fn result_hash(text: &str) -> u64 {
    let mut h: u32 = 0x811c_9dc5;
    let mut units: u32 = 0;
    for unit in text.encode_utf16() {
        h ^= unit as u32;
        h = h.wrapping_mul(0x0100_0193);
        units += 1;
    }
    ((h as u64) << 32) | units as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn observe(g: &mut DoomLoop, name: &str, args: serde_json::Value, result: &str, ok: bool) -> CallVerdict {
        g.observe(&CallObservation { name, args: &args, result, ok })
    }

    #[test]
    fn a_first_call_is_never_a_loop() {
        let mut g = DoomLoop::new();
        let v = observe(&mut g, "read_file", json!({"path": "a.ts"}), "contents", true);
        assert_eq!(v.repeat, 1);
        assert!(!v.unproductive);
        assert_eq!(v.signal, None);
    }

    #[test]
    fn the_same_call_returning_the_same_result_is_identical_repetition() {
        let mut g = DoomLoop::new();
        observe(&mut g, "read_file", json!({"path": "a.ts"}), "contents", true);
        let v = observe(&mut g, "read_file", json!({"path": "a.ts"}), "contents", true);
        assert_eq!(v.repeat, 2);
        assert_eq!(v.signal, Some(DoomSignal::Identical));
        assert!(v.unproductive);
    }

    /// The false positive this detector must not have: the same command over changed code is progress.
    #[test]
    fn the_same_command_returning_a_different_result_is_productive_every_time() {
        let mut g = DoomLoop::new();
        for (i, out) in ["3 failing", "2 failing", "1 failing", "all passing"].iter().enumerate() {
            let v = observe(&mut g, "run_command", json!({"command": "npm test"}), out, true);
            assert!(!v.unproductive, "run {i} reported as a loop");
            assert_eq!(v.signal, None);
        }
    }

    #[test]
    fn argument_order_does_not_make_a_call_different() {
        let a = call_key("read_file", &json!({"path": "a.ts", "limit": 10}));
        let b = call_key("read_file", &json!({"limit": 10, "path": "a.ts"}));
        assert_eq!(a, b);
    }

    #[test]
    fn cosmetic_respellings_of_one_call_are_equivalent_rather_than_identical() {
        let mut g = DoomLoop::new();
        observe(&mut g, "read_file", json!({"path": "./A.ts"}), "contents", true);
        let v = observe(&mut g, "read_file", json!({"path": "a.ts"}), "contents", true);
        // Not byte-identical, so `repeat` stays at 1 and the vaguer diagnosis is the right one.
        assert_eq!(v.repeat, 1);
        assert_eq!(v.signal, Some(DoomSignal::Equivalent));
    }

    /// A different `limit` is a genuinely different read: a sequential walk is never *repetition*.
    ///
    /// It can still trip the resource signal, which is a different and weaker claim — "this turn keeps going
    /// back to one file" — and that is the behaviour `RESOURCE_NOTE_AT` exists to express. What must never
    /// happen is the walk being called an identical or equivalent repeat, because that tells the model its
    /// arguments were wrong when they were the point.
    #[test]
    fn a_sequential_walk_is_never_reported_as_repetition() {
        let mut g = DoomLoop::new();
        for (i, offset) in [0, 100, 200, 300].into_iter().enumerate() {
            let v = observe(&mut g, "read_file", json!({"path": "big.ts", "offset": offset}), "chunk", true);
            assert_ne!(v.signal, Some(DoomSignal::Identical), "offset {offset}");
            assert_ne!(v.signal, Some(DoomSignal::Equivalent), "offset {offset}");
            assert_eq!(v.repeat, 1, "offset {offset} is a distinct call");
            // The fourth touch of one file is where the weaker signal is designed to fire.
            let expected = if i + 1 >= RESOURCE_NOTE_AT as usize { Some(DoomSignal::Resource) } else { None };
            assert_eq!(v.signal, expected, "offset {offset}");
        }
    }

    #[test]
    fn returning_to_one_resource_often_enough_is_reported_however_it_is_phrased() {
        let mut g = DoomLoop::new();
        let mut last = None;
        for i in 0..RESOURCE_NOTE_AT {
            last = observe(&mut g, "read_file", json!({"path": "a.ts", "offset": i}), &format!("chunk {i}"), true)
                .signal;
        }
        assert_eq!(last, Some(DoomSignal::Resource));
    }

    #[test]
    fn a_run_of_failures_from_one_tool_is_reported_and_a_success_clears_it() {
        let mut g = DoomLoop::new();
        for i in 0..FAIL_NOTE_AT {
            let v = observe(&mut g, "edit_file", json!({"path": format!("f{i}.ts")}), &format!("err {i}"), false);
            if i + 1 < FAIL_NOTE_AT {
                assert_ne!(v.signal, Some(DoomSignal::Failing));
            } else {
                assert_eq!(v.signal, Some(DoomSignal::Failing));
                assert_eq!(v.fail_streak, FAIL_NOTE_AT);
            }
        }
        let v = observe(&mut g, "edit_file", json!({"path": "ok.ts"}), "done", true);
        assert_eq!(v.fail_streak, 0);
    }

    /// The escalation is proportional: rounds that produce something new reset the streak.
    #[test]
    fn a_productive_round_resets_the_stall_streak() {
        let mut g = DoomLoop::new();
        // The first call establishes the pairing; repetition only exists from the second one onwards.
        observe(&mut g, "read_file", json!({"path": "a.ts"}), "same", true);
        for _ in 0..2 {
            let v = observe(&mut g, "read_file", json!({"path": "a.ts"}), "same", true);
            assert!(g.close_round(&[v]).stalled_rounds > 0);
        }
        let fresh = observe(&mut g, "read_file", json!({"path": "b.ts"}), "new", true);
        let round = g.close_round(&[fresh]);
        assert_eq!(round.stalled_rounds, 0);
        assert!(!round.escalate);
    }

    #[test]
    fn three_consecutive_stalled_rounds_escalate_exactly_once() {
        let mut g = DoomLoop::new();
        observe(&mut g, "read_file", json!({"path": "a.ts"}), "same", true);
        let mut escalations = 0;
        for _ in 0..6 {
            let v = observe(&mut g, "read_file", json!({"path": "a.ts"}), "same", true);
            if g.close_round(&[v]).escalate {
                escalations += 1;
            }
        }
        assert_eq!(escalations, 1, "a detector that re-escalates turns one diagnosis into a stream");
    }

    #[test]
    fn a_round_with_one_productive_call_among_repeats_is_not_stalled() {
        let mut g = DoomLoop::new();
        observe(&mut g, "read_file", json!({"path": "a.ts"}), "same", true);
        let repeat = observe(&mut g, "read_file", json!({"path": "a.ts"}), "same", true);
        let fresh = observe(&mut g, "search_files", json!({"query": "todo"}), "5 hits", true);
        assert_eq!(g.close_round(&[repeat, fresh]).stalled_rounds, 0);
    }

    #[test]
    fn an_empty_round_leaves_the_streak_alone() {
        let mut g = DoomLoop::new();
        let v = observe(&mut g, "read_file", json!({"path": "a.ts"}), "same", true);
        observe(&mut g, "read_file", json!({"path": "a.ts"}), "same", true);
        g.close_round(&[v]);
        let before = g.stalled_rounds();
        assert_eq!(g.close_round(&[]).stalled_rounds, before);
    }

    #[test]
    fn the_result_hash_separates_texts_that_differ_only_in_length() {
        assert_ne!(result_hash("abc"), result_hash("abcabc"));
        assert_eq!(result_hash("abc"), result_hash("abc"));
        assert_ne!(result_hash(""), result_hash("a"));
    }

    #[test]
    fn folding_removes_the_four_cosmetic_differences_and_nothing_else() {
        assert_eq!(fold("  ./Src/A.ts  "), "src/a.ts");
        assert_eq!(fold("find   the\tthing"), "find the thing");
        // Not path resolution: `..` survives, because resolving it would need I/O and would be wrong for the
        // many arguments that are not paths.
        assert_eq!(fold("../a.ts"), "../a.ts");
    }

    #[test]
    fn a_resource_is_read_from_whichever_key_names_it() {
        assert_eq!(resource_of(&json!({"path": "./A.ts"})).as_deref(), Some("a.ts"));
        assert_eq!(resource_of(&json!({"query": " TODO "})).as_deref(), Some("todo"));
        assert_eq!(resource_of(&json!({"limit": 10})), None);
        assert_eq!(resource_of(&json!({"path": "   "})), None);
        assert_eq!(resource_of(&json!([1, 2])), None);
    }
}
