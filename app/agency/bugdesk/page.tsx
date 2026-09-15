"use client";

import { useEffect, useState, useCallback } from "react";

type BugRow = {
  fingerprint: string;
  source: string;
  message: string;
  severity: "critical" | "warning";
  count: number;
  first_seen: string;
  last_seen: string;
  alerted_at: string | null;
  resolved: boolean;
};

function bugLastSeen(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const TOKEN_KEY = "agency_token";

export default function AgencyBugDesk() {
  const [token, setToken] = useState<string | null>(() => {
    try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
  });
  const [input, setInput] = useState("");
  const [authError, setAuthError] = useState("");
  const [checking, setChecking] = useState(false);

  const [rows, setRows] = useState<BugRow[]>([]);
  // Initialize loading=true when a token is already stored so the first fetch
  // doesn't flash the empty state. Never set loading inside an effect body
  // directly — that triggers react-hooks/set-state-in-effect.
  const [loading, setLoading] = useState(() => {
    try { return !!sessionStorage.getItem(TOKEN_KEY); } catch { return false; }
  });
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState<"all" | "critical" | "warning">("all");

  const fetchRows = useCallback(async (t: string) => {
    // No setState calls before the first await — that would fire synchronously
    // inside the useEffect body and trigger react-hooks/set-state-in-effect.
    try {
      const res = await fetch("/api/agency/bugdesk", {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (res.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setLoadError("Session expired. Please re-enter the password.");
        setLoading(false);
        return;
      }
      if (!res.ok) { setLoadError("Could not load bug desk."); setLoading(false); return; }
      const json = await res.json();
      setRows(json.rows ?? []);
      setLoadError("");
    } catch {
      setLoadError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (token) { void fetchRows(token); }
  }, [token, fetchRows]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    setChecking(true);
    setAuthError("");
    try {
      const res = await fetch("/api/agency/bugdesk", {
        headers: { Authorization: `Bearer ${input.trim()}` },
      });
      if (res.status === 401) { setAuthError("Incorrect password."); return; }
      if (!res.ok) { setAuthError("Something went wrong."); return; }
      const json = await res.json();
      sessionStorage.setItem(TOKEN_KEY, input.trim());
      setToken(input.trim());
      setRows(json.rows ?? []);
    } catch {
      setAuthError("Network error. Please try again.");
    } finally {
      setChecking(false);
    }
  }

  async function toggleResolved(row: BugRow) {
    const next = !row.resolved;
    setRows(prev => prev.map(r => r.fingerprint === row.fingerprint ? { ...r, resolved: next } : r));
    try {
      const res = await fetch("/api/agency/bugdesk", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ fingerprint: row.fingerprint, resolved: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      // revert on failure
      setRows(prev => prev.map(r => r.fingerprint === row.fingerprint ? { ...r, resolved: row.resolved } : r));
    }
  }

  // --- Auth gate ---
  if (!token) {
    return (
      <div style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f5f8f6",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        padding: "24px",
      }}>
        <div style={{
          background: "#fff",
          borderRadius: "16px",
          padding: "40px 36px",
          width: "100%",
          maxWidth: "420px",
          boxShadow: "0 1px 2px rgba(14,26,23,.04), 0 12px 32px -18px rgba(12,122,104,.28)",
        }}>
          <div style={{ marginBottom: "28px" }}>
            <div style={{ fontSize: "11px", fontWeight: 700, color: "#0c7a68", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: "6px" }}>
              made. by ac · Agency Portal
            </div>
            <h1 style={{ fontSize: "22px", fontWeight: 700, color: "#0e1a17", margin: 0, letterSpacing: "-.02em" }}>
              Bug Desk
            </h1>
            <p style={{ color: "#5c6b66", fontSize: "14px", marginTop: "6px" }}>
              Ramachandra Ortho Care — error log
            </p>
          </div>
          <form onSubmit={handleLogin}>
            <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#0e1a17", marginBottom: "6px" }}>
              Agency password
            </label>
            <input
              type="password"
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Enter password"
              autoFocus
              style={{
                width: "100%",
                padding: "10px 14px",
                borderRadius: "8px",
                border: "1.5px solid #e3ebe7",
                fontSize: "14px",
                color: "#0e1a17",
                outline: "none",
                marginBottom: "12px",
                boxSizing: "border-box",
                background: "#f5f8f6",
              }}
            />
            {authError && (
              <div style={{ color: "#ef6f53", fontSize: "13px", marginBottom: "10px" }}>{authError}</div>
            )}
            <button
              type="submit"
              disabled={checking}
              style={{
                width: "100%",
                padding: "10px",
                borderRadius: "8px",
                background: checking ? "#a3c4bb" : "#0c7a68",
                color: "#fff",
                fontWeight: 700,
                fontSize: "14px",
                border: "none",
                cursor: checking ? "default" : "pointer",
              }}
            >
              {checking ? "Checking..." : "Access Bug Desk"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // --- Bug Desk UI ---
  const visible = rows.filter(r => filter === "all" || r.severity === filter);
  const critCount = rows.filter(r => !r.resolved && r.severity === "critical").length;

  return (
    <div style={{
      minHeight: "100vh",
      background: "#f5f8f6",
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
      color: "#0e1a17",
      padding: "24px 16px",
    }}>
      <div style={{ maxWidth: "960px", margin: "0 auto" }}>
        {/* Header */}
        <div style={{ marginBottom: "24px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
          <div>
            <div style={{ fontSize: "11px", fontWeight: 700, color: "#0c7a68", textTransform: "uppercase", letterSpacing: ".08em", marginBottom: "4px" }}>
              made. by ac · Agency Portal
            </div>
            <h1 style={{ fontSize: "22px", fontWeight: 700, color: "#0e1a17", margin: 0, letterSpacing: "-.02em" }}>
              Bug Desk
              {critCount > 0 && (
                <span style={{ marginLeft: "10px", background: "#ef6f53", color: "#fff", fontSize: "12px", fontWeight: 700, padding: "2px 8px", borderRadius: "99px" }}>
                  {critCount} critical
                </span>
              )}
            </h1>
            <p style={{ color: "#5c6b66", fontSize: "13px", margin: "4px 0 0" }}>
              Ramachandra Ortho Care — last 100 errors
            </p>
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button
              onClick={() => fetchRows(token)}
              style={{ padding: "7px 14px", borderRadius: "8px", border: "1.5px solid #e3ebe7", background: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer", color: "#0e1a17" }}
            >
              Refresh
            </button>
            <button
              onClick={() => { sessionStorage.removeItem(TOKEN_KEY); setToken(null); setRows([]); }}
              style={{ padding: "7px 14px", borderRadius: "8px", border: "1.5px solid #e3ebe7", background: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer", color: "#5c6b66" }}
            >
              Sign out
            </button>
          </div>
        </div>

        {/* Filter pills */}
        <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
          {(["all", "critical", "warning"] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: "5px 14px",
                borderRadius: "99px",
                border: "1.5px solid",
                borderColor: filter === f ? "#0c7a68" : "#e3ebe7",
                background: filter === f ? "#e2f1ec" : "#fff",
                color: filter === f ? "#0a5d50" : "#5c6b66",
                fontWeight: 600,
                fontSize: "13px",
                cursor: "pointer",
              }}
            >
              {f === "all" ? `All (${rows.length})` : f === "critical" ? `Critical (${rows.filter(r => r.severity === "critical").length})` : `Warning (${rows.filter(r => r.severity === "warning").length})`}
            </button>
          ))}
        </div>

        {/* Error state */}
        {loadError && (
          <div style={{ background: "#fef2f2", border: "1.5px solid #fca5a5", borderRadius: "10px", padding: "12px 16px", color: "#b91c1c", fontSize: "13px", marginBottom: "16px" }}>
            {loadError}
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: "center", color: "#5c6b66", padding: "48px 0", fontSize: "14px" }}>
            Loading errors...
          </div>
        )}

        {/* Empty */}
        {!loading && !loadError && visible.length === 0 && (
          <div style={{ textAlign: "center", padding: "64px 0", color: "#5c6b66", fontSize: "14px" }}>
            {rows.length === 0 ? "No errors logged." : "No errors match this filter."}
          </div>
        )}

        {/* Table */}
        {!loading && visible.length > 0 && (
          <div style={{ background: "#fff", borderRadius: "12px", border: "1.5px solid #e3ebe7", overflow: "hidden" }}>
            {visible.map((row, i) => (
              <div
                key={row.fingerprint}
                style={{
                  padding: "16px 20px",
                  borderBottom: i < visible.length - 1 ? "1px solid #e3ebe7" : "none",
                  opacity: row.resolved ? 0.55 : 1,
                  display: "grid",
                  gridTemplateColumns: "auto 1fr auto auto",
                  gap: "12px 16px",
                  alignItems: "start",
                }}
              >
                {/* Severity badge + source */}
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: "80px" }}>
                  <span style={{
                    display: "inline-block",
                    padding: "2px 8px",
                    borderRadius: "99px",
                    fontSize: "11px",
                    fontWeight: 700,
                    background: row.severity === "critical" ? "#fef2f2" : "#fef5e7",
                    color: row.severity === "critical" ? "#b91c1c" : "#d68910",
                    textTransform: "uppercase",
                    letterSpacing: ".04em",
                  }}>
                    {row.severity}
                  </span>
                  <span style={{ fontFamily: "ui-monospace, monospace", fontSize: "11px", color: "#5c6b66", wordBreak: "break-all" }}>
                    {row.source}
                  </span>
                </div>

                {/* Message */}
                <div>
                  <div style={{ fontSize: "14px", fontWeight: 600, color: "#0e1a17", marginBottom: "4px", wordBreak: "break-word" }}>
                    {row.message}
                  </div>
                  <div style={{ fontSize: "12px", color: "#5c6b66" }}>
                    {row.count} occurrence{row.count !== 1 ? "s" : ""}
                    {row.alerted_at && (
                      <span style={{ marginLeft: "8px", color: "#0c7a68" }}>· alerted</span>
                    )}
                  </div>
                </div>

                {/* Last seen */}
                <div style={{ fontSize: "12px", color: "#5c6b66", whiteSpace: "nowrap", textAlign: "right" }}>
                  {bugLastSeen(row.last_seen)}
                </div>

                {/* Status + action */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px" }}>
                  {row.resolved && (
                    <span style={{ fontSize: "11px", fontWeight: 700, color: "#0c7a68", background: "#e2f1ec", borderRadius: "99px", padding: "2px 8px" }}>
                      Resolved
                    </span>
                  )}
                  <button
                    onClick={() => toggleResolved(row)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: "6px",
                      border: "1.5px solid #e3ebe7",
                      background: "#f5f8f6",
                      fontSize: "12px",
                      fontWeight: 600,
                      cursor: "pointer",
                      color: row.resolved ? "#0c7a68" : "#5c6b66",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {row.resolved ? "Reopen" : "Resolve"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
