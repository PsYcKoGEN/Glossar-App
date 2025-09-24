import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Download, Search, Plus, X } from "lucide-react";

/* === OneDrive / Microsoft Login (MSAL) === */
import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  AccountInfo,
} from "@azure/msal-browser";

const msalConfig = {
  auth: {
    clientId: "YOUR_CLIENT_ID", // <- HIER deine echte Azure Client-ID eintragen
    authority: "https://login.microsoftonline.com/common",
    redirectUri: window.location.origin + "/",
  },
  cache: { cacheLocation: "localStorage" },
};
const msalInstance = new PublicClientApplication(msalConfig);
const msalReady = msalInstance.initialize();

const GRAPH_SCOPES = ["Files.ReadWrite", "offline_access"];
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const FILE_PATH = "/me/drive/root:/Glossar/glossar.json";

async function getGraphToken(): Promise<{ account: AccountInfo; token: string }> {
  await msalReady;

  let account =
    msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0];

  if (!account) {
    const login = await msalInstance.loginPopup({ scopes: GRAPH_SCOPES });
    account = login.account!;
    msalInstance.setActiveAccount(account);
  }

  try {
    const r = await msalInstance.acquireTokenSilent({
      account,
      scopes: GRAPH_SCOPES,
    });
    return { account, token: r.accessToken };
  } catch (e) {
    if (e instanceof InteractionRequiredAuthError) {
      const r = await msalInstance.acquireTokenPopup({ scopes: GRAPH_SCOPES });
      return { account: r.account!, token: r.accessToken };
    }
    throw e;
  }
}

