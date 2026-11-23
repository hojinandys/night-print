"""Collect a separate NASA Black Marble observation pair; never publish artwork.

Examples (run from the project directory):
  python pipeline/nasa_observations.py --check
  python pipeline/nasa_observations.py --import-file /path/to/VJ146A3....h5
  python pipeline/nasa_observations.py --download --token-file .runtime/earthdata-token

--check fetches public listings only. Import/download verifies the official name,
size, HDF5 signature and scientific metadata, then writes a quality-masked GeoTIFF.
All outputs and token files must stay in the ignored .runtime directory. Tokens
are never written to receipts or printed, and never follow a cross-host redirect.
This series is not appended to the EOG/WorldPop 2015–2023 edition.
"""
from __future__ import annotations

import argparse
import calendar
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
from urllib.parse import urljoin, urlsplit

ROOT = Path(__file__).resolve().parents[1]
HOST = "ladsweb.modaps.eosdis.nasa.gov"
BASE = f"https://{HOST}/archive/allData/5200"
TILE = "h30v05"
GROUP = "HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields"
LAYER = "AllAngle_Composite_Snow_Free"
HDF5_MAGIC = b"\x89HDF\r\n\x1a\n"
NODATA = -9999.0
MAX_FILE_BYTES = 512 * 1024 * 1024
NAME = re.compile(r"(VJ146A[34])\.A(\d{4})(\d{3})\.h30v05\.002\.(\d{13})\.h5")


class ObservationError(ValueError):
    """A source, authentication or scientific validation failed."""


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def private_path(path):
    """Resolve symlinks before checking the output/secret boundary."""
    runtime = ROOT / ".runtime"
    if runtime.is_symlink():
        raise ObservationError("The .runtime directory must not be a symbolic link.")
    resolved = Path(path).expanduser().resolve()
    if not resolved.is_relative_to(runtime.resolve()) or resolved == runtime.resolve():
        raise ObservationError("Output and token files must be inside the project's ignored .runtime directory.")
    ignore = ROOT / ".gitignore"
    rules = ignore.read_text(encoding="utf-8").splitlines() if ignore.is_file() else []
    if not any(line.strip() in {".runtime/", "/.runtime/"} for line in rules):
        raise ObservationError("A .runtime/ entry is required in the project .gitignore.")
    return resolved


def load_token(token_file=None):
    if token_file:
        path = private_path(token_file)
        if not path.is_file() or path.stat().st_size > 8192:
            raise ObservationError("The private token file is missing or has an invalid size.")
        token = path.read_text(encoding="utf-8").strip()
    else:
        token = os.environ.get("EARTHDATA_TOKEN", "").strip()
    if not 8 <= len(token) <= 8192 or not token.isascii() or any(c.isspace() for c in token):
        raise ObservationError("Supply a valid EARTHDATA_TOKEN or a token file inside .runtime.")
    return token


def nasa_url(url):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname != HOST or parsed.port not in (None, 443)
            or parsed.username or parsed.password or parsed.fragment):
        raise ObservationError("Only the official HTTPS LAADS host is allowed.")
    return url


class LaadsClient:
    def __init__(self):
        import requests
        self.session = requests.Session()
        # Never discover credentials in .netrc or forward them via environment proxies.
        self.session.trust_env = False
        self.session.headers["User-Agent"] = "NightPrint-NASA-ObservationCheck/1.0"

    def close(self):
        self.session.close()

    def request(self, url, token=None, stream=False):
        import requests
        current = nasa_url(url)
        for _ in range(4):
            try:
                response = self.session.get(current, headers={"Authorization": f"Bearer {token}"} if token else {},
                                            allow_redirects=False, stream=stream, timeout=(20, 90))
            except requests.RequestException:
                raise ObservationError("The NASA HTTPS request failed; no credentials were logged.") from None
            if response.status_code in {301, 302, 303, 307, 308}:
                location = response.headers.get("Location")
                response.close()
                if not location:
                    raise ObservationError("NASA returned a redirect without a destination.")
                destination = urljoin(current, location)
                # Refuse before issuing any request to a different host.
                try:
                    nasa_url(destination)
                except ObservationError:
                    raise ObservationError("NASA authentication is required; cross-host redirects are disabled.") from None
                current = destination
                continue
            if response.status_code != 200:
                status = response.status_code
                response.close()
                raise ObservationError(f"NASA request returned HTTP {status}; verify access or retry later.")
            return response
        raise ObservationError("Too many NASA redirects; verify Earthdata authentication.")

    def listing(self, product, year=None, doy=None):
        if product not in {"VJ146A3", "VJ146A4"}:
            raise ObservationError("An unreviewed NASA product was requested.")
        parts = [BASE, product]
        if year is not None:
            parts.append(str(int(year)))
        if doy is not None:
            parts.append(f"{int(doy):03d}")
        url = "/".join(parts) + "/.json"
        response = self.request(url)
        try:
            if "application/json" not in response.headers.get("Content-Type", "").lower():
                raise ObservationError("NASA returned a non-JSON listing, possibly a login page.")
            payload = response.json()
        except (ValueError, TypeError):
            raise ObservationError("NASA returned an invalid public listing.") from None
        finally:
            response.close()
        if not isinstance(payload, dict) or not isinstance(payload.get("content"), list):
            raise ObservationError("The NASA listing schema changed.")
        return payload["content"]


