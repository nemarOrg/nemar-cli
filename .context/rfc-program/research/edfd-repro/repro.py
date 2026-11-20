"""Repro: does MNE / biosigIO place post-gap EDF+D (and BrainVision New Segment) samples on the wrong time?
Signal value (uV) == TRUE time in seconds of that sample, so value - time_axis is the placement error."""
import os, sys, warnings, shutil, tempfile
import numpy as np
import mne
warnings.simplefilter("ignore")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "files"); os.makedirs(OUT, exist_ok=True)
import importlib.metadata as md
print("versions: mne", mne.__version__, "| biosigio", md.version("biosigio"), "| numpy", np.__version__, "| python", sys.version.split()[0])

# ---------------- EDF writer (byte-for-byte, EDF+ spec) ----------------
FS, NS_REC, DUR = 10, 10, 1          # 10 Hz, 10 samples per 1 s record
ANN_SAMPLES = 40                      # 80 bytes of TAL space per record
def f(s, w): 
    b = s.encode("ascii"); assert len(b) <= w, (s, w); return b.ljust(w, b" ")
def write_edf(path, kind, onsets, ann_extra):
    """kind 'C' or 'D'. onsets: start (s) of each 1 s data record. ann_extra: {record_idx: (onset, text)}"""
    n = len(onsets)
    hdr = f("0", 8) + f("X X X X", 80) + f("Startdate 01-JAN-2020 X X X", 80) + f("01.01.20", 8) + f("12.00.00", 8)
    hdr += f(str(256 * 3), 8) + f("EDF+" + kind, 44) + f(str(n), 8) + f(str(DUR), 8) + f("2", 4)
    sig = [("EEG Ramp", "", "uV", "-327.68", "327.67", "-32768", "32767", "", str(NS_REC), ""),
           ("EDF Annotations", "", "", "-1", "1", "-32768", "32767", "", str(ANN_SAMPLES), "")]
    w = [16, 80, 8, 8, 8, 8, 8, 80, 8, 32]
    for col in range(10):
        for s in sig: hdr += f(s[col], w[col])
    assert len(hdr) == 256 * 3
    body = b""
    for r, t0 in enumerate(onsets):
        t = t0 + np.arange(NS_REC) / FS                      # TRUE time of each sample
        body += np.round(t * 100).astype("<i2").tobytes()     # 0.01 uV per digit: value(uV) == t(s)
        tal = f"+{t0:g}".encode() + b"\x14\x14\x00"          # time-keeping TAL, first byte of record
        if r in ann_extra:
            on, txt = ann_extra[r]; tal += f"+{on:g}".encode() + b"\x14" + txt.encode() + b"\x14\x00"
        assert len(tal) <= 2 * ANN_SAMPLES
        body += tal.ljust(2 * ANN_SAMPLES, b"\x00")
    open(path, "wb").write(hdr + body)

def validate_edf(path):
    b = open(path, "rb").read(); ns = int(b[252:256]); n = int(b[236:244])
    assert b[192:196] in (b"EDF+",) and b[196:197] in (b"C", b"D") and int(b[184:192]) == 256 * (ns + 1)
    assert len(b) == 256 * (ns + 1) + n * 2 * (NS_REC + ANN_SAMPLES), "size"
    rec = 2 * (NS_REC + ANN_SAMPLES); prev = -1; ons = []
    for r in range(n):
        tal = b[256 * 3 + r * rec + 2 * NS_REC:][: 2 * ANN_SAMPLES]
        first = tal.split(b"\x00")[0]; on = float(first.split(b"\x14")[0]); assert first.startswith(b"+") and first.split(b"\x14")[1] == b""
        assert on > prev; prev = on; ons.append(on)
    gaps = [round(ons[i + 1] - ons[i] - DUR, 6) for i in range(n - 1)]
    kind = b[196:197].decode()
    assert (kind == "C") == all(g == 0 for g in gaps), ("C/D label inconsistent with TALs", kind, gaps)
    return kind, ons, gaps

# EDF+D: records at 0,1 then 10,11 (8 s gap). EDF+C: 0,1,2,3.  Annotations: "E1" at true 0.5 s, "E2" at true 10.5 s (EDF+D) / 2.5 s (EDF+C)
write_edf(f"{OUT}/gap.edf", "D", [0, 1, 10, 11], {0: (0.5, "E1"), 2: (10.5, "E2")})
write_edf(f"{OUT}/cont.edf", "C", [0, 1, 2, 3], {0: (0.5, "E1"), 2: (2.5, "E2")})
# negative control: continuous header/time-keeping but ramp values shifted +8 s after record 2 (what the buggy reading would look like)
write_edf(f"{OUT}/gap2.edf", "D", [0, 1, 3, 4], {0: (0.5, "E1"), 2: (3.5, "E2")})   # 1 s gap; E2 at TRUE 3.5 s stays inside the 0-3.9 s axis
for p in ("gap.edf", "gap2.edf", "cont.edf"): print("spec-validate", p, validate_edf(f"{OUT}/{p}"))

