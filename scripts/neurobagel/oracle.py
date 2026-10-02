# /// script
# requires-python = ">=3.11"
# dependencies = ["bagel==0.11.6", "rdflib>=7", "fastapi", "pydantic-settings", "httpx"]
# ///
"""Run Neurobagel's own code over the transform's goldens.

    uv run scripts/neurobagel/oracle.py            # check, and refresh the recordings
    uv run scripts/neurobagel/oracle.py --check    # check only, leave the recordings alone
    uv run scripts/neurobagel/oracle.py nm000132   # one dataset

The transform (shared/neurobagel) is TypeScript; Neurobagel's tools are Python.
This script is the bridge that keeps the two honest.
For every golden it checks, with the real pinned code and nothing reimplemented:

  1. `bagel.models.Dataset` (Neurobagel's pydantic model, extra keys forbidden)
     accepts the JSON-LD, and its `@context` equals the one
     `bagel.utilities.model_utils.generate_context` writes.
  2. `bagel.utilities.pheno_utils.validate_data_dict` and
     `validate_dataset_description` accept the data dictionary and the dataset
     description.
  3. `bagel pheno`, run on the fixture's participants.tsv with the golden
     dictionary and description, describes the same phenotype (age, sex,
     diagnosis, and the assessment tools of a curated dataset) for every
     participant as the golden JSON-LD, after identifiers are set aside (bagel
     mints random uuid4, the transform derives uuid5).
     A participant's diagnoses are compared as a set.
  4. `bagel bids`, run on a table built from the fixture's bids index, finds the
     same imaging modalities for every subject it can attach them to.
  5. The recipes stack's own graph-mode loader (`init_data/process_jsonld.py`
     at the pinned commit) validates every JSON-LD and skips none, and its
     catalog-mode loader catalogues every dictionary and description pair.
  6. rdflib expands each JSON-LD with its own `@context` into RDF with no blank
     nodes and no relative identifiers.
  7. The node API's own SPARQL generator (`app/api/utility.py` `create_query`
     at the pinned v0.11.0 commit) builds the queries a federated search sends
     (modality, sex, diagnosis, age, session count, and combinations), rdflib
     runs them over the loaded goldens, and the subjects each one returns equal
     the subjects found by walking the golden directly.
     Steps 6 and 7 are an RDF and SPARQL check, NOT a GraphDB load: GraphDB is
     not run here (no container runtime), and the load is checked on a real
     stack separately.

The comparison in step 3 and 4 is also written to test/neurobagel/oracle/<id>.json
so the Bun tests can compare against the recording without Python.
The recording stores the sha256 of every input it was derived from, so a golden
that changes without a fresh run is caught.

Network: read-only GETs against raw.githubusercontent.com (bagel reads its
vocabulary there at import; the recipes files are fetched at the pinned commit
and verified against the git blob sha in the vocabulary snapshot).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TEST_ROOT = ROOT / "test" / "neurobagel"
FIXTURES = TEST_ROOT / "fixtures"
GOLDEN = TEST_ROOT / "golden"
ORACLE = TEST_ROOT / "oracle"
SNAPSHOT = json.loads((ROOT / "shared/neurobagel/vocab/snapshot.json").read_text())
MAPPED_SUFFIXES = ("eeg", "meg")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def normalize_label(label: str) -> str:
    """The transform prefixes a participant id that lacks `sub-`; the oracle's labels get the same rule."""
    return label if label.startswith("sub-") else f"sub-{label}"


# ---------------------------------------------------------------- recipes (pinned)


