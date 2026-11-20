"""Pair a recording's channel names with the contact names of its electrodes file.

A collaborator may write channels.tsv with the labels of the recording header (`POL A1-AV`,
`EEG G_03-REF`, `EEGGA_01REF`, `EEG M2-Ref`) while electrodes.tsv keeps the contact names (`A1`,
`G03`, `GA01`). This module is the one rule that reads the first as the second; no file is changed.
It is the Python twin of the website's `src/lib/ieeg-spatial/channel-match.ts` (nemarOrg/website)
and the two are held to the same table of counts on the same real files.

The rule, in the order tried (the first step with a hit decides; two different readings at one step
refuse the channel, which then joins nothing):

1. The exact name.
2. A hyphen that splits the name into two exact contact names: a bipolar pair, both contacts.
3. Rewrites that change no letter of the contact: whitespace removed; a leading `EEG` or `POL`
   (either case) and spaces, or `EEG` run into a shaft letter, removed; then the exact name, or a
   name equal to a contact but for leading zeros in the index and an underscore before it (`G_03`,
   `G03` and `G3` are one name, on either side), or a bipolar pair whose halves read that way.
4. One trailing reference token removed from any of those forms: `-REF` or `-Ref` (any case, with
   or without a number), `REF` right after the index (`GA_01REF`), `-AV`, or a hyphen and four or
   more digits (`-20000`) that no contact continues the shaft with; then the same comparison.

Last, claims are settled: an exact name keeps its contact, and two differently written channels that
reach one contact (or one pair) by the same non-exact step both lose it.

Nothing else is read. `POL $A11`, a bare index, a one-letter difference and case-folded names stay
unjoined, as in the website.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

EXACT, NORMALIZED, SUFFIX = 0, 1, 2

_SEPARATOR_BEFORE_INDEX = re.compile(r"_$")
_TRAILING_DIGITS = re.compile(r"(.*?)(\d+)")
_TYPE_PREFIX = re.compile(r"(?:(?:eeg|pol) +|eeg(?=[A-Za-z]))(\S.*)", re.IGNORECASE)
_REFERENCE_NAME = re.compile(r"(?:(.+?)-ref\d*|(.+?\d)ref\d*)", re.IGNORECASE)
_AVERAGE_REFERENCE = re.compile(r"(.+?)-AV")
_NUMERIC_TAIL = re.compile(r"(.+?)-([1-9]\d{3,})")


def zero_key(name: str) -> str:
    """`G_03`, `G03` and `G3` share a key: the trailing digit run loses its leading zeros (and keeps
    one digit, so `A00` is `A0`), and an underscore before it goes. No trailing digits: the name."""
    m = _TRAILING_DIGITS.fullmatch(name)
    if not m:
        return name
    digits = re.sub(r"^0+(?=\d)", "", m[2])
    return f"{_SEPARATOR_BEFORE_INDEX.sub('', m[1])}{digits}"


def _zero_padding(name: str) -> tuple[str, str]:
    m = _TRAILING_DIGITS.fullmatch(name)
    if not m:
        return name, ""
    run = re.match(r"0*(?=\d)", m[2])
    return m[1], run[0] if run else ""


class _Index:
    """The contact names of one electrodes file, with a lookup that tolerates index padding."""

    def __init__(self, names: Sequence[str]) -> None:
        self.names = names
        self.counts: dict[str, int] = {}
        self.by_key: dict[str, list[str]] = {}
        for name in names:
            seen = self.counts.get(name, 0)
            self.counts[name] = seen + 1
            if seen == 0:
                self.by_key.setdefault(zero_key(name), []).append(name)

    def find(self, form: str, zeros: bool) -> list[str]:
        if form in self.counts:
            return [form]
        if not zeros:
            return []

        # The zeros that go must be padding, never a digit of another shaft's name: with contacts L1
        # and L0, `L01` could be shaft L0 and index 1, so it is not read as L1.
        def crosses_shaft(candidate: str) -> bool:
            for x in (form, candidate):
                head, run = _zero_padding(x)
                if run != "" and f"{head}{run}" in self.counts:
                    return True
            return False

        return [c for c in self.by_key.get(zero_key(form), []) if not crosses_shaft(c)]


@dataclass(frozen=True)
class _Reading:
    contacts: tuple[str, ...]
    via: tuple[str, ...]


def _pairs(text: str, index: _Index, zeros: bool) -> list[tuple[tuple[str, str], bool]]:
    """Every split at a hyphen whose halves are two different contacts, and whether a half was read
    through the zero-tolerant lookup."""

    def half(name: str) -> tuple[str, bool] | None:
        if name == "":
            return None
        if index.counts.get(name, 0) > 0:
            return name, False
        if not zeros:
            return None
        found = index.find(name, True)
        return (found[0], True) if len(found) == 1 else None

    out: list[tuple[tuple[str, str], bool]] = []
    for i, ch in enumerate(text):
        if ch != "-":
            continue
        left, right = half(text[:i].strip()), half(text[i + 1 :].strip())
        if left and right and left[0] != right[0]:
            out.append(((left[0], right[0]), left[1] or right[1]))
    return out


def _squeeze(text: str) -> str | None:
    squeezed = re.sub(r"\s+", "", text)
    return squeezed if squeezed not in (text, "") else None


def _strip_type(text: str) -> str | None:
    m = _TYPE_PREFIX.fullmatch(text)
    return m[1] if m else None


def _forms(name: str) -> list[tuple[str, tuple[str, ...]]]:
    """The name, then its rewrites by whitespace removal and by the type word, alone and chained."""
    forms: list[tuple[str, tuple[str, ...]]] = [(name, ())]
    for rule_id, rewrite in (("whitespace", _squeeze), ("type_prefix", _strip_type)):
        forms += [
            (new, via + (rule_id,)) for text, via in forms if (new := rewrite(text)) is not None
        ]
    return forms


def _reads(form: str, index: _Index, via: tuple[str, ...], zeros: bool) -> list[_Reading]:
    exact = index.find(form, False)
    if exact:
        return [_Reading((c,), via) for c in exact]
    if not zeros:
        return []
    return [_Reading((c,), via + ("zeros",)) for c in index.find(form, True)]


def _decide(readings: list[_Reading]) -> tuple[str, ...] | None:
    """The one contact (or pair) all readings agree on; None when two differ."""
    distinct = {r.contacts for r in readings}
    return next(iter(distinct)) if len(distinct) == 1 else None


def _strip_tokens(text: str) -> list[tuple[str, str]]:
    """(rule, name without the token) for every suffix rule that ends this name."""
    out: list[tuple[str, str]] = []
    if m := _REFERENCE_NAME.fullmatch(text):
        out.append(("reference_name", m[1] or m[2]))
    if m := _AVERAGE_REFERENCE.fullmatch(text):
        out.append(("average_reference", m[1]))
    if m := _NUMERIC_TAIL.fullmatch(text):
        out.append(("numeric_tail", m[1]))
    return out


def _match_name(channel: str, index: _Index) -> tuple[int, tuple[str, ...]] | None:
    """The contacts a channel reads as by the non-exact steps, or None (no reading, or two)."""
    forms = _forms(channel)

    normalized: list[_Reading] = []
    for text, via in forms:
        if via == ():
            if not index.find(text, False):
                normalized += _reads(text, index, via, True)
        else:
            normalized += _reads(text, index, via, True)
        for pair, tolerant in _pairs(text, index, True):
            # The bare name's exact pair is the caller's; only a tolerant one is left here.
            if via or tolerant:
                normalized.append(_Reading(pair, via))
    if normalized:
        decided = _decide(normalized)
        return (NORMALIZED, decided) if decided else None

    suffixed: list[_Reading] = []
    for text, via in forms:
        for rule, rest in _strip_tokens(text):
            if rest == "":
                continue
            suffixed += _reads(rest, index, via + (rule,), True)
            if rule == "numeric_tail":
                # The tail may be a contact's index on the same shaft: then the name reads two ways.
                digits = text[len(rest) + 1 :]
                shaft = re.sub(r"\d+$", "", rest)
                suffixed += [_Reading((c,), via) for c in index.find(f"{shaft}{digits}", False)]
    if suffixed:
        decided = _decide(suffixed)
        return (SUFFIX, decided) if decided else None
    return None


def join_channels(channels: Sequence[str], contacts: Sequence[str]) -> dict[str, tuple[str, ...]]:
    """The contact (one) or contacts (two, a bipolar pair) of every channel that joins.

    `channels` are one recording's channel names and `contacts` the names of its electrodes file.
    A channel that joins nothing is absent from the result.
    """
    index = _Index(contacts)
    joined: dict[int, tuple[int, tuple[str, ...]]] = {}
    for i, channel in enumerate(channels):
        if index.counts.get(channel, 0) > 0:
            joined[i] = (EXACT, (channel,))
            continue
        pairs = _pairs(channel, index, False)
        if len(pairs) > 1:
            continue
        if len(pairs) == 1:
            joined[i] = (EXACT, pairs[0][0])
            continue
        found = _match_name(channel, index)
        if found:
            joined[i] = found

    # Claims: the strictest step wins a contact (or pair); equal non-exact claims by differently
    # written names refuse each other. Exact claims never refuse one another.
    by_target: dict[tuple[str, ...], list[int]] = {}
    for i, (_, cs) in joined.items():
        by_target.setdefault(tuple(sorted(cs)), []).append(i)
    refused: set[int] = set()
    for group in by_target.values():
        best = min(joined[i][0] for i in group)
        top_labels = {channels[i] for i in group if joined[i][0] == best}
        for i in group:
            wins = joined[i][0] == best and (best == EXACT or len(top_labels) == 1)
            if not wins:
                refused.add(i)
    return {channels[i]: cs for i, (_, cs) in joined.items() if i not in refused}