def placement_error(values_uV, sfreq):
    """max |value - sample_index/sfreq|: 0 means samples sit on their true time IF the file is contiguous from 0."""
    return float(np.max(np.abs(values_uV - np.arange(len(values_uV)) / sfreq)))

def report(label, vals, times, ann):
    print(f"  {label}: n={len(vals)}  sample 20 (index 2.0 s on axis) holds value {vals[20]:.2f} uV (true time {vals[20]:.2f} s) ; ann onsets={ann}")

print("\n== MNE direct ==")
res = {}
for nm in ("cont", "gap"):
    raw = mne.io.read_raw_edf(f"{OUT}/{nm}.edf", preload=True, verbose="ERROR")
    v = raw.get_data()[0] * 1e6; sf = raw.info["sfreq"]
    ann = list(zip(np.round(raw.annotations.onset, 3), raw.annotations.description))
    report(nm, v, raw.times, ann)
    err = placement_error(v, sf); res[nm] = err
    print(f"  {nm}: max |true_time(value) - mne_time_axis| = {err:.3f} s ; times[-1]={raw.times[-1]:.1f}")
# oracle self-test: a tampered continuous file (EDF+C whose ramp jumps +8 s after record 2 but TALs say contiguous) must be flagged
import shutil as _sh
write_edf(f"{OUT}/oracle_tamper.edf", "C", [0, 1, 10, 11], {})   # ramp has 8 s jump, header says contiguous?  (TALs 0,1,10,11 -> would be D); force C label:
b = bytearray(open(f"{OUT}/oracle_tamper.edf", "rb").read()); b[196:197] = b"C"; open(f"{OUT}/oracle_tamper.edf", "wb").write(bytes(b))
raw = mne.io.read_raw_edf(f"{OUT}/oracle_tamper.edf", preload=True, verbose="ERROR")
print(f"  oracle control (jumpy ramp, no gap marker): error={placement_error(raw.get_data()[0]*1e6, raw.info['sfreq']):.3f} s  -> detector fires (>0)")
assert res["cont"] < 1e-6, "oracle broken: continuous EDF+C must read exactly"
assert res["gap"] > 1.0, "gap file did not show shift"

print("\n== MNE direct, small-gap file (annotation survives cropping) ==")
raw = mne.io.read_raw_edf(f"{OUT}/gap2.edf", preload=True, verbose="ERROR")
v = raw.get_data()[0] * 1e6
print("  gap2 annotations:", list(zip(np.round(raw.annotations.onset, 3), raw.annotations.description)),
      "| value at the sample E2 marks (axis 3.5 s -> idx 35) =", round(float(v[35]), 2), "uV = TRUE time", round(float(v[35]), 2), "s (E2 true onset 3.5 s)")
print("  gap2 value[20..21] (axis 2.0 s, true 3.0 s):", np.round(v[20:22], 2), " max placement error =", round(placement_error(v, raw.info['sfreq']), 3), "s")

print("\n== biosigIO in-memory (EDFImporter.load) ==")
from biosigio.importers.edf import EDFImporter
for nm in ("cont", "gap", "gap2"):
    rec = EDFImporter().load(f"{OUT}/{nm}.edf")
    data = np.asarray(rec.signals)[:, 0]; sf = rec.get_sampling_frequency()
    print(f"  {nm}: n={len(data)} value[20]={data[20]:.2f} placement_error={placement_error(data, sf):.3f}s events={rec.events[['onset','description']].values.tolist()} duration={rec.get_duration()} tolerant={rec.metadata.get('edf_tolerant_read_reason')}")

print("\n== biosigIO stream_to_zarr (float32) ==")
import zarr
from biosigio import stream_to_zarr
for nm in ("cont", "gap", "gap2"):
    store = f"{OUT}/{nm}.zarr"; shutil.rmtree(store, ignore_errors=True)
    p = stream_to_zarr(f"{OUT}/{nm}.edf", store, dtype="float32", min_view_samples=8)
    z = zarr.open(p, mode="r"); arrays = {}
    def walk(g, pre=""):
        for k, obj in g.members():
            if isinstance(obj, zarr.Array): arrays[pre + k] = obj
            else: walk(obj, pre + k + "/")
    walk(z)
    for k, a in arrays.items():
        if k.startswith("view") or "/view" in k: continue
        d = np.asarray(a[:]).astype(float)
        row = d[0] if d.shape[0] < d.shape[1] else d[:, 0]
        print(f"  {nm} {k} shape={d.shape} value@idx20={row[20]:.2f} placement_error={placement_error(row, FS):.3f}s")
    ev = [k for k in arrays if "event" in k.lower()]
    print("  ", nm, "events arrays:", ev, "| root attrs:", {k: v for k, v in z.attrs.items() if "event" in k.lower() or "duration" in k.lower()})
