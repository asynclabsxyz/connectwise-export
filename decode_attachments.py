#!/usr/bin/env python3
"""Reconstruct original files from 04_attachments_base64.csv.

Reads the ConnectWise PSA exporter attachment CSV (streamed — the Base64
column can be hundreds of megabytes) and writes:

    attachments/
      <SR_Service_RecID>/
          <Filename>

Does not interpret file content. Bytes are decoded from Base64 and written
exactly. Filenames are sanitized against path traversal. Duplicate names
inside the same ticket folder become name_2.ext, name_3.ext, …

Usage:
    python3 decode_attachments.py 04_attachments_base64.csv
    python3 decode_attachments.py 04_attachments_base64.csv -o attachments
"""

from __future__ import annotations

import argparse
import base64
import csv
import os
import re
import sys
from pathlib import Path


# Base64 cells routinely exceed the default csv field limit.
try:
    csv.field_size_limit(sys.maxsize)
except OverflowError:
    csv.field_size_limit(2**31 - 1)


UNSAFE_NAME = re.compile(r"[^A-Za-z0-9._ ()+\-\[\]]+")


def parse_args() -> argparse.Namespace:
    """CLI for the attachment decoder."""
    parser = argparse.ArgumentParser(
        description="Decode Base64 attachment CSV into original files."
    )
    parser.add_argument(
        "csv_path",
        nargs="+",
        type=Path,
        help="04_attachments_base64.csv (sibling _partNN files are picked up automatically)",
    )
    parser.add_argument(
        "-o",
        "--output-dir",
        type=Path,
        default=Path("attachments"),
        help="Output root (default: ./attachments)",
    )
    return parser.parse_args()


def normalize_header(name: str) -> str:
    """Match CSV headers the same way the exporter matches field labels."""
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def header_map(fieldnames: list[str] | None) -> dict[str, str]:
    """Map normalized names to the actual CSV header text."""
    mapping: dict[str, str] = {}
    for raw in fieldnames or []:
        mapping[normalize_header(raw)] = raw
    return mapping


def require_col(mapping: dict[str, str], wanted: str) -> str:
    """Resolve a required column or raise a clear error."""
    key = normalize_header(wanted)
    if key not in mapping:
        raise SystemExit(
            f"CSV is missing column {wanted!r}. "
            f"Present: {', '.join(mapping.values()) or '(none)'}"
        )
    return mapping[key]


def safe_ticket_dir(rec_id: str) -> str:
    """Ticket folder name: keep alphanumerics; never allow . / .. / separators."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", (rec_id or "").strip()) or "unknown"
    if cleaned in {".", ".."}:
        return "unknown"
    return cleaned


def safe_filename(name: str) -> str:
    """Basename only, no traversal, preserve extension when possible."""
    base = os.path.basename((name or "").replace("\\", "/").strip())
    base = base.replace("\x00", "")
    if not base or base in {".", ".."}:
        return "unnamed.bin"
    # Collapse leftover path pieces and control characters.
    base = UNSAFE_NAME.sub("_", base).strip(" .")
    return base or "unnamed.bin"


def unique_path(directory: Path, filename: str) -> Path:
    """Avoid overwriting: file.ext, file_2.ext, file_3.ext, …"""
    candidate = directory / filename
    if not candidate.exists():
        return candidate
    stem, suffix = os.path.splitext(filename)
    n = 2
    while True:
        candidate = directory / f"{stem}_{n}{suffix}"
        if not candidate.exists():
            return candidate
        n += 1


def decode_row(row: dict[str, str], mapping: dict[str, str]) -> tuple[bytes | None, str]:
    """Return (bytes, skip/error reason). None bytes means the row was skipped."""
    error_col = mapping.get("error")
    error = (row.get(error_col) or "").strip() if error_col else ""
    b64_col = require_col(mapping, "Base64_Data")
    b64 = (row.get(b64_col) or "").strip()
    if error and not b64:
        return None, error
    if not b64:
        return None, "empty Base64_Data"
    try:
        data = base64.b64decode(b64, validate=False)
    except Exception as exc:  # noqa: BLE001 — report and continue
        return None, f"invalid Base64: {exc}"
    return data, ""


def resolve_csv_paths(requested: list[Path]) -> list[Path]:
    """Keep existing paths; warn on missing; add sibling _partNN files."""
    found: list[Path] = []
    seen: set[Path] = set()
    for path in requested:
        resolved = path.expanduser()
        if resolved.is_file():
            key = resolved.resolve()
            if key not in seen:
                seen.add(key)
                found.append(resolved)
            parent = resolved.parent
            stem = resolved.name
            if stem.lower().endswith(".csv"):
                stem = stem[:-4]
            for extra in sorted(parent.glob(stem + "_part*.csv")):
                extra_key = extra.resolve()
                if extra_key not in seen and extra.is_file():
                    seen.add(extra_key)
                    found.append(extra)
                    print(f"Also reading {extra}")
        else:
            print(f"Skipping missing file: {path}", file=sys.stderr)
    return found


def main() -> int:
    """Stream the attachment CSV and write reconstructed files."""
    args = parse_args()
    csv_paths = resolve_csv_paths(args.csv_path)
    out_root: Path = args.output_dir

    if not csv_paths:
        print("No attachment CSV files found.", file=sys.stderr)
        return 2

    out_root.mkdir(parents=True, exist_ok=True)

    success = 0
    skipped = 0
    size_mismatch = 0

    for csv_path in csv_paths:
        print(f"Reading {csv_path}")
        with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            mapping = header_map(reader.fieldnames)
            ticket_col = require_col(mapping, "SR_Service_RecID")
            file_col = require_col(mapping, "Filename")
            size_col = mapping.get(normalize_header("Size_Bytes"))

            for index, row in enumerate(reader, start=2):
                ticket_id = (row.get(ticket_col) or "").strip()
                filename = (row.get(file_col) or "").strip()
                data, reason = decode_row(row, mapping)
                if data is None:
                    skipped += 1
                    print(f"SKIP {csv_path.name}:{index} ticket={ticket_id} file={filename!r}: {reason}")
                    continue

                folder = out_root / safe_ticket_dir(ticket_id)
                folder.mkdir(parents=True, exist_ok=True)
                dest = unique_path(folder, safe_filename(filename))
                dest.write_bytes(data)

                if size_col:
                    expected = (row.get(size_col) or "").strip()
                    if expected:
                        try:
                            expected_n = int(expected)
                        except ValueError:
                            expected_n = None
                        if expected_n is not None and expected_n != len(data):
                            size_mismatch += 1
                            print(
                                f"SIZE MISMATCH {csv_path.name}:{index} {dest}: "
                                f"decoded={len(data)} Size_Bytes={expected_n}"
                            )

                success += 1
                print(f"OK  {dest} ({len(data)} bytes)")

    print()
    print(f"Decoded:          {success}")
    print(f"Skipped/failed:   {skipped}")
    print(f"Size mismatches:  {size_mismatch}")
    print(f"Output directory: {out_root.resolve()}")
    # Error-column skips are expected (deleted documents). Size mismatches are not.
    return 1 if size_mismatch else 0


if __name__ == "__main__":
    sys.exit(main())