def fetch_recipes(dest: Path) -> None:
    """Lay the recipes `init_data` package out under dest, verified against the pinned blob shas."""
    pin = SNAPSHOT["pins"]["recipes"]
    layout = {
        "init_data/process_jsonld.py": "init_data/process_jsonld.py",
        "init_data/utils/models.py": "init_data/utils/models.py",
        "init_data/utils/dictionary_models.py": "init_data/utils/dictionary_models.py",
        "init_data/utils/dataset_description_model.py": "init_data/utils/dataset_description_model.py",
    }
    for source, target in layout.items():
        url = (
            f"https://raw.githubusercontent.com/{pin['repo']}/{pin['commit']}/{source}"
        )
        request = urllib.request.Request(
            url, headers={"User-Agent": "nemar-neurobagel-dev/1.0"}
        )
        data = urllib.request.urlopen(request, timeout=60).read()
        if git_blob_sha(data) != pin["files"][source]["blob_sha"]:
            raise SystemExit(
                f"{source} does not match the pinned blob sha; regenerate the vocabulary snapshot"
            )
        path = dest / target
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    (dest / "init_data" / "__init__.py").write_text("")
    (dest / "init_data" / "utils" / "__init__.py").write_text("")


def run_recipes_loader(
    recipes: Path, input_dir: Path, catalog_mode: bool
) -> tuple[int, int, str]:
    """Run the recipes loader; return (datasets accepted, files skipped, log text)."""
    output = input_dir.parent / ("out-catalog" if catalog_mode else "out-graph")
    output.mkdir(exist_ok=True)
    code = (
        "import json,sys\n"
        "from pathlib import Path\n"
        "from init_data.process_jsonld import extract_datasets_metadata_to_dict\n"
        "d = extract_datasets_metadata_to_dict(Path(sys.argv[1]), Path(sys.argv[2]))\n"
        "print('ACCEPTED', len(d))\n"
    )
    env = {
        **os.environ,
        "NB_CATALOG_MODE": "true" if catalog_mode else "false",
        "PYTHONPATH": str(recipes),
    }
    proc = subprocess.run(
        [sys.executable, "-c", code, str(input_dir), str(output)],
        capture_output=True,
        text=True,
        env=env,
        cwd=recipes,
        check=False,
    )
    log = proc.stdout + proc.stderr
    accepted = re.search(r"ACCEPTED (\d+)", log)
    skipped = len(
        re.findall(r"Skipping (?:file|dataset)|failed validation|is not a valid", log)
    )
    if proc.returncode != 0 or accepted is None:
        return 0, -1, log
    return int(accepted.group(1)), skipped, log


# ---------------------------------------------------------------- bagel


def bagel(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", "from bagel.cli import bagel; bagel()", *args],
        capture_output=True,
        text=True,
        check=False,
    )


def phenotype_view(dataset: dict) -> dict[str, dict]:
    """Per normalized subject label: the phenotype of its phenotypic session."""
    view: dict[str, dict] = {}
    for subject in dataset["hasSamples"]:
        phenotypic = [
            s for s in subject["hasSession"] if s["schemaKey"] == "PhenotypicSession"
        ]
        if len(phenotypic) != 1:
            raise AssertionError(
                f"{subject['hasLabel']} has {len(phenotypic)} phenotypic sessions"
            )
        session = phenotypic[0]
        entry = {
            "age": session.get("hasAge"),
            "sex": session.get("hasSex", {}).get("identifier"),
            # A set: two columns that say the same diagnosis give bagel a repeated node, and a graph
            # that says it twice says nothing more.
            "diagnoses": sorted(
                {d["identifier"] for d in session.get("hasDiagnosis", [])}
            ),
        }
        # Only a curated dataset has assessments; leaving the key out when empty keeps every
        # recording of a dataset without one as it was.
        assessments = sorted(
            {a["identifier"] for a in session.get("hasAssessment", [])}
        )
        if assessments:
            entry["assessments"] = assessments
        view[normalize_label(subject["hasLabel"])] = entry
    return view


def modality_view(dataset: dict) -> dict[str, list[str]]:
    view: dict[str, list[str]] = {}
    for subject in dataset["hasSamples"]:
        found = {
            a["hasContrastType"]["identifier"]
            for s in subject["hasSession"]
            if s["schemaKey"] == "ImagingSession"
            for a in s["hasAcquisition"]
        }
        view[normalize_label(subject["hasLabel"])] = sorted(found)
    return view


