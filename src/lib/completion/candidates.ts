/**
 * Candidate resolution for `nemar __complete` (epic #1144 phase 5b, issue
 * #1149, D1/D2). Pure and synchronous: no network, no process.exit -- see
 * src/lib/completion/run.ts for the entry point that wraps this in a
 * try/catch so a bug here degrades to "no candidates" rather than a stack
 * trace at the shell prompt.
 *
 * Subcommand and flag candidates are read off the LIVE Commander tree
 * (`program.commands`, `cmd.options`, `opt.argChoices`) rather than a
 * hand-written table, so a subcommand or flag added anywhere in src/commands
 * completes automatically -- the issue's own Definition of Done, and the
 * same live-introspection convention test/admin-route-inventory.unit.test.ts
 * uses for the admin route table (D2).
 *
 * Facet enum values (`shared/facets.ts`) and Commander `.choices()` values
 * are both static and need no network or cache (D2).
 *
 * Three distinct cases, and "widens" is only accurate for one of them
 * (#1173 review):
 *   - `electrode-system` has a static `enumValues` AND a cache-backed
 *     vocabulary. The endpoint genuinely WIDENS it, and the cache wins when
 *     fresh, so its candidates can differ from the declared six.
 *   - `task`, `modality`, `license`, `bids-version` have no static
 *     vocabulary at all -- `task`/`modality`/`license` are the legacy
 *     bespoke filters `shared/facets.ts` excludes by design, and
 *     `bids-version`'s FacetDefinition carries no `enumValues`. The endpoint
 *     is their ONLY source, not a widening of one.
 *   - `--source`, `--zarr`, `--powerline` are static-only, no dynamic
 *     counterpart.
 */

import type { Command, Option } from "commander";
import type { DatasetFacetsEnvelope } from "../../../shared/contract/index.js";
import { FACETS } from "../../../shared/facets.js";
import { readCompletionCache } from "./cache.js";

/**
 * cobra-style completion directives. Only the ones this CLI actually emits
 * are defined here -- do not port the rest of cobra's bitmask "to be
 * complete" (D4).
 */
export const CompletionDirective = {
  /** Default shell behaviour alongside the candidates (e.g. falling back to
   *  filename completion when nothing matches). Unused today: every
   *  candidate this CLI emits is a command, a flag, or a facet value --
   *  never a path. */
  Default: 0,
  /** Suppress the shell's own filename-completion fallback. The only
   *  directive this CLI emits. */
  NoFileComp: 4,
} as const;
export type CompletionDirectiveValue =
  (typeof CompletionDirective)[keyof typeof CompletionDirective];

/** The CLI flag (as declared in `shared/facets.ts` or a plain `.option()`
 *  call) mapped to the key the facets endpoint enriches it under (D2's
 *  table). `--source`, `--zarr`, and `--powerline` are deliberately absent:
 *  they have a declared static enum and nothing dynamic on top of it.
 *  `--hed-version` was missing here even though it is `--bids-version`'s
 *  exact structural twin (test-review follow-up on #1173): both are
 *  `valueKind: "version"` with no `enumValues` in shared/facets.ts, so
 *  neither has a static fallback, and both are first-class members of
 *  `GROUPED_VOCAB_KEYS` in backend/src/services/dataset-facet-vocabulary.ts
 *  and of `datasetFacetsEnvelopeSchema`. Without this entry, `--hed-version`
 *  could never complete anything -- not from the cache, and not from a
 *  static list, because it never had one. */
const DYNAMIC_FACET_KEY_BY_FLAG: Partial<Record<string, keyof DatasetFacetsEnvelope>> = {
  "--task": "task",
  "--modality": "modality",
  "--license": "license",
  "--bids-version": "bids-version",
  "--hed-version": "hed-version",
  "--electrode-system": "electrode-system",
};

/** Dynamic candidates for one flag from the completion cache, or undefined
 *  if that flag has no dynamic source, the cache is absent/stale/corrupt,
 *  or this particular key was omitted from a degraded response (D5/ADR
 *  0005). Never throws -- readCompletionCache already degrades to null. */