def period_start(year, doy):
    start = dt.date(int(year), 1, 1) + dt.timedelta(days=int(doy) - 1)
    if start.year != int(year) or start.day != 1:
        raise ObservationError("A composite must begin on a real first day of the month.")
    return start


def normalize_record(entry, product, year, doy):
    name = entry.get("name", "")
    match = NAME.fullmatch(name)
    if not match or (match[1], int(match[2]), int(match[3])) != (product, year, doy):
        raise ObservationError("The source filename does not match the requested composite.")
    start = period_start(year, doy)
    if product == "VJ146A4" and doy != 1:
        raise ObservationError("An annual composite must start on January 1.")
    url = f"{BASE}/{product}/{year}/{doy:03d}/{name}"
    if entry.get("downloadsLink", entry.get("url")) != url:
        raise ObservationError("The file URL differs from the canonical official archive URL.")
    size = entry.get("size")
    if type(size) is not int or not 8 < size <= MAX_FILE_BYTES:
        raise ObservationError("The official file size is missing or outside the reviewed limit.")
    if entry.get("status") != "Online":
        raise ObservationError("The selected NASA file is not online.")
    end = dt.date(year, 12, 31) if product == "VJ146A4" else dt.date(year, start.month, calendar.monthrange(year, start.month)[1])
    return {"product": product, "collection": "002", "archive_set": 5200, "tile": TILE,
            "name": name, "url": url, "size": size, "status": "Online", "mtime": entry.get("mtime"),
            "period_start": start.isoformat(), "period_end": end.isoformat(),
            "period": str(year) if product == "VJ146A4" else start.strftime("%Y-%m")}


def select_file(entries, product, year, doy):
    candidates = [e for e in entries if isinstance(e, dict) and NAME.fullmatch(e.get("name", ""))
                  and e.get("resourceType", "File") == "File"]
    candidates = [e for e in candidates if e["name"].startswith(f"{product}.A{year}{doy:03d}.")]
    if not candidates:
        return None
    # A reprocessed release has a later production timestamp in its filename.
    return normalize_record(max(candidates, key=lambda e: NAME.fullmatch(e["name"])[4]), product, year, doy)


def directory_numbers(entries, width):
    return sorted({int(e["name"]) for e in entries if isinstance(e, dict)
                   and e.get("resourceType") == "Directory"
                   and re.fullmatch(rf"\d{{{width}}}", str(e.get("name", "")))}, reverse=True)


def discover(client, today=None):
    today = today or dt.datetime.now(dt.timezone.utc).date()
    latest = None
    for year in directory_numbers(client.listing("VJ146A3"), 4):
        if not 2018 <= year <= today.year:
            continue
        for doy in directory_numbers(client.listing("VJ146A3", year), 3):
            start = period_start(year, doy)
            end = dt.date(year, start.month, calendar.monthrange(year, start.month)[1])
            if end >= today:
                continue
            latest = select_file(client.listing("VJ146A3", year, doy), "VJ146A3", year, doy)
            if latest:
                break
        if latest:
            break
    if not latest:
        raise ObservationError("No completed monthly h30v05 composite was found.")
    start = dt.date.fromisoformat(latest["period_start"])
    previous_start = start.replace(year=start.year - 1)
    previous_doy = previous_start.timetuple().tm_yday
    previous = select_file(client.listing("VJ146A3", previous_start.year, previous_doy),
                           "VJ146A3", previous_start.year, previous_doy)
    if not previous:
        raise ObservationError("The previous year's same-month composite is missing; no substitute is allowed.")
    annual = None
    for year in directory_numbers(client.listing("VJ146A4"), 4):
        if 2018 <= year < today.year:
            annual = select_file(client.listing("VJ146A4", year, 1), "VJ146A4", year, 1)
            if annual:
                break
    return {"schema": 1, "checked_utc": utc_now(), "state": "metadata_only", "status": "metadata_only", "tile": TILE,
            "source": "NASA Black Marble / NOAA-20 VIIRS / collection 002",
            "monthly_doi": "10.5067/VIIRS/VJ146A3.002", "annual_doi": "10.5067/VIIRS/VJ146A4.002",
            "latest_month": latest["period"], "comparison_month": previous["period"],
            "monthly_pair": [previous, latest], "latest_annual": annual,
            "comparison": "Same calendar month in consecutive years; a separate source from EOG/WorldPop.",
            "scientific_validation_completed": False, "artwork_rendered": False}


