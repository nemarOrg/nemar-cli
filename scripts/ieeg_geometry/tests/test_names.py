"""The channel-electrode name map, on the name columns of real renamed files.

The fixtures are the channels and electrodes `name` columns of the `fix-20261018` pull requests
(tests/fixtures/PROVENANCE.md). The counts are the website's: its `channel-rename.test.ts` holds the
same table over the same files.
"""

import hashlib
import json
from pathlib import Path

import pytest

from ieeg_geometry.bids import ECOG, UNKNOWN, discover, read_electrode_set
from ieeg_geometry.names import join_channels, zero_key

FIXTURES = Path(__file__).parent / "fixtures" / "channel_renames"


def recording(dataset: str, suffix: str) -> dict:
    doc = json.loads((FIXTURES / f"{dataset}.json").read_text())
    (found,) = [r for r in doc["recordings"] if r["channels_path"].endswith(suffix)]
    return found


# dataset, channels file, channels, contacts, joined by the exact name, joined by the rules,
# bipolar among them, distinct contacts reached
TABLE = [
    (
        "on004194",
        "sub-p04_ses-nyuecog01_task-prf_acq-clinical_run-01_channels.tsv",
        [124, 104, 0, 104, 0, 104],
    ),
    (
        "on004194",
        "sub-p05_ses-nyuecog01_task-prf_acq-clinical_run-01_channels.tsv",
        [206, 174, 0, 174, 0, 174],
    ),
    ("on004551", "sub-012_ses-01_task-sleep_run-01_channels.tsv", [123, 108, 0, 108, 0, 108]),
    ("on005007", "sub-06_ses-01_task-namingtask_run-01_channels.tsv", [88, 44, 0, 44, 0, 44]),
    ("on005007", "sub-13_ses-01_task-namingtask_run-01_channels.tsv", [103, 67, 0, 67, 0, 67]),
    ("on005545", "sub-48_ses-01_task-auditory_run-01_channels.tsv", [49, 118, 0, 47, 47, 54]),
    ("on005545", "sub-84_ses-03_task-auditory_run-01_channels.tsv", [66, 132, 0, 64, 64, 64]),
    ("on005931", "sub-06_ses-02_task-game_run-01_channels.tsv", [64, 95, 0, 62, 0, 62]),
    ("on006107", "sub-29_ses-01_task-sws_run-01_channels.tsv", [106, 106, 0, 106, 0, 106]),
    ("on006233", "sub-045_ses-3_task-picture_channels.tsv", [49, 112, 0, 47, 47, 55]),
    ("on006914", "sub-045_ses-3_task-picture_channels.tsv", [49, 112, 0, 47, 47, 55]),
]


@pytest.mark.parametrize(("dataset", "file", "counts"), TABLE)
def test_counts_match_the_website(dataset, file, counts):
    r = recording(dataset, file)
    joined = join_channels(r["channels"], r["contacts"])
    exact = {c for c in r["channels"] if c in set(r["contacts"])}
    reached = {c for cs in joined.values() for c in cs}
    assert [
        len(r["channels"]),
        len(r["contacts"]),
        len(exact),
        len(joined),
        sum(len(cs) == 2 for cs in joined.values()),
        len(reached),
    ] == counts


def test_every_joined_channel_names_its_contacts_shaft():
    def shaft(name):
        return "".join(ch for ch in name if ch.isalpha()).upper()

    for path in sorted(FIXTURES.glob("[!_]*.json")):
        for r in json.loads(path.read_text())["recordings"]:
            for channel, contacts in join_channels(r["channels"], r["contacts"]).items():
                for contact in contacts:
                    assert shaft(contact) in shaft(channel), (path.stem, channel, contact)


@pytest.mark.parametrize(
    ("dataset", "file", "channel", "contacts"),
    [
        (
            "on004194",
            "sub-p04_ses-nyuecog01_task-prf_acq-clinical_run-01_channels.tsv",
            "EEG G_03-REF",
            ("G03",),
        ),
        (
            "on004194",
            "sub-p05_ses-nyuecog01_task-prf_acq-clinical_run-01_channels.tsv",
            "EEGGA_01REF",
            ("GA01",),
        ),
        ("on004551", "sub-012_ses-01_task-sleep_run-01_channels.tsv", "POL A3", ("A3",)),
        ("on004551", "sub-012_ses-01_task-sleep_run-01_channels.tsv", "EEG A1-Ref", ("A1",)),
        ("on005007", "sub-06_ses-01_task-namingtask_run-01_channels.tsv", "EEG A2-Ref", ("A2",)),
        ("on005545", "sub-48_ses-01_task-auditory_run-01_channels.tsv", "POL A1-A2", ("A1", "A2")),
        (
            "on005545",
            "sub-84_ses-03_task-auditory_run-01_channels.tsv",
            "POL B1-B2",
            ("B01", "B02"),
        ),
        ("on005931", "sub-06_ses-02_task-game_run-01_channels.tsv", "POL B1-AV", ("B1",)),
        ("on006107", "sub-29_ses-01_task-sws_run-01_channels.tsv", "A1-AV", ("A1",)),
        ("on006233", "sub-045_ses-3_task-picture_channels.tsv", "POL B10-B18", ("B10", "B18")),
    ],
)
def test_each_form_reads_as_its_contacts(dataset, file, channel, contacts):
    r = recording(dataset, file)
    assert channel in r["channels"]
    assert join_channels(r["channels"], r["contacts"])[channel] == contacts