function dynamicCandidatesFor(flag: string): string[] | undefined {
  const key = DYNAMIC_FACET_KEY_BY_FLAG[flag];
  if (!key) return undefined;
  const cache = readCompletionCache();
  if (!cache) return undefined;
  if (key === "task") {
    return cache.task?.values.map((v) => v.value);
  }
  const entry = cache[key] as Array<{ value: string }> | undefined;
  return entry?.map((v) => v.value);
}

/** Static enum members declared for a facet flag (`shared/facets.ts`),
 *  needing no network or cache (D2). Undefined for flags with no declared
 *  enum, including the legacy `--modality`/`--license`/`--task` filters,
 *  which were never part of the facet table in the first place. */
function staticEnumFor(flag: string): readonly string[] | undefined {
  return FACETS.find((f) => f.flag === flag)?.enumValues;
}

/** Value candidates for one Option: native `.choices()` first (only
 *  `--sort` uses this today), then the dynamic facets-endpoint cache, then
 *  the static facet enum, in that order -- the dynamic set is a superset of
 *  the static one when it exists (D2), so it's preferred when present. */
function valueCandidatesFor(opt: Option): string[] {
  if (opt.argChoices && opt.argChoices.length > 0) return [...opt.argChoices];
  const flag = opt.long ?? opt.short;
  if (!flag) return [];
  const dynamic = dynamicCandidatesFor(flag);
  if (dynamic && dynamic.length > 0) return dynamic;
  const staticValues = staticEnumFor(flag);
  if (staticValues) return [...staticValues];
  return [];
}

function optionTakesValue(opt: Option): boolean {
  return opt.required || opt.optional;
}

function findSubcommand(cmd: Command, word: string): Command | undefined {
  return cmd.commands.find((sub) => sub.name() === word || sub.aliases().includes(word));
}

function findOption(cmd: Command, token: string): Option | undefined {
  return cmd.options.find((opt) => opt.short === token || opt.long === token);
}

/**
 * `Command` has no public accessor for hidden state -- `Option.hidden` is
 * public in Commander 12.1.0's own typings, but the `Command` class only
 * carries it as the private `_hidden` field (verified against
 * node_modules/commander/lib/command.js and typings/index.d.ts). Commander's
 * own help renderer reads the exact same private field to filter hidden
 * commands out of `--help` (lib/help.js: `cmd.commands.filter((cmd) =>
 * !cmd._hidden)`), so this isn't reaching past the API for something
 * Commander itself treats as internal-only; there is simply no public
 * equivalent to reach for.
 */
function isHidden(cmd: Command): boolean {
  return Boolean((cmd as unknown as { _hidden?: boolean })._hidden);
}

function subcommandNames(cmd: Command): string[] {
  const names: string[] = [];
  for (const sub of cmd.commands) {
    if (isHidden(sub)) continue;
    names.push(sub.name(), ...sub.aliases());
  }
  return names;
}

function optionFlagsFor(cmd: Command): string[] {
  const flags: string[] = [];
  for (const opt of cmd.options) {
    if (opt.long) flags.push(opt.long);
    if (opt.short) flags.push(opt.short);
  }
  return flags;
}

function filterPrefix(candidates: string[], prefix: string): string[] {
  if (!prefix) return candidates;
  return candidates.filter((c) => c.startsWith(prefix));
}

/** Matches a long-flag `=`-value token, e.g. `--source=op`, group 1 the flag
 *  and group 2 the (possibly empty) value typed so far. Commander itself
 *  accepts this form for any option (`_combineFlagAndOptionalValue`), so
 *  completion has to as well -- #1173 review follow-up. */
const EQUALS_VALUE_PATTERN = /^(--[A-Za-z0-9][A-Za-z0-9-]*)=(.*)$/;

