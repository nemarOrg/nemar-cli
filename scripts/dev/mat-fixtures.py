"""Write the edited MATLAB fixtures of card A5 from the real ones (test/fixtures/mat/README.md).

    uv run --with 'scipy==1.18.1' --with 'h5py==3.16.0' python scripts/dev/mat-fixtures.py test/fixtures/mat

Every value written is made up; no real person is named.
"""

import shutil
import sys
from pathlib import Path

import h5py
import numpy as np
import scipy.io

NAME = "Quillfeather Marlow"
HOME_PATH = "/Users/qmarlow/studies/rest/"


def classic(out: Path) -> None:
    """eeglab_data.set with a made-up name in `subject` and a home path in `filepath`."""
    data = scipy.io.loadmat(out / "eeglab-data.set", struct_as_record=True, squeeze_me=False)
    eeg = data["EEG"]
    eeg[0, 0]["subject"] = np.array([NAME])
    eeg[0, 0]["filepath"] = np.array([HOME_PATH])
    variables = {k: v for k, v in data.items() if not k.startswith("__")}
    scipy.io.savemat(out / "eeglab-data-edited.set", variables, format="5", do_compression=False)


def char_dataset(group: h5py.Group, name: str, text: str) -> None:
    """Replace a field with a MATLAB v7.3 character array (uint16, column vector)."""
    if name in group:
        del group[name]
    ds = group.create_dataset(name, data=np.array([[ord(c)] for c in text], dtype=np.uint16))
    ds.attrs.create("MATLAB_class", np.bytes_("char"))
    ds.attrs.create("MATLAB_int_decode", np.int32(2))


def v73(out: Path, source: Path) -> None:
    """The v7.3 EEGLAB fixture of card A3 with the same two edits."""
    target = out / "eeglab-data-v73-edited.set"
    shutil.copyfile(source, target)
    with h5py.File(target, "r+") as f:
        char_dataset(f["EEG"], "subject", NAME)
        char_dataset(f["EEG"], "filepath", HOME_PATH)


if __name__ == "__main__":
    out = Path(sys.argv[1])
    classic(out)
    v73(out, out.parent / "hdf5" / "eeglab-data-v73.set")