def checked_pair(plan):
    """Do not trust a local manifest's download URLs or period labels blindly."""
    pair = plan.get("monthly_pair", [])
    if len(pair) != 2:
        raise ObservationError("A checked plan must contain exactly two monthly composites.")
    result = []
    for record in pair:
        match = NAME.fullmatch(record.get("name", ""))
        if not match or match[1] != "VJ146A3":
            raise ObservationError("The checked plan contains an unreviewed product.")
        clean = normalize_record(record, match[1], int(match[2]), int(match[3]))
        if clean["period"] != record.get("period"):
            raise ObservationError("The checked plan has inconsistent period labels.")
        if dt.date.fromisoformat(clean["period_end"]) >= dt.datetime.now(dt.timezone.utc).date():
            raise ObservationError("An incomplete or future month cannot be imported.")
        result.append(clean)
    before, after = [dt.date.fromisoformat(r["period_start"]) for r in result]
    if before.month != after.month or before.year + 1 != after.year:
        raise ObservationError("The comparison must use the same month in consecutive years.")
    return result


def verify_file(path, record):
    path = Path(path)
    if not path.is_file() or path.stat().st_size != record["size"]:
        raise ObservationError("The HDF5 byte count does not match the official NASA listing.")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        if handle.read(8) != HDF5_MAGIC:
            raise ObservationError("The downloaded file is not HDF5; it may be a login page.")
        handle.seek(0)
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return {"name": record["name"], "bytes": record["size"], "sha256": digest.hexdigest(), "validated_utc": utc_now()}


def acquire(record, out, client=None, token=None, import_file=None):
    import requests
    raw = private_path(Path(out) / "raw" / record["name"])
    raw.parent.mkdir(parents=True, exist_ok=True)
    if raw.exists():
        return raw, verify_file(raw, record)
    temporary = raw.with_suffix(raw.suffix + ".part")
    try:
        if import_file is not None:
            source = Path(import_file).expanduser().resolve()
            if source.name != record["name"]:
                raise ObservationError("The imported filename must exactly match the official NASA filename.")
            verify_file(source, record)
            shutil.copyfile(source, temporary)
        else:
            if client is None or not token:
                raise ObservationError("Authenticated downloads require an Earthdata token.")
            response = client.request(record["url"], token=token, stream=True)
            try:
                content_type = response.headers.get("Content-Type", "").lower()
                if "html" in content_type or "json" in content_type:
                    raise ObservationError("NASA returned a login or error page instead of HDF5.")
                written = 0
                with temporary.open("wb") as handle:
                    for block in response.iter_content(1024 * 1024):
                        if not block:
                            continue
                        written += len(block)
                        if written > record["size"]:
                            raise ObservationError("The download exceeds the official file size.")
                        handle.write(block)
            except requests.RequestException:
                raise ObservationError("The NASA download was interrupted; no credentials were logged.") from None
            finally:
                response.close()
        receipt = verify_file(temporary, record)
        temporary.replace(raw)
        return raw, receipt
    finally:
        temporary.unlink(missing_ok=True)


def scalar(value):
    import numpy as np
    array = np.asarray(value)
    if array.size != 1:
        raise ObservationError("An HDF5 metadata attribute is not scalar.")
    item = array.reshape(-1)[0]
    return item.decode("utf-8").strip() if isinstance(item, bytes) else item.item() if hasattr(item, "item") else item


def quality_mask(radiance, quality, count, fill):
    import numpy as np
    if radiance.shape != quality.shape or radiance.shape != count.shape:
        raise ObservationError("Radiance, observation count and quality grids do not align.")
    if not np.isin(quality, [0, 1, 2, 255]).all():
        raise ObservationError("An unknown composite quality flag requires review.")
    return np.isfinite(radiance) & (radiance >= 0) & (radiance != fill) & (quality == 0) & (count > 3) & (count != 65535)


