# ConnectWise PSA Report Writer export

Paste `devtools-export.js` into the Chrome DevTools console on **System → Report Writer**. It uses the logged-in session (not the REST API) to download four CSVs: tickets, notes, time entries, and ticket attachments (Base64).

Dates, columns, data sources, and timeouts live in `CONFIG` at the top of the script. Origin is taken from the page.

## Export

1. Open Report Writer while logged in.
2. DevTools → **Console**. Context should be the frame whose URL ends in `/reporting/ReportList.aspx` (often `24_hosted_…`). If the script cannot find it, pick that frame and paste again.
3. Paste `devtools-export.js`. Allow multiple downloads. Leave the tab open until **DONE**.

Large ranges can take several minutes. Huge attachment exports may split into `*_partNN.csv`. Treat `04_attachments_base64.csv` as sensitive.

## Decode / validate

Python 3.9+, stdlib only.

```bash
python3 decode_attachments.py 04_attachments_base64.csv
python3 validate_exports.py 01_tickets.csv 02_ticket_notes.csv 03_time_entries.csv 04_attachments_base64.csv
```

The decoder also reads sibling `*_partNN.csv` files.

Spec: [TECHSPEC.md](TECHSPEC.md)