DATASET_KEYS = [
    "hasLabel",
    "hasAuthors",
    "hasKeywords",
    "hasReferencesAndLinks",
    "hasRepositoryURL",
    "hasAccessInstructions",
    "hasAccessType",
    "hasAccessLink",
]


def refusal_reason(raw_log: str) -> str | None:
    # bagel wraps its messages in a rich console: drop colour codes and line wrapping first.
    log = " ".join(re.sub(r"\x1b\[[0-9;]*m", "", raw_log).split())
    if "duplicate participant IDs" in log:
        return "duplicate_ids"
    if "missing values in participant or session ID columns" in log:
        return "empty_ids"
    return None


def run_pheno(fixture: Path, golden: Path, work: Path, id_: str, report: dict) -> dict:
    tsv_path = fixture / "participants.tsv"
    if not tsv_path.exists() or report["participants_tsv"]["status"] != "ok":
        return {
            "status": "skipped",
            "reason": f"table_{report['participants_tsv']['status']}",
        }
    data = tsv_path.read_bytes()
    if data.startswith(b"\xef\xbb\xbf"):
        # The transform strips a byte order mark (pandas would keep it and rename the first
        # column); the oracle is fed the same table so the comparison is about the rules.
        data = data[3:]
    # bagel reads a table as UTF-8 text with universal newlines; a CR-only table is handed over
    # as the LF table the transform's reader also sees.
    data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    tsv = work / "participants.tsv"
    tsv.write_bytes(data)
    out = work / "bagel-pheno.jsonld"
    proc = bagel(
        [
            "pheno",
            "--pheno",
            str(tsv),
            "--dictionary",
            str(golden / f"{id_}_annotated.json"),
            "--dataset-description",
            str(golden / f"{id_}_dataset_description.json"),
            "--output",
            str(out),
            "--overwrite",
        ]
    )
    log = proc.stdout + proc.stderr
    recorded_inputs = {
        "participants.tsv": sha256(data),
        "annotated.json": sha256((golden / f"{id_}_annotated.json").read_bytes()),
        "dataset_description.json": sha256(
            (golden / f"{id_}_dataset_description.json").read_bytes()
        ),
    }
    if proc.returncode != 0:
        reason = refusal_reason(log)
        if reason is None:
            raise SystemExit(
                f"bagel pheno failed for {id_} for an undocumented reason:\n{log[-2000:]}"
            )
        return {"status": "refused", "reason": reason, "inputs": recorded_inputs}
    oracle = json.loads(out.read_text())
    oracle.pop("@context")
    return {
        "status": "compared",
        "reason": None,
        "inputs": recorded_inputs,
        "dataset": {k: oracle.get(k) for k in DATASET_KEYS},
        "subjects": phenotype_view(oracle),
        "_oracle_jsonld": str(out),
    }


