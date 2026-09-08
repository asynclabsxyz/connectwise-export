#!/usr/bin/env python3
"""Validate the four ConnectWise PSA export CSVs.

Streams each file (especially 04_attachments_base64.csv) so huge Base64
cells do not get loaded into an Excel-style dataframe.

Reports:

  tickets
    - row count
    - unique SR_Service_RecID count
    - date min/max (Date_entered)

  notes
    - row count
    - unique service IDs
    - counts by Detail_Description_Flag / Internal_Analysis_Flag /
      Resolution_Flag / Time_Flag
    - notes whose SR_Service_RecID is not in 01_tickets.csv

  time
    - row count
    - ticket-associated vs non-ticket entry counts
    - total Hours_actual
    - date min/max (Date_Start)

  attachments
    - row count
    - successful vs failed Base64 downloads
    - total original bytes and total Base64 characters
    - attachments whose SR_Service_RecID is not in tickets
    - duplicate DM_Document_RecID
    - optional duplicate binary SHA-256 hashes

Usage:
    python validate_exports.py \\
      01_tickets.csv \\
      02_ticket_notes.csv \\
      03_time_entries.csv \\
      04_attachments_base64.csv
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


try:
    csv.field_size_limit(sys.maxsize)
except OverflowError:
    csv.field_size_limit(2**31 - 1)


NOTE_FLAGS = (
    "Detail_Description_Flag",
    "Internal_Analysis_Flag",
    "Resolution_Flag",
    "Time_Flag",
)


def parse_args() -> argparse.Namespace:
    """CLI for the four-file validator."""
    parser = argparse.ArgumentParser(
        description="Validate ConnectWise PSA export CSVs (streaming)."
    )
    parser.add_argument("tickets", type=Path, help="01_tickets.csv")
    parser.add_argument("notes", type=Path, help="02_ticket_notes.csv")
    parser.add_argument("time", type=Path, help="03_time_entries.csv")
    parser.add_argument("attachments", type=Path, help="04_attachments_base64.csv")
    parser.add_argument(
        "--no-hash",
        action="store_true",
        help="Skip SHA-256 of decoded attachment bytes (faster, less memory).",
    )
    return parser.parse_args()


def normalize_header(name: str) -> str:
    """Same normalization the exporter uses for field labels."""
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def header_map(fieldnames: list[str] | None) -> dict[str, str]:
    """Normalized header → actual header."""
    return {normalize_header(raw): raw for raw in (fieldnames or [])}


def col(mapping: dict[str, str], wanted: str) -> str:
    """Required column or exit."""
    key = normalize_header(wanted)
    if key not in mapping:
        raise SystemExit(
            f"Missing column {wanted!r}. Present: {', '.join(mapping.values()) or '(none)'}"
        )
    return mapping[key]


def optional_col(mapping: dict[str, str], wanted: str) -> str | None:
    """Optional column lookup."""
    return mapping.get(normalize_header(wanted))


def is_ticket_linked(value: str | None) -> bool:
    """Populated, nonzero SR_Service_RecID."""
    text = (value or "").strip()
    if not text:
        return False
    if re.fullmatch(r"0+(\.0+)?", text):
        return False
    return True


def flag_true(value: str | None) -> bool:
    """Treat common Report Writer truthies as true."""
    text = (value or "").strip().lower()
    return text in {"1", "true", "yes", "y", "t"}


def parse_date(value: str | None) -> datetime | None:
    """Best-effort parse of ConnectWise / Izenda date strings."""
    text = (value or "").strip()
    if not text:
        return None
    candidates = (
        "%m/%d/%Y",
        "%m/%d/%Y %H:%M:%S",
        "%m/%d/%Y %I:%M:%S %p",
        "%Y-%m-%d",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M:%S.%f",
        "%Y-%m-%d %H:%M:%S.%f",
    )
    for fmt in candidates:
        try:
            return datetime.strptime(text.split(".")[0] if "%f" not in fmt else text, fmt)
        except ValueError:
            continue
    # ISO leftovers (offset)
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def parse_hours(value: str | None) -> float:
    """Parse Hours_actual; blank → 0."""
    text = (value or "").strip().replace(",", "")
    if not text:
        return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def section(title: str) -> None:
    """Print a report heading."""
    print()
    print("=" * 72)
    print(title)
    print("=" * 72)


def stream_rows(path: Path):
    """Yield (mapping, row) for every data row. Caller must consume fully."""
    if not path.is_file():
        raise SystemExit(f"File not found: {path}")
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        mapping = header_map(reader.fieldnames)
        for row in reader:
            yield mapping, row


def validate_tickets(path: Path) -> set[str]:
    """Print ticket stats and return the set of SR_Service_RecID values."""
    section("TICKETS  " + str(path))
    ids: set[str] = set()
    dates: list[datetime] = []
    rows = 0
    date_col = None
    id_col = None
    for mapping, row in stream_rows(path):
        if id_col is None:
            id_col = col(mapping, "SR_Service_RecID")
            date_col = optional_col(mapping, "Date_entered")
        rows += 1
        rec_id = (row.get(id_col) or "").strip()
        if rec_id:
            ids.add(rec_id)
        if date_col:
            parsed = parse_date(row.get(date_col))
            if parsed:
                dates.append(parsed)
    print(f"row count:                 {rows}")
    print(f"unique SR_Service_RecID:   {len(ids)}")
    if dates:
        print(f"Date_entered min:          {min(dates)}")
        print(f"Date_entered max:          {max(dates)}")
    else:
        print("Date_entered min/max:      (no parseable dates)")
    return ids


def validate_notes(path: Path, ticket_ids: set[str]) -> None:
    """Print note stats, flag counts, and orphan service IDs."""
    section("NOTES  " + str(path))
    rows = 0
    service_ids: set[str] = set()
    flags = {name: 0 for name in NOTE_FLAGS}
    orphans: list[str] = []
    id_col = None
    flag_cols: dict[str, str] = {}
    for mapping, row in stream_rows(path):
        if id_col is None:
            id_col = col(mapping, "SR_Service_RecID")
            for name in NOTE_FLAGS:
                found = optional_col(mapping, name)
                if found:
                    flag_cols[name] = found
        rows += 1
        rec_id = (row.get(id_col) or "").strip()
        if rec_id:
            service_ids.add(rec_id)
            if rec_id not in ticket_ids:
                orphans.append(rec_id)
        for name, header in flag_cols.items():
            if flag_true(row.get(header)):
                flags[name] += 1
    print(f"row count:                 {rows}")
    print(f"unique SR_Service_RecID:   {len(service_ids)}")
    for name in NOTE_FLAGS:
        print(f"{name:26} {flags[name]}")
    print(f"notes not in tickets:      {len(orphans)}")
    if orphans:
        sample = sorted(set(orphans))[:20]
        print("  sample orphan IDs:       " + ", ".join(sample))


def validate_time(path: Path) -> None:
    """Print time-entry stats including non-ticket work."""
    section("TIME  " + str(path))
    rows = 0
    ticket_assoc = 0
    non_ticket = 0
    hours = 0.0
    dates: list[datetime] = []
    id_col = hours_col = date_col = None
    for mapping, row in stream_rows(path):
        if id_col is None:
            id_col = col(mapping, "SR_Service_RecID")
            hours_col = optional_col(mapping, "Hours_actual") or optional_col(
                mapping, "Hours_Actual"
            )
            date_col = optional_col(mapping, "Date_Start")
        rows += 1
        if is_ticket_linked(row.get(id_col)):
            ticket_assoc += 1
        else:
            non_ticket += 1
        if hours_col:
            hours += parse_hours(row.get(hours_col))
        if date_col:
            parsed = parse_date(row.get(date_col))
            if parsed:
                dates.append(parsed)
    print(f"row count:                 {rows}")
    print(f"ticket-associated:         {ticket_assoc}")
    print(f"non-ticket:                {non_ticket}")
    print(f"total Hours_actual:        {hours:.4f}")
    if dates:
        print(f"Date_Start min:            {min(dates)}")
        print(f"Date_Start max:            {max(dates)}")
    else:
        print("Date_Start min/max:        (no parseable dates)")


def validate_attachments(path: Path, ticket_ids: set[str], compute_hash: bool) -> None:
    """Stream attachment CSV and print download / integrity stats."""
    section("ATTACHMENTS  " + str(path))
    rows = 0
    success = 0
    failed = 0
    total_bytes = 0
    total_b64_chars = 0
    orphans: list[str] = []
    rec_ids: list[str] = []
    hashes: dict[str, list[str]] = defaultdict(list)

    ticket_col = doc_col = b64_col = err_col = size_col = None
    for mapping, row in stream_rows(path):
        if ticket_col is None:
            ticket_col = col(mapping, "SR_Service_RecID")
            doc_col = col(mapping, "DM_Document_RecID")
            b64_col = optional_col(mapping, "Base64_Data")
            err_col = optional_col(mapping, "Error")
            size_col = optional_col(mapping, "Size_Bytes")
        rows += 1
        ticket = (row.get(ticket_col) or "").strip()
        doc_id = (row.get(doc_col) or "").strip()
        if doc_id:
            rec_ids.append(doc_id)
        if ticket and ticket not in ticket_ids:
            orphans.append(ticket)

        b64 = (row.get(b64_col) or "").strip() if b64_col else ""
        err = (row.get(err_col) or "").strip() if err_col else ""
        if b64:
            success += 1
            total_b64_chars += len(b64)
            size_text = (row.get(size_col) or "").strip() if size_col else ""
            if size_text:
                try:
                    total_bytes += int(size_text)
                except ValueError:
                    pass
            else:
                try:
                    total_bytes += len(base64.b64decode(b64, validate=False))
                except Exception:
                    pass
            if compute_hash:
                try:
                    raw = base64.b64decode(b64, validate=False)
                    digest = hashlib.sha256(raw).hexdigest()
                    hashes[digest].append(doc_id or f"row-{rows}")
                except Exception:
                    pass
        else:
            failed += 1
            if not err:
                # Counted as failed even without an Error cell.
                pass

    dup_ids = [item for item, n in Counter(rec_ids).items() if n > 1]
    print(f"row count:                 {rows}")
    print(f"successful Base64:         {success}")
    print(f"failed attachments:        {failed}")
    print(f"total original bytes:      {total_bytes}")
    print(f"total Base64 characters:   {total_b64_chars}")
    print(f"attachments not in tickets:{len(orphans)}")
    if orphans:
        print("  sample orphan IDs:       " + ", ".join(sorted(set(orphans))[:20]))
    print(f"duplicate DM_Document_RecID:{len(dup_ids)}")
    if dup_ids:
        print("  sample duplicate IDs:    " + ", ".join(dup_ids[:20]))
    if compute_hash:
        dup_hashes = {h: ids for h, ids in hashes.items() if len(ids) > 1}
        print(f"duplicate SHA-256 groups:  {len(dup_hashes)}")
        shown = 0
        for digest, ids in dup_hashes.items():
            print(f"  {digest} → {', '.join(ids)}")
            shown += 1
            if shown >= 10:
                print("  …")
                break
    else:
        print("duplicate SHA-256 groups:  (skipped, --no-hash)")


def main() -> int:
    """Validate the four export files and print a human-readable report."""
    args = parse_args()
    ticket_ids = validate_tickets(args.tickets)
    validate_notes(args.notes, ticket_ids)
    validate_time(args.time)
    validate_attachments(args.attachments, ticket_ids, compute_hash=not args.no_hash)
    print()
    print("Validation finished.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
