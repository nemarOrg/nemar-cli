import base64
import re
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest
import scipy.io
from nibabel.gifti import GiftiDataArray, GiftiImage

from ieeg_geometry.bids import GeometryRefusal
from ieeg_geometry.surfaces import (
    Surface,
    guess_hemisphere,
    read_freesurfer,
    read_gifti,
    read_mat,
    read_surface,
)

from .conftest import icosphere

GII = "derivatives/freesurfer/sub-2/pial.R.surf.gii"


def _raw_pointset(path: Path) -> np.ndarray:
    """The POINTSET payload as stored, still a flat float32 stream."""
    text = path.read_text()
    match = re.search(r'Intent="NIFTI_INTENT_POINTSET".*?<Data>(.*?)</Data>', text, re.S)
    assert match is not None
    return np.frombuffer(base64.b64decode(match.group(1)), dtype="<f4")


def test_gifti_column_major_is_read_correctly(mini):
    path = mini / GII
    assert 'ArrayIndexingOrder="ColumnMajorOrder"' in path.read_text()
    surf = read_gifti(path)
    flat = _raw_pointset(path)
    n = len(surf.vertices)
    right = flat.reshape(3, n).T  # column-major: all x, then all y, then all z
    wrong = flat.reshape(n, 3)  # what a row-major reader would return
    np.testing.assert_allclose(surf.vertices, right, rtol=1e-6)
    ext_right = np.ptp(right, axis=0)
    ext_wrong = np.ptp(wrong, axis=0)
    # the real right hemisphere is a few tens of mm across; row-major shuffles x, y and z
    assert np.allclose(np.ptp(surf.vertices, axis=0), ext_right)
    assert np.abs(ext_wrong - ext_right).max() > 20.0
    assert surf.hemisphere == "R"
    assert surf.faces.max() < n


@pytest.mark.parametrize("encoding", ["ASCII", "B64BIN", "B64GZ"])
@pytest.mark.parametrize("ordering", ["C", "F"])
def test_gifti_encodings_and_orders_round_trip(tmp_path, sphere, encoding, ordering):
    img = GiftiImage(
        darrays=[
            GiftiDataArray(
                sphere.vertices.astype(np.float32),
                intent="NIFTI_INTENT_POINTSET",
                datatype="float32",
                encoding=encoding,
                ordering=ordering,
            ),
            GiftiDataArray(
                sphere.faces.astype(np.int32),
                intent="NIFTI_INTENT_TRIANGLE",
                datatype="int32",
                encoding=encoding,
                ordering=ordering,
            ),
        ]
    )
    path = tmp_path / "lh.pial.surf.gii"
    nib.save(img, str(path))
    back = read_gifti(path)
    np.testing.assert_allclose(back.vertices, sphere.vertices, atol=1e-5)
    np.testing.assert_array_equal(back.faces, sphere.faces)
    assert back.hemisphere == "L"


def test_freesurfer_c_ras_footer_is_read(mini):
    surf = read_freesurfer(mini / "derivatives/freesurfer-7.3.2/sub-1/surf/lh.pial")
    assert surf.c_ras == pytest.approx((3.09983826, -10.24856567, 16.29970551))
    assert surf.hemisphere == "L"


@pytest.mark.filterwarnings("ignore:No volume information", "ignore:Unknown extension")
def test_freesurfer_without_footer_has_no_c_ras(tmp_path, sphere):
    path = tmp_path / "rh.pial"
    nib.freesurfer.write_geometry(str(path), sphere.vertices, sphere.faces)
    surf = read_freesurfer(path)
    assert surf.c_ras is None
    assert surf.hemisphere == "R"
    np.testing.assert_allclose(surf.vertices, sphere.vertices, atol=1e-5)


def test_read_surface_dispatches_on_suffix(mini):
    assert read_surface(mini / GII).hemisphere == "R"
    assert read_surface(mini / "derivatives/freesurfer-7.3.2/sub-1/surf/rh.pial").c_ras


@pytest.mark.parametrize(
    "names", [("vert", "tri"), ("Vertices", "Faces"), ("pos", "tri"), ("pnt", "tri")]
)
def test_matlab_struct_fields_are_one_based(tmp_path, sphere, names):
    path = tmp_path / "MNI_cortex_left.mat"
    scipy.io.savemat(path, {"cortex": {names[0]: sphere.vertices, names[1]: sphere.faces + 1}})
    surf = read_mat(path)
    np.testing.assert_allclose(surf.vertices, sphere.vertices)
    np.testing.assert_array_equal(surf.faces, sphere.faces)
    assert surf.hemisphere == "L"


def test_matlab_top_level_variables_and_transposed_arrays(tmp_path, sphere):
    path = tmp_path / "x.mat"
    scipy.io.savemat(path, {"vert": sphere.vertices.T, "tri": (sphere.faces + 1).T})
    surf = read_mat(path)
    np.testing.assert_allclose(surf.vertices, sphere.vertices)
    np.testing.assert_array_equal(surf.faces, sphere.faces)


def test_matlab_zero_based_faces_are_refused(tmp_path, sphere):
    path = tmp_path / "x.mat"
    scipy.io.savemat(path, {"cortex": {"vert": sphere.vertices, "tri": sphere.faces}})
    with pytest.raises(GeometryRefusal) as exc:
        read_mat(path)
    assert exc.value.reason == "mat-faces-base"