/**
 * Resolve completion candidates for one `__complete` request. `words` is
 * every word the user has typed after `nemar`, in order, with the
 * (possibly empty) word currently being completed as its last element --
 * exactly what bash's `COMP_WORDS[1..COMP_CWORD]` / zsh's `words[2,CURRENT]`
 * / fish's `commandline` tokens supply once the leading `--` separator
 * (D4's cobra-style invocation, `nemar __complete -- <words...>`) has been
 * stripped by the caller.
 */
export function getCandidates(program: Command, words: string[]): string[] {
  const toComplete = words.length > 0 ? words[words.length - 1] : "";
  const priorWords = words.length > 0 ? words.slice(0, -1) : [];

  // Walk as far down the subcommand tree as priorWords allows. Subcommand
  // names only ever appear before any flag in Commander's own grammar, so
  // the first prior word that ISN'T a subcommand name of the current node
  // stops the walk for good -- everything from there on is this command's
  // own flags and values, never another subcommand.
  let current = program;
  let resolved = 0;
  while (resolved < priorWords.length) {
    const next = findSubcommand(current, priorWords[resolved]);
    if (!next) break;
    current = next;
    resolved++;
  }

  // `--flag=partial` arrives as ONE token from zsh and fish, whose tokenizers
  // don't break words on `=` the way bash's default COMP_WORDBREAKS does.
  // Checked before the plain-flag branches below, or `--source=op` would
  // fall into "complete a flag NAME" and match nothing (no flag is spelled
  // "--source=op"). The replacement here has to be the FULL `flag=value`
  // text, because zsh/fish treat the whole token as what gets replaced.
  const eqMatch = toComplete.match(EQUALS_VALUE_PATTERN);
  if (eqMatch) {
    const [, flag, valuePrefix] = eqMatch;
    const opt = findOption(current, flag);
    if (!opt || !optionTakesValue(opt)) return [];
    return filterPrefix(valueCandidatesFor(opt), valuePrefix).map((value) => `${flag}=${value}`);
  }

  // The word immediately before toComplete, if any words were left over
  // after the subcommand walk above -- i.e. we're already inside `current`'s
  // own flags. If it names a value-taking option, toComplete is completing
  // THAT option's value.
  if (priorWords.length > resolved) {
    const lastPrior = priorWords[priorWords.length - 1];
    const opt = findOption(current, lastPrior);
    if (opt && optionTakesValue(opt)) {
      return filterPrefix(valueCandidatesFor(opt), toComplete);
    }
    // bash's default COMP_WORDBREAKS includes "=", so `--source=op` reaches
    // here as THREE separate words (..., "--source", "=", "op") instead of
    // one -- the immediately preceding word is a bare "=", and the flag name
    // is one word further back. Unlike the single-token case above, the
    // replacement here has to be the BARE value: bash's own idea of "the
    // current word" is only the "op" fragment after the break character, so
    // prefixing it with "--source=" again would duplicate the flag bash
    // already has on the line.
    if (lastPrior === "=" && priorWords.length >= 2) {
      const eqOpt = findOption(current, priorWords[priorWords.length - 2]);
      if (eqOpt && optionTakesValue(eqOpt)) {
        return filterPrefix(valueCandidatesFor(eqOpt), toComplete);
      }
    }
  }

  if (toComplete.startsWith("-")) {
    return filterPrefix(optionFlagsFor(current), toComplete);
  }

  if (resolved === priorWords.length) {
    // Every prior word resolved to a subcommand step and none of them were
    // flags yet: toComplete is either the next subcommand name (for a
    // container like `dataset`) or, for a leaf command, there is nothing
    // positional to offer -- dataset-id and free-text query completion are
    // explicitly out of scope (the plan's "Out of scope" section).
    return filterPrefix(subcommandNames(current), toComplete);
  }

  // Flags have already started (resolved < priorWords.length) but the word
  // before toComplete either isn't a flag on `current` or doesn't take a
  // value: nothing else is defined at this point except more of `current`'s
  // own flags.
  return filterPrefix(optionFlagsFor(current), toComplete);
}