def test_names_the_rule_does_not_read_stay_unjoined():
    r = recording("on004551", "sub-012_ses-01_task-sleep_run-01_channels.tsv")
    joined = join_channels(r["channels"], r["contacts"])
    assert "POL $A11" in r["channels"]
    for channel in ("POL $A11", "POL DC01", "POL E"):
        assert channel not in joined
    e = recording("on005007", "sub-06_ses-01_task-namingtask_run-01_channels.tsv")
    assert "M2" not in e["contacts"]
    assert "EEG M2-Ref" not in join_channels(e["channels"], e["contacts"])


def test_zero_key_drops_an_underscore_before_the_index_and_its_zeros():
    assert {zero_key(n) for n in ("G_03", "G03", "G3")} == {"G3"}
    # An underscore inside a name stays (nm000436's Ant_d10a).
    assert zero_key("Ant_d10a") == "Ant_d10a"
    assert zero_key("A00") == "A0"


def test_either_side_may_carry_the_underscore_and_the_zeros():
    assert join_channels(["G3", "EEG G04-REF"], ["G_03", "G_04"]) == {
        "G3": ("G_03",),
        "EEG G04-REF": ("G_04",),
    }


def test_type_word_is_upper_case_and_the_no_space_forms():
    contacts = ["A1", "A3", "AR1"]
    # No dataset writes another case: lower and mixed case stay unread (owner, 2026-11-20).
    assert join_channels(["pol A3", "Eeg A1"], contacts) == {}
    assert join_channels(["EEGAR1", "POL A3"], contacts) == {"EEGAR1": ("AR1",), "POL A3": ("A3",)}
    # POL with no space is part of the name (known-answer name).
    assert join_channels(["POLAR1"], contacts) == {}
    # REF is a reference only right after an index (known-answer name).
    assert join_channels(["PREF"], ["P"]) == {}


def test_an_underscore_after_a_digit_is_part_of_the_name():
    assert zero_key("G1_2") != zero_key("G12")
    assert zero_key("GRID_1_2") != zero_key("GRID_12")
    assert join_channels(["G12"], ["G1_2"]) == {}
    assert join_channels(["G1_2"], ["G12"]) == {}
    assert join_channels(["GRID_12"], ["GRID_1_2"]) == {}
    assert join_channels(["GRID_1_2"], ["GRID_12"]) == {}


def test_only_ascii_digits_are_digits():
    # U+0661 is an Arabic-Indic digit one: `str.isdigit` and Python's `\d` accept it, the
    # website's `\d` does not, and the two must agree.
    assert join_channels(["A\u0661"], ["A1"]) == {}
    assert join_channels(["POL A\u0661"], ["A\u0661"]) == {"POL A\u0661": ("A\u0661",)}
    assert join_channels(["A01REF"], ["A\u0661"]) == {}
    assert join_channels(["A\u0661"], ["A_\u0661"]) == {}
    assert join_channels(["A0\u0661"], ["A\u0661"]) == {}
    assert join_channels(["A\u0661REF"], ["A\u0661"]) == {}


def test_the_join_map_is_the_one_both_repositories_commit():
    path = FIXTURES / "_expected-joins.json"
    assert (
        hashlib.sha256(path.read_bytes()).hexdigest()
        == "9a9aa2aa451f27ef98bdac2ad897d4cbe484e3e0ba59a39acc3b6ca210be580f"
    )
    expected = json.loads(path.read_text())
    actual = {}
    for fixture in sorted(FIXTURES.glob("[!_]*.json")):
        doc = json.loads(fixture.read_text())
        for r in doc["recordings"]:
            joined = join_channels(r["channels"], r["contacts"])
            actual[f"{doc['dataset']}/{r['channels_path']}"] = {
                c: sorted(joined[c]) if c in joined else "refused" for c in r["channels"]
            }
    assert actual == expected


def test_an_exact_name_keeps_its_contact_and_two_spellings_refuse_each_other():
    assert join_channels(["A1", "POL A1"], ["A1", "A2"]) == {"A1": ("A1",)}
    assert join_channels(["POL A1", "EEG A1"], ["A1", "A2"]) == {}