def extract_raster(path, record, destination):
    """Read real scientific fields, retain true zero, and mask every invalid pixel."""
    import h5py
    import numpy as np
    import rasterio
    from rasterio.transform import from_origin

    receipt = verify_file(path, record)
    destination = private_path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with h5py.File(path, "r") as handle:
        for key, expected in {"LocalGranuleID": record["name"], "RangeBeginningDate": record["period_start"],
                              "RangeEndingDate": record["period_end"], "ShortName": record["product"],
                              "PlatformShortName": "JPSS-1", "identifier_product_doi": "10.5067/VIIRS/VJ146A3.002"}.items():
            if key not in handle.attrs or scalar(handle.attrs[key]) != expected:
                raise ObservationError(f"HDF5 {key} does not match the checked composite.")
        fields = handle[GROUP]
        radiance_ds = fields[LAYER]
        quality_ds = fields[LAYER + "_Quality"]
        count_ds = fields[LAYER + "_Num"]
        if radiance_ds.shape != (2400, 2400) or radiance_ds.dtype.kind != "f" or radiance_ds.dtype.itemsize != 4:
            raise ObservationError("Expected a 2400 by 2400 float32 collection-002 radiance grid.")
        if quality_ds.dtype.kind != "u" or quality_ds.dtype.itemsize != 1 or count_ds.dtype.kind != "u" or count_ds.dtype.itemsize != 2:
            raise ObservationError("Unexpected quality/count data types.")
        scale = scalar(radiance_ds.attrs.get("scale_factor", float("nan")))
        offset = scalar(radiance_ds.attrs.get("offset", radiance_ds.attrs.get("add_offset", float("nan"))))
        fill = float(scalar(radiance_ds.attrs.get("_FillValue", float("nan"))))
        if scale != 1.0 or offset != 0.0 or not np.isclose(fill, -999.9, atol=0.001):
            raise ObservationError("Collection-002 scale, offset or fill attributes changed.")
        units = str(scalar(radiance_ds.attrs.get("units", "")))
        if "".join(units.split()) != "nWatts/(cm^2sr)":
            raise ObservationError("The radiance units do not match the reviewed NASA product.")
        if scalar(quality_ds.attrs.get("_FillValue", -1)) != 255 or scalar(count_ds.attrs.get("_FillValue", -1)) != 65535:
            raise ObservationError("Unexpected quality/count fill values.")
        for key, expected in {"NorthBoundingCoord": 40, "SouthBoundingCoord": 30,
                              "EastBoundingCoord": 130, "WestBoundingCoord": 120}.items():
            if float(scalar(handle.attrs.get(key, float("nan")))) != expected:
                raise ObservationError("HDF5 geographic bounds do not match the Korea tile.")
        structure = str(scalar(handle["HDFEOS INFORMATION/StructMetadata.0"][()]))
        if "Projection=HE5_GCTP_GEO" not in structure or "GridOrigin=HE5_HDFE_GD_UL" not in structure:
            raise ObservationError("Expected the official geographic grid with an upper-left origin.")
        # Actual v002 vectors begin at the upper/left edge, not at pixel centers.
        # HDFEOS geographic bounds define pixel areas; do not shift them half a cell.
        lat = np.asarray(fields["lat"][:]).reshape(-1)
        lon = np.asarray(fields["lon"][:]).reshape(-1)
        expected_lat = 40.0 - np.arange(2400) / 240
        expected_lon = 120.0 + np.arange(2400) / 240
        if (lat.shape != (2400,) or lon.shape != (2400,)
                or not np.allclose(lat, expected_lat, rtol=0, atol=1e-5)
                or not np.allclose(lon, expected_lon, rtol=0, atol=1e-5)):
            raise ObservationError("The coordinate vectors do not match the h30v05 north-up grid.")
        values = radiance_ds[:]
        quality = quality_ds[:]
        count = count_ds[:]
    valid = quality_mask(values, quality, count, fill)
    if not valid.any():
        raise ObservationError("No high-quality snow-free observations remain; no raster was produced.")
    result = np.where(valid, values, NODATA).astype("float32")
    temporary = destination.with_suffix(destination.suffix + ".part")
    try:
        with rasterio.open(temporary, "w", driver="GTiff", width=2400, height=2400, count=1, dtype="float32",
                           crs="EPSG:4326", transform=from_origin(120, 40, 1 / 240, 1 / 240), nodata=NODATA,
                           compress="deflate", predictor=3, tiled=True, blockxsize=256, blockysize=256) as target:
            target.write(result, 1)
            target.update_tags(source=record["url"], source_sha256=receipt["sha256"], product=record["product"],
                               period_start=record["period_start"], period_end=record["period_end"],
                               layer=LAYER, units="nW cm-2 sr-1", quality_rule="quality==0 and num>3; no gap-filled observations",
                               collection="002", tile=TILE)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    raster_digest = hashlib.sha256()
    with destination.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            raster_digest.update(block)
    receipt.update({"source": record, "raster": str(destination.relative_to(ROOT.resolve())),
                    "raster_sha256": raster_digest.hexdigest(),
                    "scientific_validation_completed": True, "artwork_rendered": False,
                    "quality_rule": "quality == 0 and num > 3 and num != 65535 and finite radiance >= 0",
                    "valid_tile_pixels": int(valid.sum()), "total_tile_pixels": int(valid.size),
                    "valid_tile_coverage_pct": float(valid.mean() * 100), "true_zero_valid_pixels": int(((values == 0) & valid).sum()),
                    "quality_counts": {str(q): int((quality == q).sum()) for q in [0, 1, 2, 255]},
                    "units": "nW cm-2 sr-1", "nodata": NODATA, "scale_factor": float(scale), "offset": float(offset)})
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="Fetch public metadata only (also refreshes metadata before other actions).")
    parser.add_argument("--download", action="store_true", help="Download and validate the two real monthly observations.")
    parser.add_argument("--token-file", type=Path, help="Private file inside this project's ignored .runtime directory.")
    parser.add_argument("--import-file", type=Path, nargs="+", default=[], help="Official HDF5 files manually downloaded in a browser.")
    parser.add_argument("--out", type=Path, default=ROOT / ".runtime/nasa")
    args = parser.parse_args(argv)
    client = None
    try:
        out = private_path(args.out)
        if args.token_file and not args.download:
            raise ObservationError("--token-file is only used with --download.")
        client = LaadsClient()
        check_path = out / "check.json"
        if args.check or args.download or not check_path.exists() or not (args.download or args.import_file):
            plan = discover(client)
            write_json(check_path, plan)
        else:
            plan = json.loads(check_path.read_text(encoding="utf-8"))
        pair = checked_pair(plan)
        print(f"NASA metadata: {plan['latest_month']} / comparison {plan['comparison_month']}; tile {TILE}.")
        if not args.download and not args.import_file:
            print("Metadata only. No scientific file was imported, rendered or published.")
            return 0
        token = load_token(args.token_file) if args.download else None
        imports = {p.name: p for p in args.import_file}
        if len(imports) != len(args.import_file) or set(imports) - {r["name"] for r in pair}:
            raise ObservationError("Imported files must be distinct members of the checked monthly pair.")
        completed = []
        for record in pair:
            if not args.download and record["name"] not in imports:
                continue
            raw, _ = acquire(record, out, client=client, token=token, import_file=imports.get(record["name"]))
            raster = out / "rasters" / f"{record['product']}_{record['period']}_{TILE}_snowfree_q0.tif"
            receipt = extract_raster(raw, record, raster)
            write_json(out / "receipts" / (record["name"] + ".json"), receipt)
            completed.append({"period": record["period"], "sha256": receipt["sha256"], "raster": receipt["raster"]})
            print(f"Validated {record['period']}: {receipt['valid_tile_pixels']} high-quality tile pixels.")
        write_json(out / "last_import.json", {"completed_utc": utc_now(), "observations": completed,
                                             "artwork_rendered": False, "published": False})
        ready = []
        for record in pair:
            receipt_path = out / "receipts" / (record["name"] + ".json")
            if not receipt_path.is_file():
                continue
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            expected_raster = out / "rasters" / f"{record['product']}_{record['period']}_{TILE}_snowfree_q0.tif"
            if (receipt.get("source") == record and receipt.get("scientific_validation_completed") is True
                    and receipt.get("raster_sha256") and expected_raster.is_file()):
                ready.append(record["period"])
        plan.update({"status": "ready" if len(ready) == 2 else "partial", "state": "observations_ready" if len(ready) == 2 else "partial",
                     "scientific_validation_completed": len(ready) == 2, "validated_periods": ready})
        write_json(check_path, plan)
        print("Validated observation rasters only. Existing artwork was not changed.")
        return 0
    except (ObservationError, OSError, KeyError, TypeError, ValueError) as error:
        # No request headers, environment values, response bodies or token contents.
        message = str(error) if isinstance(error, ObservationError) else "Source or file validation failed; no artwork was published."
        print(f"NASA observation check failed: {message}", file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == "__main__":
    raise SystemExit(main())