def test_matlab_other_shapes_are_refused(tmp_path, sphere):
    path = tmp_path / "x.mat"
    scipy.io.savemat(path, {"cortex": {"vert": sphere.vertices[:, :2], "tri": sphere.faces + 1}})
    with pytest.raises(GeometryRefusal) as exc:
        read_mat(path)
    assert exc.value.reason == "mat-shape"


def test_matlab_meters_are_scaled_and_implausible_extents_refused(tmp_path):
    small = icosphere(2, radius=0.08)  # a 160 mm head expressed in meters
    path = tmp_path / "m.mat"
    scipy.io.savemat(path, {"cortex": {"vert": small.vertices, "tri": small.faces + 1}})
    assert np.ptp(read_mat(path).vertices, axis=0).max() == pytest.approx(160.0, rel=0.01)
    tiny = icosphere(2, radius=0.0001)
    scipy.io.savemat(path, {"cortex": {"vert": tiny.vertices, "tri": tiny.faces + 1}})
    with pytest.raises(GeometryRefusal) as exc:
        read_mat(path)
    assert exc.value.reason == "mat-units"


def test_matlab_v73_is_refused(tmp_path):
    path = tmp_path / "big.mat"
    header = (
        b"MATLAB 7.3 MAT-file, Platform: GLNXA64, Created on: Mon Jan 1 2024 HDF5 schema 1.00 ."
    )
    path.write_bytes(header.ljust(116) + b"\0" * 12)
    with pytest.raises(GeometryRefusal) as exc:
        read_mat(path)
    assert exc.value.reason == "mat-v73"


def test_matlab_without_a_surface_is_refused(tmp_path):
    path = tmp_path / "x.mat"
    scipy.io.savemat(path, {"a": np.zeros(3)})
    with pytest.raises(GeometryRefusal) as exc:
        read_mat(path)
    assert exc.value.reason == "mat-no-surface"


def test_face_index_outside_vertices_is_refused():
    with pytest.raises(GeometryRefusal) as exc:
        Surface(np.zeros((3, 3)), np.array([[0, 1, 5]]))
    assert exc.value.reason == "surface-invalid"


def test_closed_detection(sphere):
    assert sphere.is_closed
    assert not Surface(sphere.vertices, sphere.faces[1:]).is_closed


@pytest.mark.parametrize(
    ("name", "hemi"),
    [
        ("lh.pial", "L"),
        ("rh.pial", "R"),
        ("pial.R.surf.gii", "R"),
        ("sub-1_hemi-L_pial.gii", "L"),
        ("MNI_cortex_left.mat", "L"),
        ("pial", None),
    ],
)
def test_guess_hemisphere(name, hemi):
    assert guess_hemisphere(name) == hemi


def test_gifti_transform_is_applied_and_spaces_recorded(tmp_path, sphere):
    from nibabel.gifti import GiftiCoordSystem

    xform = np.eye(4)
    xform[:3, 3] = [100.0, 0.0, -5.0]
    point = GiftiDataArray(
        sphere.vertices.astype(np.float32), intent="NIFTI_INTENT_POINTSET", datatype="float32"
    )
    point.coordsys = GiftiCoordSystem(dataspace=0, xformspace=4, xform=xform)
    tri = GiftiDataArray(sphere.faces.astype(np.int32), intent="NIFTI_INTENT_TRIANGLE")
    path = tmp_path / "lh.pial.surf.gii"
    nib.save(GiftiImage(darrays=[point, tri]), str(path))
    surf = read_gifti(path)
    np.testing.assert_allclose(surf.vertices, sphere.vertices + [100.0, 0.0, -5.0], atol=1e-4)
    assert surf.spaces == ("unknown", "mni")


def test_gifti_volgeom_metadata_is_c_ras(tmp_path, sphere):
    from nibabel.gifti import GiftiMetaData

    meta = GiftiMetaData({"VolGeomC_R": "1.5", "VolGeomC_A": "-2.5", "VolGeomC_S": "3"})
    point = GiftiDataArray(
        sphere.vertices.astype(np.float32),
        intent="NIFTI_INTENT_POINTSET",
        datatype="float32",
        meta=meta,
    )
    tri = GiftiDataArray(sphere.faces.astype(np.int32), intent="NIFTI_INTENT_TRIANGLE")
    path = tmp_path / "rh.pial.surf.gii"
    nib.save(GiftiImage(darrays=[point, tri]), str(path))
    assert read_gifti(path).c_ras == (1.5, -2.5, 3.0)


def test_malformed_volume_info_keeps_the_geometry(tmp_path, sphere):
    path = tmp_path / "lh.pial"
    info = {
        "head": np.array([2, 0, 20]),
        "valid": "1  # volume info valid",
        "filename": "x.mgz",
        "volume": np.array([256, 256, 256]),
        "voxelsize": np.array([1.0, 1.0, 1.0]),
        "xras": np.array([-1.0, 0, 0]),
        "yras": np.array([0, 0, -1.0]),
        "zras": np.array([0, 1.0, 0]),
        "cras": np.array([1.0, 2.0, 3.0]),
    }
    nib.freesurfer.write_geometry(str(path), sphere.vertices, sphere.faces, volume_info=info)
    assert read_freesurfer(path).c_ras == (1.0, 2.0, 3.0)
    path.write_bytes(path.read_bytes()[:-60])  # cut into the footer
    with pytest.warns(UserWarning, match="c_ras unknown"):
        surf = read_freesurfer(path)
    assert surf.c_ras is None
    np.testing.assert_allclose(surf.vertices, sphere.vertices, atol=1e-5)