def test_two_contacts_that_one_padded_name_could_mean_refuse():
    assert join_channels(["B1-B2"], ["B01", "B001", "B02"]) == {}


def _write_renamed_dataset(root: Path, r: dict) -> None:
    """A dataset of one recording: contacts as the electrodes file names them, no `type` column
    (as on the renamed datasets), and every channel typed ECOG as the channels file does."""
    ieeg = root / "sub-01" / "ieeg"
    ieeg.mkdir(parents=True)
    rows = "".join(f"{name}\t{i}\t0\t0\n" for i, name in enumerate(r["contacts"]))
    (ieeg / "sub-01_electrodes.tsv").write_text("name\tx\ty\tz\n" + rows)
    (ieeg / "sub-01_coordsystem.json").write_text(json.dumps({"iEEGCoordinateUnits": "mm"}))
    chan = "".join(f"{name}\tECOG\n" for name in r["channels"])
    (ieeg / "sub-01_task-x_channels.tsv").write_text("name\ttype\n" + chan)


@pytest.mark.parametrize(("dataset", "file", "counts"), TABLE)
def test_contact_types_follow_renamed_channels(tmp_path, dataset, file, counts):
    r = recording(dataset, file)
    _write_renamed_dataset(tmp_path, r)
    (item,) = discover(tmp_path)
    contacts = read_electrode_set(item).contacts
    assert sum(c.type == ECOG for c in contacts) == counts[-1]
    assert sum(c.type == UNKNOWN for c in contacts) == len(r["contacts"]) - counts[-1]


def _typed(tmp_path: Path, contacts: list[str], *channel_files: list[tuple[str, str]]):
    ieeg = tmp_path / "sub-01" / "ieeg"
    ieeg.mkdir(parents=True)
    rows = "".join(f"{name}\t{i}\t0\t0\n" for i, name in enumerate(contacts))
    (ieeg / "sub-01_electrodes.tsv").write_text("name\tx\ty\tz\n" + rows)
    (ieeg / "sub-01_coordsystem.json").write_text(json.dumps({"iEEGCoordinateUnits": "mm"}))
    for n, rows_ in enumerate(channel_files, 1):
        body = "".join(f"{name}\t{kind}\n" for name, kind in rows_)
        (ieeg / f"sub-01_task-t{n}_channels.tsv").write_text("name\ttype\n" + body)
    (item,) = discover(tmp_path)
    eset = read_electrode_set(item)
    return {c.name: c.type for c in eset.contacts}, eset.warnings


def test_claims_settle_over_every_channel_not_only_the_typed_ones(tmp_path):
    # A1 is kept by its exact MISC channel, so `POL A1` (SEEG) is refused and A1 has no iEEG type;
    # `EEG A2-Ref` (EEG) and `POL A2-Ref` (ECOG) both reach A2 the same way and refuse each other.
    types, _ = _typed(
        tmp_path,
        ["A1", "A2"],
        [("A1", "MISC"), ("POL A1", "SEEG"), ("EEG A2-Ref", "EEG"), ("POL A2-Ref", "ECOG")],
    )
    assert types == {"A1": UNKNOWN, "A2": UNKNOWN}


def test_a_renamed_channel_types_its_contact_when_nothing_else_claims_it(tmp_path):
    types, warnings = _typed(
        tmp_path, ["A1", "A2", "B1"], [("POL A1", "SEEG"), ("A2", "ECOG"), ("EEG B1-Ref", "EEG")]
    )
    assert types == {"A1": "seeg", "A2": ECOG, "B1": UNKNOWN}
    assert warnings == ()


def test_types_that_disagree_leave_the_contact_untyped_with_a_warning(tmp_path):
    types, warnings = _typed(
        tmp_path,
        ["A1", "A2"],
        [("POL A1", "SEEG"), ("A2", "ECOG")],
        [("POL A1", "ECOG"), ("A2", "ECOG")],
    )
    assert types == {"A1": UNKNOWN, "A2": ECOG}
    assert len(warnings) == 1
    assert "A1" in warnings[0] and "ecog, seeg" in warnings[0]


def test_an_exact_type_beats_a_renamed_one_from_another_file(tmp_path):
    types, warnings = _typed(tmp_path, ["A1"], [("POL A1", "ECOG")], [("A1", "SEEG")])
    assert types == {"A1": "seeg"}
    assert warnings == ()


def test_exact_types_that_disagree_across_files_leave_the_contact_untyped(tmp_path):
    types, warnings = _typed(
        tmp_path, ["A1", "A2"], [("A1", "SEEG"), ("A2", "ECOG")], [("A1", "ECOG")]
    )
    assert types == {"A1": UNKNOWN, "A2": ECOG}
    assert len(warnings) == 1
    assert "A1" in warnings[0] and "ecog, seeg" in warnings[0]