async function oneDriveLoadOrInit(): Promise<{
  glossar: Entry[];
  quellen: Source[];
}> {
  const { token } = await getGraphToken();

  const res = await fetch(`${GRAPH_BASE}${FILE_PATH}:/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 200) {
    return await res.json();
  }

  // Ordner "Glossar" (idempotent)
  await fetch(`${GRAPH_BASE}/me/drive/root/children`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "Glossar",
      folder: {},
      "@microsoft.graph.conflictBehavior": "replace",
    }),
  });

  const empty = { glossar: [], quellen: [] };

  const putRes = await fetch(`${GRAPH_BASE}${FILE_PATH}:/content`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(empty),
  });
  if (!putRes.ok) throw new Error("Konnte Glossar-Datei nicht anlegen");
  return empty;
}

async function oneDriveSaveAll(payload: {
  glossar: Entry[];
  quellen: Source[];
}) {
  const { token } = await getGraphToken();
  const res = await fetch(`${GRAPH_BASE}${FILE_PATH}:/content`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Speichern fehlgeschlagen");
}

/* === Word-Export (docx) === */
import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  TextRun,
  WidthType,
} from "docx";

/** === Typen === */
type Entry = {
  begriff: string;
  definition: string;
  beispiel: string;
  quellen: string[];
};
type Source = { quelle: string; beschreibung: string };

/** === Utils === */
function normalize(str: string) {
  return (str || "")
    .toString()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}
function levenshtein(a: string, b: string) {
  a = normalize(a);
  b = normalize(b);
  const m = a.length,
    n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  ) as number[][];
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}
function downloadBlob(
  filename: string,
  content: string,
  type = "text/plain;charset=utf-8"
) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csvEscape(val: unknown) {
  const s = String(val ?? "");
  if (/[,"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** === LocalStorage Keys === */
const LS_ENTRIES = "glossar_entries_v2";
const LS_SOURCES = "glossar_sources_v1";

/** === Defaultdaten === */
const defaultEntries: Entry[] = [
  {
    begriff: "Algorithmus",
    definition: "Schrittweise Anleitung zur Lösung eines Problems.",
    beispiel: "Ein Sortieralgorithmus ordnet Daten.",
    quellen: [],
  },
  {
    begriff: "Datenbank",
    definition: "System zur Speicherung und Verwaltung von Daten.",
    beispiel: "MySQL ist eine relationale Datenbank.",
    quellen: [],
  },
];
const defaultSources: Source[] = [
  { quelle: "Musterquelle 1", beschreibung: "Buch, Artikel oder Website" },
];

/** === Word (A–Z) === */
async function exportWordSorted(entries: Entry[], sources: Source[]) {
  const rows = [...entries].sort((a, b) =>
    normalize(a.begriff).localeCompare(normalize(b.begriff))
  );

  const headCells = ["Begriff", "Definition", "Beispiel", "Quellen"].map(
    (t) =>
      new TableCell({
        children: [
          new Paragraph({
            children: [new TextRun({ text: t, bold: true })],
          }),
        ],
      })
  );

  const dataRows = rows.map(
    (e) =>
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(e.begriff || "")] }),
          new TableCell({ children: [new Paragraph(e.definition || "")] }),
          new TableCell({ children: [new Paragraph(e.beispiel || "")] }),
          new TableCell({
            children: [new Paragraph((e.quellen || []).join("; "))],
          }),
        ],
      })
  );

  const glossarTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: headCells }), ...dataRows],
  });

  const qHead = ["Quelle", "Beschreibung"].map(
    (t) =>
      new TableCell({
        children: [
          new Paragraph({
            children: [new TextRun({ text: t, bold: true })],
          }),
        ],
      })
  );
  const qRows = (sources || []).map(
    (s) =>
      new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(s.quelle || "")] }),
          new TableCell({ children: [new Paragraph(s.beschreibung || "")] }),
        ],
      })
  );
  const quellenTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: qHead }), ...qRows],
  });

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun({ text: "Glossar (A–Z)", bold: true })],
          }),
          new Paragraph({
            children: [new TextRun({ text: new Date().toLocaleString() })],
          }),
          new Paragraph(" "),
          glossarTable,
          new Paragraph(" "),
          new Paragraph({
            children: [new TextRun({ text: "Quellenangaben", bold: true })],
          }),
          new Paragraph(" "),
          quellenTable,
        ],
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "Glossar_A-Z.docx";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** === App === */
export default function App() {
  const [entries, setEntries] = useState<Entry[]>(defaultEntries);
  const [sources, setSources] = useState<Source[]>(defaultSources);

  const [query, setQuery] = useState("");
  const [fuzzy, setFuzzy] = useState(true);
  const [fuzzyTol, setFuzzyTol] = useState(2);
  const [sortAsc, setSortAsc] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [selected, setSelected] = useState<Entry | null>(null);

  // einmalig aus localStorage laden
  useEffect(() => {
    try {
      const e = localStorage.getItem(LS_ENTRIES);
      if (e) setEntries(JSON.parse(e));
    } catch {}
    try {
      const s = localStorage.getItem(LS_SOURCES);
      if (s) setSources(JSON.parse(s));
    } catch {}
  }, []);
  // Änderungen speichern
  useEffect(() => {
    try {
      localStorage.setItem(LS_ENTRIES, JSON.stringify(entries));
    } catch {}
  }, [entries]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_SOURCES, JSON.stringify(sources));
    } catch {}
  }, [sources]);

  // Sortierung
  const sorted = useMemo(() => {
    const arr = [...entries].sort((a, b) =>
      normalize(a.begriff).localeCompare(normalize(b.begriff))
    );
    return sortAsc ? arr : arr.reverse();
  }, [entries, sortAsc]);

  // Suche (exakt -> Teil -> unscharf)
  const results = useMemo(() => {
    const q = query.trim();
    if (!q) return sorted;
    const nq = normalize(q);
    const exact = sorted.filter((e) => normalize(e.begriff) === nq);
    if (exact.length) return exact;
    const partial = sorted.filter((e) => normalize(e.begriff).includes(nq));
    if (partial.length) return partial;
    if (fuzzy) {
      return sorted
        .map((e) => ({ e, d: levenshtein(nq, e.begriff) }))
        .filter((x) => x.d <= fuzzyTol)
        .sort((a, b) => a.d - b.d)
        .map((x) => x.e);
    }
    return [];
  }, [sorted, query, fuzzy, fuzzyTol]);

  // CSV Export/Import (inkl. Quellen als Semikolonliste)
  function exportCSV() {
    const header = ["Begriff", "Definition", "Beispiel", "Quellen"].join(",");
    const rows = entries.map((e) =>
      [
        csvEscape(e.begriff),
        csvEscape(e.definition),
        csvEscape(e.beispiel),
        csvEscape(e.quellen.join("; ")),
      ].join(",")
    );
    downloadBlob(
      "Glossar.csv",
      [header, ...rows].join("\n"),
      "text/csv;charset=utf-8"
    );
  }
  async function importCSVFromFile(file: File) {
    const text = await file.text();
    const lines = text.split(/\r?\n/);
    if (!lines.length) return;

    function parseLine(line: string) {
      const cells: string[] = [];
      let cur = "",
        inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
          if (ch === '"' && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else if (ch === '"') {
            inQ = false;
          } else {
            cur += ch;
          }
        } else {
          if (ch === '"') inQ = true;
          else if (ch === ",") {
            cells.push(cur);
            cur = "";
          } else {
            cur += ch;
          }
        }
      }
      cells.push(cur);
      return cells;
    }

    const header = parseLine(lines[0] ?? "");
    const cols = header.map((s) => s.trim().toLowerCase());
    const idxB = cols.indexOf("begriff");
    const idxD = cols.indexOf("definition");
    const idxX = cols.indexOf("beispiel");
    const idxQ = cols.indexOf("quellen");
    if (idxB === -1) {
      alert("CSV braucht 'Begriff'.");
      return;
    }

    const parsed: Entry[] = lines
      .slice(1)
      .filter((l) => l.trim().length)
      .map((l) => {
        const c = parseLine(l);
        const q = (idxQ !== -1 ? c[idxQ] ?? "" : "")
          .split(/[;|,]/)
          .map((s) => s.trim())
          .filter(Boolean);
        return {
          begriff: c[idxB] ?? "",
          definition: idxD !== -1 ? c[idxD] ?? "" : "",
          beispiel: idxX !== -1 ? c[idxX] ?? "" : "",
          quellen: q,
        };
      });

    setEntries((prev) => {
      const merged = [...prev];
      parsed.forEach((p) => {
        if (!p.begriff?.trim()) return;
        const i = merged.findIndex(
          (x) => normalize(x.begriff) === normalize(p.begriff)
        );
        if (i >= 0) merged[i] = p;
        else merged.push(p);
      });
      return merged;
    });
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-6xl grid gap-6">
        {/* Kopf */}
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">📚 Glossar</h1>
          <div className="flex gap-2">
            <button
              className="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50"
              onClick={async () => {
                try {
                  const data = await oneDriveLoadOrInit();
                  setEntries(data.glossar || []);
                  setSources(data.quellen || []);
                  alert("Aus OneDrive geladen");
                } catch (e: any) {
                  alert(e.message || "Fehler beim Laden");
                }
              }}
            >
              Cloud laden
            </button>

            <button
              className="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50"
              onClick={async () => {
                try {
                  await oneDriveSaveAll({ glossar: entries, quellen: sources });
                  alert("In OneDrive gespeichert");
                } catch (e: any) {
                  alert(e.message || "Fehler beim Speichern");
                }
              }}
            >
              Cloud speichern
            </button>

            <button
              className="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50"
              onClick={() => exportWordSorted(entries, sources)}
            >
              Als Word (A–Z)
            </button>

            <button
              className="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50 flex items-center gap-2"
              onClick={exportCSV}
              title="Als CSV exportieren"
            >
              <Download className="h-4 w-4" /> CSV
            </button>

            <label
              className="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50 flex items-center gap-2 cursor-pointer"
              title="CSV importieren"
            >
              <input
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) importCSVFromFile(f);
                  (e.target as HTMLInputElement).value = "";
                }}
              />
              CSV importieren
            </label>
          </div>
        </header>

        {/* Suche */}
        <div className="rounded-2xl shadow-sm border bg-white p-4 grid gap-3">
          <div className="grid md:grid-cols-12 gap-3 items-end">
            <div className="md:col-span-6">
              <label htmlFor="query" className="text-sm font-medium">
                Suchbegriff
              </label>
              <div className="relative mt-1">
                <input
                  id="query"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Begriff eingeben…"
                  className="w-full rounded-xl border px-3 py-2 pr-10"
                />
                <Search className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 opacity-60" />
              </div>
            </div>

            <div className="md:col-span-3">
              <label className="text-sm font-medium">Unscharf</label>
              <select
                className="w-full mt-1 rounded-xl border px-3 py-2"
                value={String(fuzzy)}
                onChange={(e) => setFuzzy(e.target.value === "true")}
              >
                <option value="true">An</option>
                <option value="false">Aus</option>
              </select>
            </div>

            <div className="md:col-span-3">
              <label className="text-sm font-medium">Toleranz</label>
              <select
                className="w-full mt-1 rounded-xl border px-3 py-2"
                value={String(fuzzyTol)}
                onChange={(e) => setFuzzyTol(Number(e.target.value))}
              >
                {[0, 1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-600">
              Treffer:{" "}
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 border">
                {results.length}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50 flex items-center"
                onClick={() => setSortAsc((v) => !v)}
                title="Nach Begriff sortieren"
              >
                {sortAsc ? (
                  <ChevronDown className="h-4 w-4 mr-2" />
                ) : (
                  <ChevronUp className="h-4 w-4 mr-2" />
                )}
                Sortierung: Begriff {sortAsc ? "A→Z" : "Z→A"}
              </button>
            </div>
          </div>
        </div>

        {/* Ergebnisliste */}
        <div className="rounded-2xl shadow-sm border bg-white">
          <div className="grid grid-cols-12 text-xs uppercase text-gray-500 px-4 py-2">
            <div className="col-span-3">Begriff</div>
            <div className="col-span-5">Definition</div>
            <div className="col-span-4">Beispiel</div>
          </div>
          <div className="divide-y">
            {results.length === 0 && (
              <div className="p-6 text-gray-500 text-sm">
                Keine Treffer. Toleranz erhöhen oder Schreibweise prüfen.
              </div>
            )}
            {results.map((e) => (
              <button
                key={e.begriff}
                onClick={() => {
                  setSelected(e);
                  setModalOpen(true);
                }}
                className="w-full text-left hover:bg-gray-50 focus:bg-gray-50 outline-none"
              >
                <div className="grid grid-cols-12 gap-3 px-4 py-3">
                  <div className="col-span-3 font-medium">{e.begriff}</div>
                  <div className="col-span-5">{e.definition}</div>
                  <div className="col-span-4 text-gray-700">{e.beispiel}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Eintrag hinzufügen + Quellen-Zuordnung */}
        <AddEntry
          sources={sources}
          onAdd={(entry) => {
            if (!entry.begriff?.trim()) return;
            setEntries((prev) => {
              const i = prev.findIndex(
                (p) => normalize(p.begriff) === normalize(entry.begriff)
              );
              if (i >= 0) {
                const clone = [...prev];
                clone[i] = entry;
                return clone;
              }
              return [...prev, entry];
            });
          }}
          onAddSource={(s) => setSources((prev) => [...prev, s])}
        />

        {/* Quellenliste */}
        <Sources
          sources={sources}
          onAdd={(q) => setSources((s) => [...s, q])}
          onRemove={(i) =>
            setSources((s) => s.filter((_, idx) => idx !== i))
          }
        />
      </div>

      {/* Pop-up mit Löschen + Bestätigung */}
      {modalOpen && selected && (
        <div className="fixed inset-0 bg-black/30 grid place-items-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl max-w-xl w-full p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-semibold">{selected.begriff}</h3>
              <button
                className="p-2 rounded-lg hover:bg-gray-100"
                onClick={() => setModalOpen(false)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid gap-2">
              <div>
                <div className="text-xs uppercase text-gray-500">
                  Definition
                </div>
                <div>{selected.definition}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-gray-500">Beispiel</div>
                <div>{selected.beispiel}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-gray-500">Quellen</div>
                <div className="flex flex-wrap gap-2 mt-1">
                  {selected.quellen.length === 0 && (
                    <span className="text-gray-500 text-sm">
                      Keine Quelle zugeordnet.
                    </span>
                  )}
                  {selected.quellen.map((q) => (
                    <span
                      key={q}
                      className="px-2 py-1 rounded-full bg-gray-100 border text-xs"
                    >
                      {q}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2 mt-2">
                <button
                  className="px-3 py-2 rounded-lg border bg-red-50 text-red-600 hover:bg-red-100"
                  onClick={() => {
                    if (
                      window.confirm(
                        `Möchtest du den Eintrag "${selected.begriff}" wirklich löschen?`
                      )
                    ) {
                      setEntries((prev) =>
                        prev.filter((e) => e.begriff !== selected.begriff)
                      );
                      setModalOpen(false);
                    }
                  }}
                >
                  Löschen
                </button>

                <button
                  className="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50"
                  onClick={() => setModalOpen(false)}
                >
                  Schließen
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** === Formular: Eintrag + Quellen-Zuordnung === */
function AddEntry({
  onAdd,
  sources,
  onAddSource,
}: {
  onAdd: (e: Entry) => void;
  sources: Source[];
  onAddSource: (s: Source) => void;
}) {
  const [begr, setBegr] = useState("");
  const [def, setDef] = useState("");
  const [bsp, setBsp] = useState("");
  const [selectedQ, setSelectedQ] = useState<string[]>([]);
  const [newQ, setNewQ] = useState("");
  const [newQB, setNewQB] = useState("");

  function toggleQ(name: string) {
    setSelectedQ((prev) =>
      prev.includes(name) ? prev.filter((x) => x !== name) : [...prev, name]
    );
  }
  function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    onAdd({
      begriff: begr.trim(),
      definition: def.trim(),
      beispiel: bsp.trim(),
      quellen: selectedQ,
    });
    setBegr("");
    setDef("");
    setBsp("");
    setSelectedQ([]);
  }
  function submitNewSource(e: React.FormEvent) {
    e.preventDefault();
    const name = newQ.trim();
    if (!name) return;
    onAddSource({ quelle: name, beschreibung: newQB.trim() });
    setNewQ("");
    setNewQB("");
  }

  return (
    <div className="rounded-2xl shadow-sm border bg-white p-4 grid gap-4">
      <h2 className="text-lg font-semibold flex items-center gap-2">
        <Plus className="h-4 w-4" />
        Neuen Eintrag hinzufügen
      </h2>

      <form className="grid md:grid-cols-12 gap-3" onSubmit={submitAdd}>
        <div className="md:col-span-3">
          <label className="text-sm font-medium">Begriff</label>
          <input
            className="w-full mt-1 rounded-xl border px-3 py-2"
            value={begr}
            onChange={(e) => setBegr(e.target.value)}
            placeholder="z. B. Schnittstelle"
          />
        </div>
        <div className="md:col-span-5">
          <label className="text-sm font-medium">Definition</label>
          <input
            className="w-full mt-1 rounded-xl border px-3 py-2"
            value={def}
            onChange={(e) => setDef(e.target.value)}
            placeholder="Kurze Erklärung…"
          />
        </div>
        <div className="md:col-span-4">
          <label className="text-sm font-medium">Beispiel</label>
          <input
            className="w-full mt-1 rounded-xl border px-3 py-2"
            value={bsp}
            onChange={(e) => setBsp(e.target.value)}
            placeholder="Anwendungsbeispiel…"
          />
        </div>

        {/* Quellen-Auswahl */}
        <div className="md:col-span-12">
          <div className="text-sm font-medium mb-1">Quellen zuordnen</div>
          {sources.length === 0 && (
            <div className="text-sm text-gray-500 mb-1">
              Noch keine Quellen vorhanden.
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            {sources.map((s) => (
              <label
                key={s.quelle}
                className="flex items-center gap-2 px-2 py-1 rounded-lg border"
              >
                <input
                  type="checkbox"
                  checked={selectedQ.includes(s.quelle)}
                  onChange={() => toggleQ(s.quelle)}
                />
                <span>{s.quelle}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="md:col-span-12 flex justify-end">
          <button
            type="submit"
            className="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50 flex items-center gap-2"
          >
            <Plus className="h-4 w-4" />
            Hinzufügen
          </button>
        </div>
      </form>

      {/* Neue Quelle anlegen */}
      <div className="rounded-xl border bg-gray-50 p-3">
        <div className="text-sm font-medium mb-2">Neue Quelle hinzufügen</div>
        <form className="grid md:grid-cols-12 gap-3" onSubmit={submitNewSource}>
          <div className="md:col-span-4">
            <label className="text-sm">Quelle</label>
            <input
              className="w-full mt-1 rounded-xl border px-3 py-2"
              value={newQ}
              onChange={(e) => setNewQ(e.target.value)}
              placeholder="Buch/Artikel/URL"
            />
          </div>
          <div className="md:col-span-7">
            <label className="text-sm">Beschreibung</label>
            <input
              className="w-full mt-1 rounded-xl border px-3 py-2"
              value={newQB}
              onChange={(e) => setNewQB(e.target.value)}
              placeholder="Hinweise…"
            />
          </div>
          <div className="md:col-span-1 flex items-end justify-end">
            <button className="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50">
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** === Quellen-Tabelle === */
function Sources({
  sources,
  onAdd,
  onRemove,
}: {
  sources: Source[];
  onAdd: (s: Source) => void;
  onRemove: (i: number) => void;
}) {
  const [q, setQ] = useState("");
  const [b, setB] = useState("");

  return (
    <div className="rounded-2xl shadow-sm border bg-white p-4 grid gap-3">
      <h2 className="text-lg font-semibold">Quellenangaben</h2>

      <div className="grid grid-cols-12 text-xs uppercase text-gray-500">
        <div className="col-span-4">Quelle</div>
        <div className="col-span-7">Beschreibung</div>
        <div className="col-span-1" />
      </div>

      <div className="divide-y">
        {sources.length === 0 && (
          <div className="text-sm text-gray-500 p-2">
            Noch keine Quellen vorhanden.
          </div>
        )}
        {sources.map((s, i) => (
          <div key={i} className="grid grid-cols-12 gap-3 py-2">
            <div className="col-span-4">{s.quelle}</div>
            <div className="col-span-7">{s.beschreibung}</div>
            <div className="col-span-1 flex justify-end">
              <button
                className="p-2 rounded-lg hover:bg-gray-100"
                onClick={() => onRemove(i)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <form
        className="grid md:grid-cols-12 gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!q.trim()) return;
          onAdd({ quelle: q, beschreibung: b });
          setQ("");
          setB("");
        }}
      >
        <div className="md:col-span-4">
          <label className="text-sm font-medium">Quelle</label>
          <input
            className="w-full mt-1 rounded-xl border px-3 py-2"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="z. B. Buch/Artikel/URL"
          />
        </div>
        <div className="md:col-span-7">
          <label className="text-sm font-medium">Beschreibung</label>
          <input
            className="w-full mt-1 rounded-xl border px-3 py-2"
            value={b}
            onChange={(e) => setB(e.target.value)}
            placeholder="Hinweise…"
          />
        </div>
        <div className="md:col-span-1 flex items-end justify-end">
          <button
            type="submit"
            className="px-3 py-2 rounded-lg border bg-white hover:bg-gray-50"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  );
}