def run_bids(metadata: dict, pheno: dict, work: Path, id_: str) -> dict | None:
    """Attach imaging from a table built from the bids index; return modalities per subject."""
    if pheno["status"] != "compared":
        return None
    index = (
        (metadata.get("extensions") or {})
        .get("nemar", {})
        .get("bids_index", {})
        .get("subjects", {})
    )
    rows = ["sub\tses\tsuffix\tpath"]
    attachable = 0
    for sub, node in sorted(index.items()):
        if normalize_label(sub) not in pheno["subjects"]:
            continue  # bagel refuses an imaging subject without a phenotype row
        recorded = node.get("session_modalities")
        if isinstance(recorded, dict):
            # The index says which datatype is in which session: one table row per such pair.
            pairs = [
                ("" if key == "no-session" else key, datatype)
                for key, datatypes in sorted(recorded.items())
                for datatype in sorted(datatypes)
                if datatype in MAPPED_SUFFIXES
            ]
        else:
            # It does not: the table claims every datatype in every session, which is only
            # comparable per subject (the union of modalities), never per session.
            sessions = node.get("sessions") or [""]
            pairs = [
                (ses, datatype)
                for datatype in sorted(node.get("modalities", {}))
                if datatype in MAPPED_SUFFIXES
                for ses in sessions
            ]
        if pairs:
            attachable += 1
        for ses, datatype in pairs:
            path = (
                f"{sub}/{'ses-' + ses + '/' if ses else ''}{datatype}/{sub}_{datatype}"
            )
            rows.append(f"{sub}\t{'ses-' + ses if ses else ''}\t{datatype}\t{path}")
    if attachable == 0:
        return {"modalities": {}, "attachable_subjects": 0}
    table = work / "bids.tsv"
    table.write_text("\n".join(rows) + "\n")
    out = work / "bagel-bids.jsonld"
    proc = bagel(
        [
            "bids",
            "--jsonld-path",
            pheno["_oracle_jsonld"],
            "--bids-table",
            str(table),
            "--output",
            str(out),
            "--overwrite",
        ]
    )
    if proc.returncode != 0:
        raise SystemExit(
            f"bagel bids failed for {id_}:\n{(proc.stdout + proc.stderr)[-2000:]}"
        )
    oracle = json.loads(out.read_text())
    oracle.pop("@context")
    view = {k: v for k, v in modality_view(oracle).items() if v}
    return {"modalities": view, "attachable_subjects": len(view)}


# ---------------------------------------------------------------- checks


def check_dataset(id_: str, recipes: Path, record: bool) -> dict:
    from bagel import models
    from bagel.utilities import model_utils, pheno_utils

    golden = GOLDEN / id_
    fixture = FIXTURES / id_
    jsonld = json.loads((golden / f"{id_}.jsonld").read_text())
    dictionary = json.loads((golden / f"{id_}_annotated.json").read_text())
    description = json.loads((golden / f"{id_}_dataset_description.json").read_text())
    report = json.loads((golden / f"{id_}.report.json").read_text())
    metadata = json.loads((fixture / "metadata.json").read_text())

    # 1. Neurobagel's pydantic model, and its context.
    context = jsonld.pop("@context")
    models.Dataset.model_validate(jsonld)
    expected = model_utils.generate_context("Neurobagel")["@context"]
    assert context == expected, f"{id_}: @context differs from bagel's"
    # 2. Neurobagel's dictionary and description validators.
    pheno_utils.validate_data_dict(json.loads(json.dumps(dictionary)), "Neurobagel")
    pheno_utils.get_validated_dataset_description_and_incomplete_fields(description)

    result: dict = {"dataset_id": id_, "bagel": SNAPSHOT["bagel_version"]}
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        # 3. bagel pheno
        pheno = run_pheno(fixture, golden, work, id_, report)
        mine = phenotype_view(jsonld)
        if pheno["status"] == "compared":
            # The graph holds the bids index's subjects. bagel makes a subject of every table
            # row, so the bagel subjects the graph lacks must be exactly the table rows for
            # participants the index does not list, and the report must count them.
            index_labels = {
                normalize_label(k)
                for k in (
                    (metadata.get("extensions") or {})
                    .get("nemar", {})
                    .get("bids_index", {})
                    .get("subjects", {})
                )
            }
            absent = sorted(label for label in pheno["subjects"] if label not in mine)
            if report["subjects"]["source"] == "bids_index":
                expected_absent = sorted(
                    label for label in pheno["subjects"] if label not in index_labels
                )
            else:
                expected_absent = []
            assert absent == expected_absent, (
                f"{id_}: bagel subjects missing from the graph are not the table-only rows"
            )
            assert len(absent) == report["subjects"]["table_only"], (
                f"{id_}: report counts {report['subjects']['table_only']} table-only rows, "
                f"bagel has {len(absent)} subjects the graph lacks"
            )
            for label, view in pheno["subjects"].items():
                if label in absent:
                    continue
                assert mine[label] == view, (
                    f"{id_}: {label} differs: transform {mine[label]} bagel {view}"
                )
            empty = {"age": None, "sex": None, "diagnoses": []}
            extra = [label for label in mine if label not in pheno["subjects"]]
            assert all(mine[label] == empty for label in extra), (
                f"{id_}: transform-only subjects carry phenotype"
            )
            for key in DATASET_KEYS:
                assert pheno["dataset"][key] == jsonld.get(key), (
                    f"{id_}: dataset field {key} differs"
                )
            result["transform_only_subjects"] = len(extra)
            result["bagel_only_subjects"] = len(absent)
        # 4. bagel bids
        bids = run_bids(metadata, pheno, work, id_)
        if bids is not None:
            mine_img = {k: v for k, v in modality_view(jsonld).items() if v}
            for label, found in bids["modalities"].items():
                assert mine_img.get(label) == found, (
                    f"{id_}: {label} modalities differ: {mine_img.get(label)} vs {found}"
                )
        result.update({k: v for k, v in pheno.items() if not k.startswith("_")})
        result["imaging"] = bids
    if record:
        ORACLE.mkdir(exist_ok=True)
        (ORACLE / f"{id_}.json").write_text(
            json.dumps(result, indent=2, sort_keys=True) + "\n"
        )
    return result


