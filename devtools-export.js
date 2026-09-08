/**
 * ConnectWise PSA Report Writer exporter (DevTools console).
 *
 * Paste into Console while logged into Report Writer. Does not use the
 * ConnectWise REST API. Builds four unsaved Izenda reports and downloads:
 *   01_tickets.csv  02_ticket_notes.csv  03_time_entries.csv  04_attachments_base64.csv
 *
 * This ConnectWise build's Export → CSV posts the unsaved report with
 * wscmd=viewreport, then GETs rs.aspx?output=bulkCSV (not output=CSV).
 * Large runs: bulkCSV timeout 15m, FileReader Base64, attachment retries,
 * and 04_*.csv is split when it exceeds attachments.maxCsvBytes.
 *
 * @file connectwise-export/devtools-export.js
 */
(async function connectWisePsaExport() {
  "use strict";

  // ========================================================================
  // CONFIG — edit field lists here to include or omit columns
  // ========================================================================

  const CONFIG = {
    startDate: "06/01/2026",
    endDate: "08/31/2026",

    reports: {
      tickets: true,
      notes: true,
      time: true,
      documents: true,
    },

    dataSources: {
      tickets: "v_rpt_Service",
      notes: "v_rpt_ServiceNote",
      time: "v_rpt_Time",
      documents: "v_rpt_Document",
    },

    outputFilenames: {
      tickets: "01_tickets.csv",
      notes: "02_ticket_notes.csv",
      time: "03_time_entries.csv",
      documents: "04_attachments_base64.csv",
    },

    fields: {
      tickets: [
        "SR_Service_RecID",
        "TicketNbr",
        "Date_entered",
        "Date_closed",
        "Summary",
        "Detail_Description",
        "Internal_Analysis",
        "Resolution",
        "Company_name",
        "Company_recid",
        "Contact_name",
        "Contact_recid",
        "Board_Name",
        "Status_description",
        "Service Type",
        "Service Sub Type",
        "Service Sub Type Item",
        "Source",
        "Severity",
        "Urgency",
        "Resource_list",
        "Ticket_Owner_First_Name",
        "Ticket_Owner_Last_Name",
        "Hours_Actual",
        "Closed_by",
        "ClosedDesc",
        "Priority_Level",
      ],
      notes: [
        "SR_Service_RecID",
        "RecID",
        "Notes",
        "Date_Created_UTC",
        "Last_Update_UTC",
        "Created_By",
        "Updated_By",
        "Member_RecID",
        "Contact_RecID",
        "Detail_Description_Flag",
        "Internal_Analysis_Flag",
        "Resolution_Flag",
        "Time_Flag",
      ],
      time: [
        "Time_RecID",
        "SR_Service_RecID",
        "Sr_summary",
        "Date_Start",
        "Date_entered_utc",
        "Member_id",
        "Member_recid",
        "First_name",
        "Last_name",
        "Company_name",
        "Hours_actual",
        "Billable_Hrs",
        "Non Billable_Hrs",
        "Work_role",
        "Work_type",
        "Charge_Code",
        "Notes",
        "Internal_note",
        "Agreement",
        "Invoice_Number",
        "Updated_By",
        "Last_Update",
      ],
      documents: [
        "DM_Document_RecID",
        "SR_Service_RecID",
        "Filename",
        "Last_Update",
        "Path",
        "ServerFilename",
        "Public_Flag",
        "Link_Flag",
      ],
    },

    dateFilterFields: {
      tickets: "Date_entered",
      notes: "Date_Created_UTC",
      time: "Date_Start",
      documents: "Last_Update",
    },

    attachments: {
      downloadBytes: true,
      relativePath:
        "/v4_6_release/services/system_io/FileManagement/FileDownload.aspx",
      betweenMs: 120,
      timeoutMs: 180000,
      retries: 2,
      retryDelayMs: 1500,
      progressEvery: 25,
      /** Skip encoding a single file larger than this (0 = no limit). */
      maxFileBytes: 80 * 1024 * 1024,
      /** Flush 04_*.csv and start a part file at this Blob size. */
      maxCsvBytes: 180 * 1024 * 1024,
    },

    /** Verified against this build's Export → CSV control (id=csvExportBtn). */
    csvOutput: "bulkCSV",
    csvTimeoutMs: 900000,
    requestTimeoutMs: 120000,
  };

  const attachmentColumns = [
    "SR_Service_RecID",
    "DM_Document_RecID",
    "Filename",
    "Last_Update",
    "Path",
    "ServerFilename",
    "Public_Flag",
    "Link_Flag",
    "Mime_Type",
    "Size_Bytes",
    "Base64_Data",
    "Error",
  ];

  const log = (...args) => console.log("[CW-EXPORT]", ...args);

  function normalizeName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  function fieldTail(fieldId) {
    const parts = String(fieldId || "")
      .split(/[.\]]/)
      .filter(Boolean);
    return (parts[parts.length - 1] || fieldId).replace(/^\[/, "").replace(/\]$/, "");
  }

  function isTicketLinked(value) {
    const text = String(value == null ? "" : value).trim();
    return !!text && !/^0+(\.0+)?$/.test(text);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function* iterateCsvRows(text) {
    const source = String(text || "").replace(/^\uFEFF/, "");
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (inQuotes) {
        if (ch === '"') {
          if (source[i + 1] === '"') {
            field += '"';
            i++;
          } else inQuotes = false;
        } else field += ch;
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        continue;
      }
      if (ch === ",") {
        row.push(field);
        field = "";
        continue;
      }
      if (ch === "\r") continue;
      if (ch === "\n") {
        row.push(field);
        yield row;
        row = [];
        field = "";
        continue;
      }
      field += ch;
    }
    if (field.length || row.length) {
      row.push(field);
      yield row;
    }
  }

  function parseCsv(text) {
    const rows = [];
    for (const row of iterateCsvRows(text)) rows.push(row);
    while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
    if (!rows.length) return { headers: [], rows: [] };
    const headers = rows[0].map((h) => String(h || "").trim());
    return {
      headers,
      rows: rows.slice(1).map((cells) => {
        const rec = {};
        headers.forEach((h, idx) => {
          rec[h] = cells[idx] == null ? "" : String(cells[idx]);
        });
        return rec;
      }),
    };
  }

  function csvCell(value) {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function looksLikeHtml(text) {
    const head = String(text || "")
      .replace(/^\uFEFF/, "")
      .slice(0, 200)
      .trim()
      .toLowerCase();
    return head.startsWith("<!doctype") || head.startsWith("<html") || head.includes("<head");
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal, credentials: "include" });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new Error("Timed out after " + timeoutMs + "ms: " + url);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function reportListFallback() {
    return [
      "Could not find Report Writer.",
      "In DevTools Console, select the frame whose location.href ends in",
      "/reporting/ReportList.aspx (often 24_hosted_… (ReportList…)), then paste again.",
    ].join(" ");
  }

  function collectReportList(win, found) {
    try {
      if (/\/reporting\/ReportList\.aspx/i.test(win.location.href)) found.push(win);
    } catch (_err) {
      return;
    }
    let n = 0;
    try {
      n = win.frames.length;
    } catch (_err) {
      return;
    }
    for (let i = 0; i < n; i++) {
      try {
        collectReportList(win.frames[i], found);
      } catch (_err) {
        /* cross-origin */
      }
    }
  }

  function reportingBaseFrom(win) {
    try {
      const href = win.location.href;
      if (/\/reporting\//i.test(href)) return href.replace(/\/reporting\/.*$/i, "/reporting");
      const m = win.location.pathname.match(/^\/(v[^/]+)\//i);
      if (m) return win.location.origin + "/" + m[1] + "/reporting";
    } catch (_err) {
      /* ignore */
    }
    return null;
  }

  function discoverContext() {
    const found = [];
    try {
      collectReportList(window, found);
    } catch (_err) {
      /* ignore */
    }
    try {
      if (window.top && window.top !== window) collectReportList(window.top, found);
    } catch (_err) {
      /* ignore */
    }
    const reportWin = found[0] || window;
    const reportingBase =
      (found[0] && reportingBaseFrom(found[0])) ||
      reportingBaseFrom(window) ||
      (window.top && reportingBaseFrom(window.top));
    if (!reportingBase) throw new Error(reportListFallback());
    const origin = reportWin.location.origin;
    log("origin", origin, "reporting", reportingBase);
    return { reportWin, origin, reportingBase };
  }

  function parseIzendaJson(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch (_err) {
      try {
        return JSON.parse(trimmed.replace(/^\(/, "").replace(/\);?$/, ""));
      } catch (_err2) {
        return { raw: trimmed };
      }
    }
  }

  async function izendaGet(rsUrl, params) {
    const url = new URL(rsUrl);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const resp = await fetchWithTimeout(url.href, {}, CONFIG.requestTimeoutMs);
    if (!resp.ok) throw new Error(url.search + " HTTP " + resp.status);
    return parseIzendaJson(await resp.text());
  }

  async function viewReport(rsUrl, reportObj) {
    const encoded = encodeURIComponent(JSON.stringify(reportObj));
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await fetchWithTimeout(
          rsUrl,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
            body: "wscmd=viewreport&wsarg0=" + encoded,
          },
          CONFIG.requestTimeoutMs
        );
        const json = parseIzendaJson(await resp.text());
        if (json && json.Value === "OK") return;
        lastErr = new Error("viewreport failed: " + (json && json.Value ? json.Value : "no OK"));
      } catch (err) {
        lastErr = err;
      }
      if (attempt === 0) await sleep(1500);
    }
    throw lastErr;
  }

  async function fetchBulkCsv(rsUrl) {
    const tried = [];
    let lastNoResults = false;
    for (const output of [CONFIG.csvOutput, "bulkCSV", "CSV"]) {
      if (tried.includes(output)) continue;
      tried.push(output);
      const url = new URL(rsUrl);
      url.searchParams.set("output", output);
      const resp = await fetchWithTimeout(url.href, {}, CONFIG.csvTimeoutMs);
      if (!resp.ok) throw new Error("CSV HTTP " + resp.status + " (" + output + ")");
      const text = await resp.text();
      if (looksLikeHtml(text)) {
        throw new Error("CSV export returned HTML (session expired or not on Report Writer).");
      }
      const body = text.replace(/^\uFEFF/, "").trim();
      if (/^No Results$/i.test(body)) {
        lastNoResults = true;
        continue;
      }
      log("CSV", output, Math.round(text.length / 1024) + " KB");
      return text;
    }
    if (lastNoResults) return "\uFEFF";
    return "\uFEFF";
  }

  function matchField(reportKey, sourceName, requested, fields) {
    const wanted = normalizeName(requested);
    const hit =
      fields.find((f) => normalizeName(f.name) === wanted) ||
      fields.find((f) => normalizeName(fieldTail(f.sysname)) === wanted);
    if (hit) return hit;
    throw new Error(
      "Field not found. report=" +
        reportKey +
        " source=" +
        sourceName +
        " field=" +
        requested +
        " available=" +
        fields.map((f) => f.name).join(", ")
    );
  }

  function findTable(schema, sourceName) {
    const wanted = normalizeName(sourceName);
    for (const cat of schema || []) {
      for (const table of cat.tables || []) {
        if (
          normalizeName(table.name) === wanted ||
          normalizeName(fieldTail(table.sysname)) === wanted
        ) {
          return table;
        }
      }
    }
    const names = [];
    for (const cat of schema || []) {
      for (const table of cat.tables || []) names.push(table.name);
    }
    throw new Error(
      "Data source '" + sourceName + "' not found. Nearby: " + names.slice(0, 60).join(", ")
    );
  }

  function remapCsvToBlob(csvText, configured) {
    const parts = ["\uFEFF" + configured.map(csvCell).join(",") + "\r\n"];
    let headerIndex = null;
    let rows = 0;
    for (const cells of iterateCsvRows(csvText)) {
      if (!headerIndex) {
        const headers = cells.map((h) => String(h || "").trim());
        if (!headers.length || headers.every((h) => !h)) continue;
        headerIndex = {};
        headers.forEach((h, idx) => {
          headerIndex[normalizeName(h)] = idx;
        });
        continue;
      }
      if (cells.every((c) => c === "")) continue;
      parts.push(
        configured
          .map((name) => {
            const idx = headerIndex[normalizeName(name)];
            return csvCell(idx == null ? "" : cells[idx]);
          })
          .join(",") + "\r\n"
      );
      rows++;
    }
    return { blob: new Blob(parts, { type: "text/csv;charset=utf-8" }), rows };
  }

  function downloadBlob(reportWin, filename, blob) {
    const url = reportWin.URL.createObjectURL(blob);
    const a = reportWin.document.createElement("a");
    a.href = url;
    a.download = filename;
    reportWin.document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => reportWin.URL.revokeObjectURL(url), 60000);
    log("Downloaded", filename, "(" + Math.round(blob.size / 1024) + " KB)");
  }

  function blobToBase64(reportWin, blob) {
    return new Promise((resolve, reject) => {
      const reader = new reportWin.FileReader();
      reader.onloadend = () => {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
      reader.readAsDataURL(blob);
    });
  }

  function attachmentError(text) {
    const trimmed = String(text || "").trim();
    if (/^ErrorResponse\|/i.test(trimmed) || /has been deleted/i.test(trimmed)) {
      return trimmed.slice(0, 400);
    }
    const head = trimmed.slice(0, 200).toLowerCase();
    if (head.startsWith("<!doctype") || head.startsWith("<html")) {
      return "FileDownload returned HTML instead of file bytes.";
    }
    return null;
  }

  async function downloadAttachmentOnce(reportWin, origin, recId, filename) {
    const url = new URL(CONFIG.attachments.relativePath, origin);
    url.searchParams.set("RecordId", recId);
    url.searchParams.set("pathToFile", filename);
    const resp = await fetchWithTimeout(
      url.href,
      {},
      CONFIG.attachments.timeoutMs
    );
    const mimeType = resp.headers.get("content-type") || "";
    const blob = await resp.blob();
    if (!resp.ok) {
      return { mimeType: "", sizeBytes: "", base64: "", error: "HTTP " + resp.status };
    }
    const maxBytes = CONFIG.attachments.maxFileBytes;
    if (maxBytes && blob.size > maxBytes) {
      return {
        mimeType,
        sizeBytes: String(blob.size),
        base64: "",
        error: "File larger than maxFileBytes (" + blob.size + ")",
      };
    }
    if (blob.size <= 4096 || /text\//i.test(mimeType)) {
      const sniff = await blob.slice(0, 4096).text();
      const err = attachmentError(sniff);
      if (err) return { mimeType: "", sizeBytes: "", base64: "", error: err };
    }
    return {
      mimeType,
      sizeBytes: String(blob.size),
      base64: await blobToBase64(reportWin, blob),
      error: "",
    };
  }

  async function downloadAttachment(reportWin, origin, recId, filename) {
    let last = { mimeType: "", sizeBytes: "", base64: "", error: "unknown" };
    const attempts = 1 + (CONFIG.attachments.retries || 0);
    for (let i = 0; i < attempts; i++) {
      try {
        last = await downloadAttachmentOnce(reportWin, origin, recId, filename);
        if (!last.error) return last;
        const transient = /^HTTP (429|5\d\d)/.test(last.error) || /Timed out/i.test(last.error);
        if (!transient || i === attempts - 1) return last;
      } catch (err) {
        last = {
          mimeType: "",
          sizeBytes: "",
          base64: "",
          error: err && err.message ? err.message : String(err),
        };
        if (i === attempts - 1) return last;
      }
      await sleep(CONFIG.attachments.retryDelayMs || 1500);
    }
    return last;
  }

  function attachmentPartName(baseName, part) {
    if (part === 1) return baseName;
    const dot = baseName.lastIndexOf(".");
    const stem = dot >= 0 ? baseName.slice(0, dot) : baseName;
    const ext = dot >= 0 ? baseName.slice(dot) : ".csv";
    return stem + "_part" + String(part).padStart(2, "0") + ext;
  }

  async function touchSession(rsUrl) {
    try {
      await fetchWithTimeout(
        rsUrl + (rsUrl.includes("?") ? "&" : "?") + "wscmd=instantreportconfig",
        {},
        15000
      );
    } catch (_err) {
      /* ignore — attachment download is the real work */
    }
  }

  async function exportAttachments(reportWin, origin, csvText, rsUrl) {
    const parsed = parseCsv(csvText);
    const byNorm = {};
    parsed.headers.forEach((h) => {
      byNorm[normalizeName(h)] = h;
    });
    const col = (name) => {
      const h = byNorm[normalizeName(name)];
      if (!h) throw new Error("Document CSV missing " + name);
      return h;
    };
    const ticketCol = col("SR_Service_RecID");
    const recCol = col("DM_Document_RecID");
    const fileCol = col("Filename");
    const lastCol = col("Last_Update");
    const pathCol = col("Path");
    const serverCol = col("ServerFilename");
    const publicCol = col("Public_Flag");
    const linkCol = col("Link_Flag");
    const rows = parsed.rows.filter((r) => isTicketLinked(r[ticketCol]));
    log("documents ticket-linked", rows.length, "/", parsed.rows.length);

    const headerLine = "\uFEFF" + attachmentColumns.map(csvCell).join(",") + "\r\n";
    let parts = [headerLine];
    let partBytes = headerLine.length;
    let partNum = 1;
    let failed = 0;

    const flush = () => {
      downloadBlob(
        reportWin,
        attachmentPartName(CONFIG.outputFilenames.documents, partNum),
        new Blob(parts, { type: "text/csv;charset=utf-8" })
      );
      partNum += 1;
      parts = [headerLine];
      partBytes = headerLine.length;
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rec = {
        SR_Service_RecID: row[ticketCol] || "",
        DM_Document_RecID: row[recCol] || "",
        Filename: row[fileCol] || "",
        Last_Update: row[lastCol] || "",
        Path: row[pathCol] || "",
        ServerFilename: row[serverCol] || "",
        Public_Flag: row[publicCol] || "",
        Link_Flag: row[linkCol] || "",
        Mime_Type: "",
        Size_Bytes: "",
        Base64_Data: "",
        Error: "",
      };
      if (CONFIG.attachments.downloadBytes) {
        const every = CONFIG.attachments.progressEvery || 25;
        if (i === 0 || (i + 1) % every === 0 || i + 1 === rows.length) {
          log("attachment", i + 1 + "/" + rows.length, rec.DM_Document_RecID);
        }
        const got = await downloadAttachment(
          reportWin,
          origin,
          rec.DM_Document_RecID,
          rec.Filename
        );
        rec.Mime_Type = got.mimeType;
        rec.Size_Bytes = got.sizeBytes;
        rec.Base64_Data = got.base64;
        rec.Error = got.error;
        if (got.error) {
          failed += 1;
          console.warn("[CW-EXPORT]", rec.DM_Document_RecID, got.error);
        }
      } else {
        rec.Error = "downloadBytes disabled";
      }

      const line = attachmentColumns.map((h) => csvCell(rec[h])).join(",") + "\r\n";
      parts.push(line);
      partBytes += line.length;
      rec.Base64_Data = "";
      if (CONFIG.attachments.maxCsvBytes && partBytes >= CONFIG.attachments.maxCsvBytes) {
        flush();
      }
      if (rsUrl && (i + 1) % 50 === 0) await touchSession(rsUrl);
      if (CONFIG.attachments.betweenMs) await sleep(CONFIG.attachments.betweenMs);
    }

    if (parts.length > 1 || partNum === 1) flush();
    if (failed) log("attachment failures", failed);
  }

  let schemaCache = null;

  async function loadSchema(rsUrl) {
    if (schemaCache) return schemaCache;
    schemaCache = await izendaGet(rsUrl, { wscmd: "getjsonschema", wsarg0: "lazy" });
    if (!Array.isArray(schemaCache)) throw new Error("getjsonschema failed");
    return schemaCache;
  }

  async function exportReport(rsUrl, reportKey) {
    const sourceName = CONFIG.dataSources[reportKey];
    const configured = CONFIG.fields[reportKey];
    const filterName = CONFIG.dateFilterFields[reportKey];
    log("BUILDING", reportKey.toUpperCase());

    const schema = await loadSchema(rsUrl);
    const table = findTable(schema, sourceName);
    const info = await izendaGet(rsUrl, { wscmd: "getfieldsinfo", wsarg0: table.sysname });
    const fields = info && info.fields;
    if (!fields || !fields.length) {
      throw new Error("getfieldsinfo returned no fields for " + table.sysname);
    }
    log("Datasource selected:", table.sysname);

    const chosen = configured.map((name) => matchField(reportKey, sourceName, name, fields));
    const filterField = matchField(reportKey, sourceName, filterName, fields);
    const reportObj = {
      DsList: [table.sysname],
      FldList: chosen.map((f) => f.sysname),
      OrdList: chosen.map((_, i) => String(i)),
      WidthList: chosen.map(() => 0),
      FldOpts: chosen.map(() => null),
      SortsList: chosen.map(() => "0"),
      SubtotalsAdded: false,
      ChartAdded: false,
      ChartProps: "",
      Filters: [
        {
          Removed: false,
          Uid: "",
          GUID: "",
          Column: filterField.sysname,
          OperatorValue: "Between",
          AliasTable: "",
          Alias: "",
          Values: [CONFIG.startDate, CONFIG.endDate],
        },
      ],
    };

    await viewReport(rsUrl, reportObj);
    const csvText = await fetchBulkCsv(rsUrl);
    const remapped = remapCsvToBlob(csvText, configured);
    log(reportKey, "rows", remapped.rows);
    return remapped;
  }

  async function main() {
    const ctx = discoverContext();
    const rsUrl = ctx.reportingBase.replace(/\/?$/, "/") + "rs.aspx";
    const order = ["tickets", "notes", "time", "documents"];
    for (const reportKey of order) {
      if (!CONFIG.reports[reportKey]) {
        log("skip", reportKey);
        continue;
      }
      const remapped = await exportReport(rsUrl, reportKey);
      if (reportKey === "documents") {
        const metadataText = await remapped.blob.text();
        await exportAttachments(ctx.reportWin, ctx.origin, metadataText, rsUrl);
      } else {
        downloadBlob(ctx.reportWin, CONFIG.outputFilenames[reportKey], remapped.blob);
      }
    }
    log("DONE");
  }

  await main();
})();
