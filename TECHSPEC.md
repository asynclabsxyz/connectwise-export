# ConnectWise PSA browser export

**No REST API.** Session cookies only: Izenda `rs.aspx` plus FileDownload.

Dates, fields, sources, and output names: edit `CONFIG` in `devtools-export.js`. Never hardcode the host.

## Goal

Four portable CSVs from Report Writer for someone without ConnectWise access. Tickets, all note types, time (including non-ticket), ticket attachments as Base64.

## Use cases

1. Operator pastes `devtools-export.js` on Report Writer.
2. Script finds `/reporting/ReportList.aspx` (or `{origin}/{version}/reporting`).
3. Unsaved Izenda reports → full CSV (`output=bulkCSV`), not the 100-row preview.
4. Ticket-linked documents via FileDownload; per-file errors continue.
5. Downstream: `validate_exports.py`, `decode_attachments.py`.

## Contract

Report Writer is Izenda at `{origin}/{version}/reporting/`.

| Call | Role |
| --- | --- |
| `getjsonschema` | Tables |
| `getfieldsinfo` | Fields |
| `POST viewreport` | Store unsaved report (`{"Value":"OK"}`) |
| `GET output=bulkCSV` | Full CSV (toolbar Export → CSV). `output=CSV` is `No Results` on this build |

Filter `Values` are raw `MM/DD/YYYY` inside JSON, encoded once as `wsarg0`. `Filters: null` throws. CSV headers are remapped to `CONFIG.fields` names.

FileDownload: `{origin}/v4_6_release/services/system_io/FileManagement/FileDownload.aspx?RecordId=&pathToFile=`. `v_rpt_Document` already has `SR_Service_RecID`.

## Checklist

- [x] CONFIG-only columns; dynamic origin
- [x] ReportList frame discovery
- [x] `viewreport` + `bulkCSV`; missing field is a hard error
- [x] Documents: drop non-ticket rows; Base64; continue on error
- [x] Large-run: CSV timeout, retries, FileReader Base64, part files
- [x] Decoder streams Base64; safe paths
- [x] Validator streams all four files