def fetch_napi(dest: Path) -> None:
    """Lay the node API's query generator out under dest, verified against the pinned blob shas."""
    pin = SNAPSHOT["pins"]["api"]
    for source in pin["files"]:
        url = (
            f"https://raw.githubusercontent.com/{pin['repo']}/{pin['commit']}/{source}"
        )
        request = urllib.request.Request(
            url, headers={"User-Agent": "nemar-neurobagel-dev/1.0"}
        )
        data = urllib.request.urlopen(request, timeout=60).read()
        if git_blob_sha(data) != pin["files"][source]["blob_sha"]:
            raise SystemExit(
                f"{source} does not match the pinned blob sha; regenerate the vocabulary snapshot"
            )
        path = dest / source
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    (dest / "app" / "__init__.py").write_text("")
    (dest / "app" / "api" / "__init__.py").write_text("")


def walk(dataset: dict) -> list[dict]:
    """Each subject of a golden with the facts a query filters on, read straight from the JSON-LD."""
    subjects = []
    for subject in dataset["hasSamples"]:
        phenotypic = next(
            s for s in subject["hasSession"] if s["schemaKey"] == "PhenotypicSession"
        )
        imaging = [
            s for s in subject["hasSession"] if s["schemaKey"] == "ImagingSession"
        ]
        subjects.append(
            {
                "label": subject["hasLabel"],
                "age": phenotypic.get("hasAge"),
                "sex": phenotypic.get("hasSex", {}).get("identifier"),
                "diagnoses": {
                    d["identifier"] for d in phenotypic.get("hasDiagnosis", [])
                },
                "modalities": {
                    a["hasContrastType"]["identifier"]
                    for s in imaging
                    for a in s["hasAcquisition"]
                },
                "imaging_sessions": len(imaging),
            }
        )
    return subjects


# rdflib has no join planner: a query over a few hundred subjects takes ten seconds, so a large
# dataset gets three representative queries instead of ten.
LARGE_DATASET_SUBJECTS = 150


