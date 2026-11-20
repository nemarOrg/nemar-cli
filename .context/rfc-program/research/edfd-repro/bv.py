"""BrainVision: two segments stored contiguously in .eeg, second 'New Segment' marker carries a wall-clock date 10 s after the first segment's start (segment 1 is 5 s long, so 5 s wall-clock gap).
Signal value (uV) == WALL-CLOCK seconds since the first segment start. Markers: S1 at wall 2.0 s (seg 1), S2 at wall 12.0 s (seg 2)."""
import os, sys, warnings, numpy as np, mne
warnings.simplefilter("ignore")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "files"); os.makedirs(OUT, exist_ok=True)
print("mne", mne.__version__)
SF = 100
def write_bv(stem, segs):
    """segs: list of (wall_start_s, n_samples). wall-clock start of file = 12:00:00 on 2020-01-01."""
    vals = np.concatenate([w + np.arange(n) / SF for w, n in segs]); dig = np.round(vals * 100).astype("<i2")
    dig.tofile(f"{OUT}/{stem}.eeg")
    open(f"{OUT}/{stem}.vhdr", "w").write(f"""Brain Vision Data Exchange Header File Version 1.0
[Common Infos]
Codepage=UTF-8
DataFile={stem}.eeg
MarkerFile={stem}.vmrk
DataFormat=BINARY
DataOrientation=MULTIPLEXED
NumberOfChannels=1
SamplingInterval={int(1e6/SF)}
[Binary Infos]
BinaryFormat=INT_16
[Channel Infos]
Ch1=Ramp,,0.01,uV
""")
    mk, pos = [], 1
    for i, (w, n) in enumerate(segs):
        sec = int(w); date = f"20200101{12:02d}{sec//60:02d}{sec%60:02d}000000"
        mk.append(f"Mk{len(mk)+1}=New Segment,,{pos},1,0,{date}"); 
        stim_wall = w + 2.0; mk.append(f"Mk{len(mk)+1}=Stimulus,S{i+1},{pos + 200},1,0")
        pos += n
    open(f"{OUT}/{stem}.vmrk", "w").write("Brain Vision Data Exchange Marker File, Version 1.0\n[Common Infos]\nCodepage=UTF-8\nDataFile=%s.eeg\n[Marker Infos]\n" % stem + "\n".join(mk) + "\n")
write_bv("bv_gap", [(0.0, 500), (10.0, 500)])    # seg2 starts 10 s wall-clock after seg1 (seg1 ends at 5 s)
write_bv("bv_cont", [(0.0, 1000)])               # control: one continuous segment, markers S1 only
def err(v, sf): return float(np.max(np.abs(v - np.arange(len(v)) / sf)))
for stem in ("bv_cont", "bv_gap"):
    raw = mne.io.read_raw_brainvision(f"{OUT}/{stem}.vhdr", preload=True, verbose="ERROR")
    v = raw.get_data()[0] * 1e6
    print(stem, "n=", len(v), "placement_error vs wall-clock =", round(err(v, SF), 3), "s | value@idx500 =", round(float(v[500]), 2),
          "| annotations:", [(round(float(o), 2), d) for o, d in zip(raw.annotations.onset, raw.annotations.description)],
          "| meas_date:", raw.info["meas_date"])
# sample-axis consistency of markers vs samples (the thing BV positions define):
raw = mne.io.read_raw_brainvision(f"{OUT}/bv_gap.vhdr", preload=True, verbose="ERROR"); v = raw.get_data()[0] * 1e6
for o, d in zip(raw.annotations.onset, raw.annotations.description):
    if "Stimulus" in d: print("  marker", d, "at axis", round(float(o), 2), "s marks sample whose wall-clock is", round(float(v[int(round(o*SF))]), 2), "s (seg-relative +2.0 s)")
from biosigio.importers.brainvision import BrainVisionImporter
rec = BrainVisionImporter().load(f"{OUT}/bv_gap.vhdr"); print("biosigio BV events:", rec.events[["onset", "description"]].values.tolist(), "duration", rec.get_duration())
