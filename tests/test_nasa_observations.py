"""Safety/science contract tests. Small synthetic arrays are test inputs only."""
import contextlib
import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
import nasa_observations as nasa


def entry(product="VJ146A3", year=2026, doy=274, size=100):
    name = f"{product}.A{year}{doy:03d}.h30v05.002.2026330000000.h5"
    return {"name": name, "downloadsLink": f"{nasa.BASE}/{product}/{year}/{doy:03d}/{name}",
            "size": size, "status": "Online", "resourceType": "File", "mtime": 0}


def directories(*numbers):
    return [{"name": str(n), "resourceType": "Directory"} for n in numbers]


class FakeClient:
    def __init__(self):
        self.calls = []

    def listing(self, product, year=None, doy=None):
        self.calls.append((product, year, doy))
        if year is None:
            return directories(2027, 2026, 2025)
        if doy is None:
            return directories("305", "274")
        return [entry(product, year, doy)]


class Response:
    def __init__(self, status=200, headers=None, content=b""):
        self.status_code = status
        self.headers = headers or {}
        self.content = content
        self.closed = False

    def close(self):
        self.closed = True

    def iter_content(self, blocksize):
        yield self.content


class NasaTests(unittest.TestCase):
    def test_discovery_uses_completed_month_and_same_month_previous_year(self):
        client = FakeClient()
        plan = nasa.discover(client, dt.date(2026, 11, 23))
        self.assertEqual(plan["latest_month"], "2026-10")
        self.assertEqual(plan["comparison_month"], "2025-10")
        self.assertEqual(plan["latest_annual"]["period"], "2025")
        self.assertNotIn(("VJ146A3", 2026, 305), client.calls)
        self.assertFalse(plan["scientific_validation_completed"])
        self.assertFalse(plan["artwork_rendered"])

    def test_leap_year_uses_actual_previous_month_doy(self):
        client = FakeClient()
        nasa.discover(client, dt.date(2025, 11, 23))
        self.assertIn(("VJ146A3", 2024, 275), client.calls)

    def test_canonical_url_and_product_are_enforced(self):
        row = entry()
        row["downloadsLink"] = row["downloadsLink"].replace(nasa.HOST, "example.com")
        with self.assertRaises(nasa.ObservationError):
            nasa.normalize_record(row, "VJ146A3", 2026, 274)
        with self.assertRaises(nasa.ObservationError):
            nasa.normalize_record(entry(), "VJ146A4", 2026, 274)

    def test_local_plan_cannot_change_period_or_url(self):
        plan = nasa.discover(FakeClient(), dt.date(2026, 11, 23))
        plan["monthly_pair"][1]["period"] = "2026-09"
        with self.assertRaises(nasa.ObservationError):
            nasa.checked_pair(plan)

    def test_token_file_must_be_in_ignored_runtime_and_symlinks_resolved(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".runtime").mkdir()
            (root / ".gitignore").write_text(".runtime/\n")
            outside = root / "public-token"
            outside.write_text("secret-test-value")
            link = root / ".runtime/token-link"
            link.symlink_to(outside)
            with patch.object(nasa, "ROOT", root):
                for path in [outside, link]:
                    with self.assertRaises(nasa.ObservationError):
                        nasa.load_token(path)
                private = root / ".runtime/token"
                private.write_text("secret-test-value\n")
                self.assertEqual(nasa.load_token(private), "secret-test-value")
                (root / ".gitignore").write_text("")
                with self.assertRaises(nasa.ObservationError):
                    nasa.load_token(private)

    def test_redirect_never_sends_token_to_another_host(self):
        client = nasa.LaadsClient()
        try:
            response = Response(303, {"Location": "https://urs.earthdata.nasa.gov/oauth/authorize"})
            with patch.object(client.session, "get", return_value=response) as request:
                with self.assertRaises(nasa.ObservationError) as error:
                    client.request(f"{nasa.BASE}/VJ146A3/", token="secret-test-value")
                self.assertEqual(request.call_count, 1)
                self.assertFalse(request.call_args.kwargs["allow_redirects"])
                self.assertNotIn("secret-test-value", str(error.exception))
                self.assertTrue(response.closed)
                self.assertFalse(client.session.trust_env)
        finally:
            client.close()

    def test_quality_mask_retains_real_zero_and_rejects_bad_or_missing_data(self):
        radiance = np.array([[0, 1, 2, 3, -999.9, np.nan, np.inf, 8, 9, 10]], dtype="float32")
        quality = np.array([[0, 1, 2, 255, 0, 0, 0, 0, 0, 0]], dtype="uint8")
        count = np.array([[4, 6, 6, 6, 6, 6, 6, 3, 65535, 5]], dtype="uint16")
        valid = nasa.quality_mask(radiance, quality, count, -999.9)
        self.assertEqual(valid.tolist(), [[True, False, False, False, False, False, False, False, False, True]])
        quality[0, 0] = 17
        with self.assertRaises(nasa.ObservationError):
            nasa.quality_mask(radiance, quality, count, -999.9)

    def test_size_signature_and_sha_are_checked(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "file.h5"
            content = nasa.HDF5_MAGIC + b"not-a-real-science-file"
            path.write_bytes(content)
            row = nasa.normalize_record(entry(size=len(content)), "VJ146A3", 2026, 274)
            self.assertEqual(nasa.verify_file(path, row)["sha256"], hashlib.sha256(content).hexdigest())
            path.write_bytes(b"<html>login</html>")
            row["size"] = path.stat().st_size
            with self.assertRaises(nasa.ObservationError):
                nasa.verify_file(path, row)
            row["size"] += 1
            with self.assertRaises(nasa.ObservationError):
                nasa.verify_file(path, row)

    def test_login_download_does_not_leave_a_raw_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".gitignore").write_text(".runtime/\n")
            row = nasa.normalize_record(entry(), "VJ146A3", 2026, 274)
            response = Response(headers={"Content-Type": "text/html"}, content=b"login")
            client = type("Client", (), {"request": lambda self, *args, **kwargs: response})()
            with patch.object(nasa, "ROOT", root):
                with self.assertRaises(nasa.ObservationError):
                    nasa.acquire(row, root / ".runtime/nasa", client=client, token="secret-test-value")
            self.assertEqual(list((root / ".runtime/nasa/raw").iterdir()), [])

    def test_check_mode_never_reads_a_token_or_downloads_science(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".gitignore").write_text(".runtime/\n")
            plan = nasa.discover(FakeClient(), dt.date(2026, 11, 23))
            with patch.object(nasa, "ROOT", root), patch.object(nasa, "discover", return_value=plan), \
                    patch.object(nasa, "load_token") as token, patch.object(nasa, "acquire") as acquire, \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(nasa.main(["--check", "--out", str(root / ".runtime/nasa")]), 0)
                token.assert_not_called()
                acquire.assert_not_called()
            written = json.loads((root / ".runtime/nasa/check.json").read_text())
            self.assertFalse(written["scientific_validation_completed"])

    def test_interrupted_or_oversized_download_is_cleaned_and_sanitized(self):
        import requests
        class Interrupted(Response):
            def iter_content(self, blocksize):
                yield nasa.HDF5_MAGIC
                raise requests.ConnectionError("secret-test-value must not escape")
        for response in [Interrupted(), Response(content=nasa.HDF5_MAGIC + b"x" * 200)]:
            with tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                (root / ".gitignore").write_text(".runtime/\n")
                row = nasa.normalize_record(entry(), "VJ146A3", 2026, 274)
                client = type("Client", (), {"request": lambda self, *args, **kwargs: response})()
                with patch.object(nasa, "ROOT", root):
                    with self.assertRaises(nasa.ObservationError) as error:
                        nasa.acquire(row, root / ".runtime/nasa", client=client, token="secret-test-value")
                    self.assertNotIn("secret-test-value", str(error.exception))
                    self.assertEqual(list((root / ".runtime/nasa/raw").iterdir()), [])
                    self.assertTrue(response.closed)

    def test_geotiff_extraction_checks_hdf_metadata_and_keeps_nodata_distinct(self):
        import h5py
        import rasterio
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".gitignore").write_text(".runtime/\n")
            row = nasa.normalize_record(entry(), "VJ146A3", 2026, 274)
            path = root / row["name"]
            with h5py.File(path, "w") as handle:
                for key, value in {"LocalGranuleID": row["name"], "RangeBeginningDate": row["period_start"],
                                   "RangeEndingDate": row["period_end"], "ShortName": "VJ146A3", "PlatformShortName": "JPSS-1",
                                   "identifier_product_doi": "10.5067/VIIRS/VJ146A3.002", "NorthBoundingCoord": 40,
                                   "SouthBoundingCoord": 30, "EastBoundingCoord": 130, "WestBoundingCoord": 120}.items():
                    handle.attrs[key] = value
                handle.create_dataset("HDFEOS INFORMATION/StructMetadata.0", data=b"Projection=HE5_GCTP_GEO\nGridOrigin=HE5_HDFE_GD_UL")
                fields = handle.create_group(nasa.GROUP)
                values = fields.create_dataset(nasa.LAYER, shape=(2400, 2400), dtype="float32", fillvalue=1, compression="gzip")
                values.attrs.update({"scale_factor": 1.0, "offset": 0.0, "_FillValue": np.float32(-999.9), "units": "nWatts/(cm^2 sr)"})
                values[0, 0] = 0
                values[0, 1] = -999.9
                quality = fields.create_dataset(nasa.LAYER + "_Quality", shape=(2400, 2400), dtype="uint8", fillvalue=0, compression="gzip")
                quality.attrs["_FillValue"] = 255
                quality[0, 2] = 2
                count = fields.create_dataset(nasa.LAYER + "_Num", shape=(2400, 2400), dtype="uint16", fillvalue=8, compression="gzip")
                count.attrs["_FillValue"] = 65535
                count[0, 3] = 3
                fields.create_dataset("lat", data=40 - np.arange(2400) / 240)
                fields.create_dataset("lon", data=120 + np.arange(2400) / 240)
            row["size"] = path.stat().st_size
            destination = root / ".runtime/nasa/rasters/example.tif"
            with patch.object(nasa, "ROOT", root):
                receipt = nasa.extract_raster(path, row, destination)
                with rasterio.open(destination) as image:
                    self.assertEqual(image.crs.to_epsg(), 4326)
                    self.assertEqual(tuple(image.bounds), (120, 30, 130, 40))
                    self.assertEqual(image.read(1, window=((0, 1), (0, 4))).tolist(), [[0, nasa.NODATA, nasa.NODATA, nasa.NODATA]])
                self.assertEqual(receipt["true_zero_valid_pixels"], 1)
                self.assertTrue(receipt["scientific_validation_completed"])
                self.assertFalse(receipt["artwork_rendered"])
                self.assertEqual(receipt["raster_sha256"], hashlib.sha256(destination.read_bytes()).hexdigest())
                with h5py.File(path, "r+") as handle:
                    handle[nasa.GROUP + "/" + nasa.LAYER].attrs["scale_factor"] = .1
                row["size"] = path.stat().st_size
                with self.assertRaises(nasa.ObservationError):
                    nasa.extract_raster(path, row, root / ".runtime/nasa/rasters/bad.tif")
                self.assertFalse((root / ".runtime/nasa/rasters/bad.tif").exists())


if __name__ == "__main__":
    unittest.main()