def check_node_queries(ids: list[str], napi: Path) -> None:
    """7. The queries a federated search sends, built by the node API's own code, over the goldens."""
    from rdflib import Graph

    sys.path.insert(0, str(napi))
    # Fetched at the pinned commit by fetch_napi() just before this runs, so no checker can see it.
    from app.api.utility import create_query  # ty: ignore[unresolved-import]

    namespaces = dict(SNAPSHOT["namespaces"])

    def matching(graph: Graph, dataset_iri: str, **filters) -> set[str]:
        query = create_query(
            return_agg=True,
            age=(filters.get("min_age"), filters.get("max_age")),
            sex=filters.get("sex"),
            diagnosis=filters.get("diagnosis", []),
            min_num_imaging_sessions=filters.get("min_imaging"),
            min_num_phenotypic_sessions=None,
            assessment=[],
            image_modal=filters.get("image_modal", []),
            pipeline=[],
            dataset_uuids=[dataset_iri],
        )
        return {str(row["sub_id"]) for row in graph.query(query, initNs=namespaces)}

    eeg, meg = "nidm:Electroencephalography", "nidm:Magnetoencephalography"
    cases = [
        ("unfiltered", {}, lambda s: True, True),
        ("EEG", {"image_modal": [eeg]}, lambda s: eeg in s["modalities"], True),
        ("MEG", {"image_modal": [meg]}, lambda s: meg in s["modalities"], False),
        (
            "female",
            {"sex": "snomed:248152002"},
            lambda s: s["sex"] == "snomed:248152002",
            False,
        ),
        (
            "male",
            {"sex": "snomed:248153007"},
            lambda s: s["sex"] == "snomed:248153007",
            False,
        ),
        (
            "healthy control",
            {"diagnosis": ["ncit:C94342"]},
            lambda s: "ncit:C94342" in s["diagnoses"],
            False,
        ),
        (
            "age 25 to 40",
            {"min_age": 25, "max_age": 40},
            lambda s: s["age"] is not None and 25 <= s["age"] <= 40,
            False,
        ),
        (
            "age at least 30",
            {"min_age": 30},
            lambda s: s["age"] is not None and s["age"] >= 30,
            False,
        ),
        (
            "at least 1 imaging session",
            {"min_imaging": 1},
            lambda s: s["imaging_sessions"] >= 1,
            False,
        ),
        (
            "EEG, female, age at least 20",
            {"image_modal": [eeg], "sex": "snomed:248152002", "min_age": 20},
            lambda s: (
                eeg in s["modalities"]
                and s["sex"] == "snomed:248152002"
                and s["age"] is not None
                and s["age"] >= 20
            ),
            True,
        ),
    ]
    checked = 0
    nonempty = 0
    skipped_empty = 0
    for id_ in ids:
        dataset = json.loads((GOLDEN / id_ / f"{id_}.jsonld").read_text())
        graph = Graph().parse(
            data=(GOLDEN / id_ / f"{id_}.jsonld").read_text(), format="json-ld"
        )
        iri = SNAPSHOT["namespaces"]["nb"] + dataset["identifier"].removeprefix("nb:")
        subjects = walk(dataset)
        for label, filters, predicate, in_large in cases:
            if len(subjects) > LARGE_DATASET_SUBJECTS and not in_large:
                continue
            expected = {s["label"] for s in subjects if predicate(s)}
            if not expected and filters:
                # rdflib answers an empty GROUP BY with one all-unbound row, which joins with every
                # subject; GraphDB does not. Only a filter nobody satisfies can reach that, so it is
                # skipped here rather than compared against an engine bug.
                skipped_empty += 1
                continue
            found = matching(graph, iri, **filters)
            assert found == expected, (
                f"{id_}: {label}: node query found {len(found)} subjects, the graph holds {len(expected)}"
            )
            checked += 1
            nonempty += bool(expected)
    print(
        f"node API queries: {checked} queries over {len(ids)} datasets agree with the graph "
        f"({nonempty} non-empty; {skipped_empty} filters nobody satisfies skipped)"
    )


def check_loaders(ids: list[str], recipes: Path) -> None:
    """5. The recipes loaders, over all goldens at once, as a node would run them."""
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        graph_in = base / "graph"
        catalog_in = base / "catalog"
        graph_in.mkdir()
        catalog_in.mkdir()
        for id_ in ids:
            for src, dst in (
                (f"{id_}.jsonld", graph_in),
                (f"{id_}_annotated.json", catalog_in),
                (f"{id_}_dataset_description.json", catalog_in),
            ):
                (dst / src).write_bytes((GOLDEN / id_ / src).read_bytes())
        accepted, skipped, log = run_recipes_loader(
            recipes, graph_in, catalog_mode=False
        )
        assert accepted == len(ids) and skipped == 0, (
            f"recipes graph mode accepted {accepted}/{len(ids)}, skipped {skipped}:\n{log[-3000:]}"
        )
        accepted, skipped, log = run_recipes_loader(
            recipes, catalog_in, catalog_mode=True
        )
        assert accepted == len(ids) and skipped == 0, (
            f"recipes catalog mode accepted {accepted}/{len(ids)}, skipped {skipped}:\n{log[-3000:]}"
        )
        print(
            f"recipes loaders: graph mode {len(ids)}/{len(ids)} accepted, catalog mode {len(ids)}/{len(ids)} accepted, 0 skipped"
        )


def check_rdf(ids: list[str]) -> None:
    """6. JSON-LD expands to RDF with no blank nodes and no relative identifiers."""
    from rdflib import BNode, Graph, Literal, URIRef
    from rdflib.namespace import RDF, XSD

    nb = "http://neurobagel.org/vocab/"
    for id_ in ids:
        text = (GOLDEN / id_ / f"{id_}.jsonld").read_text()
        graph = Graph().parse(data=text, format="json-ld")
        bnodes = [t for t in graph if any(isinstance(x, BNode) for x in t)]
        assert not bnodes, f"{id_}: JSON-LD expands to blank nodes"
        for s, p, o in graph:
            for term in (s, p, o):
                if isinstance(term, URIRef):
                    assert re.match(r"^[a-z][a-z0-9+.-]*:", str(term)), (
                        f"{id_}: relative identifier {term}"
                    )
        report = json.loads((GOLDEN / id_ / f"{id_}.report.json").read_text())["graph"]
        types = defaultdict(int)
        for s, o in graph.subject_objects(RDF.type):
            types[str(o)] += 1
        assert types[nb + "Subject"] == report["subjects"], (
            f"{id_}: subject nodes {types[nb + 'Subject']} != {report['subjects']}"
        )
        assert types[nb + "PhenotypicSession"] == report["phenotypic_sessions"]
        assert types[nb + "ImagingSession"] == report["imaging_sessions"]
        assert types[nb + "Acquisition"] == report["acquisitions"]
        assert types[nb + "Dataset"] == 1
        for _, _, age in graph.triples((None, URIRef(nb + "hasAge"), None)):
            assert isinstance(age, Literal) and age.datatype == XSD.double, (
                f"{id_}: hasAge is not xsd:double"
            )
    print(
        f"rdflib: {len(ids)} JSON-LD documents expand to RDF with the expected node counts"
    )


def main() -> None:
    args = sys.argv[1:]
    record = "--check" not in args
    ids = [a for a in args if not a.startswith("--")] or sorted(
        p.name for p in GOLDEN.iterdir() if p.is_dir()
    )
    with tempfile.TemporaryDirectory() as tmp:
        recipes = Path(tmp)
        fetch_recipes(recipes)
        for id_ in ids:
            result = check_dataset(id_, recipes, record)
            note = result["status"] + (
                f" ({result['reason']})" if result.get("reason") else ""
            )
            print(
                f"ok {id_}: bagel pheno {note}; bagel bids {'compared' if result['imaging'] else 'n/a'}"
            )
        check_loaders(ids, recipes)
    check_rdf(ids)
    with tempfile.TemporaryDirectory() as tmp:
        napi = Path(tmp)
        fetch_napi(napi)
        check_node_queries(ids, napi)
    print("all checks passed")


if __name__ == "__main__":
    main()
