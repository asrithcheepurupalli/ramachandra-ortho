"use client";

import { useEffect, useState, useMemo } from "react";
import {
  MessageSquare, RefreshCw, Search, CheckCircle2, XCircle, AlertCircle,
  Clock, Phone, User, ShieldAlert, Sparkles, Filter, ChevronDown, Check,
} from "lucide-react";
import { hasSupabase } from "@/lib/supabase";
import { loadMockWhatsAppLogs, type WhatsAppLog } from "@/lib/store";

export function MessagesView() {
  const [logs, setLogs] = useState<WhatsAppLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "sent" | "failed" | "skipped">("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "template" | "text" | "interactive">("all");

  const fetchLogs = async () => {
    setLoading(true);
    setError(null);
    if (!hasSupabase()) {
      setLogs(loadMockWhatsAppLogs());
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/admin/messages?limit=200");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLogs(data.logs || []);
    } catch (err) {
      console.error("Failed to load messages", err);
      setError("Could not load WhatsApp logs. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, []);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (statusFilter !== "all" && log.status !== statusFilter) return false;
      if (typeFilter !== "all" && log.messageType !== typeFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase().trim();
        const matchesPhone = log.phone.toLowerCase().includes(q);
        const matchesName = (log.patientName || "").toLowerCase().includes(q);
        const matchesTemplate = (log.templateName || "").toLowerCase().includes(q);
        const matchesDetails = (log.details || "").toLowerCase().includes(q);
        if (!matchesPhone && !matchesName && !matchesTemplate && !matchesDetails) return false;
      }
      return true;
    });
  }, [logs, search, statusFilter, typeFilter]);

  const stats = useMemo(() => {
    const total = logs.length;
    const sent = logs.filter((l) => l.status === "sent").length;
    const failed = logs.filter((l) => l.status === "failed").length;
    return { total, sent, failed };
  }, [logs]);

  const formatTimestamp = (ts: number) => {
    const d = new Date(ts);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    const timeStr = d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });
    if (isToday) return `Today, ${timeStr}`;
    return `${d.toLocaleDateString("en-IN", { month: "short", day: "numeric" })}, ${timeStr}`;
  };

  const formatPhone = (phone: string) => {
    const digits = phone.replace(/\D/g, "");
    if (digits.length === 10) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
    if (digits.length === 12 && digits.startsWith("91")) {
      return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
    }
    return phone;
  };

  const getTemplateLabel = (templateName: string | null) => {
    if (!templateName) return "Template Message";
    switch (templateName) {
      case "ortho_appointment_confirm_v2":
      case "ortho_appointment_confirm":
        return "Booking Confirmation";
      case "ortho_appointment_cancel":
        return "Booking Cancellation";
      case "ortho_payment_received":
        return "Payment Received";
      case "ortho_clinic_notice":
        return "Clinic Broadcast Notice";
      case "ortho_appointment_reminder":
        return "Appointment Reminder";
      case "clinic_welcome_booking_link":
        return "Welcome & Booking Link";
      case "ortho_post_consult_review_v1":
        return "Post-Consult Google Review";
      case "ortho_free_review_nudge_v1":
        return "Free Follow-up Nudge";
      case "ortho_verification_code":
        return "OTP Verification Code";
      case "ortho_doctor_daily_digest_v1":
        return "Doctor Daily Digest";
      default:
        return templateName;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & 7-day retention note */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-xl font-bold flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-brand" /> Outgoing WhatsApp Messages
          </h2>
          <p className="text-xs text-muted mt-1">
            Real-time delivery logs for booking confirmations, reminders, OTP codes, and bot replies.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchLogs}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-xl border border-line bg-white px-3.5 py-2 text-xs font-semibold text-ink shadow-sm transition hover:bg-bone disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin text-brand" : "text-muted"}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* 7-Day Auto-Retention Notice Card */}
      <div className="rounded-2xl border border-brand/20 bg-brand-tint/30 p-4 sm:p-5 flex items-start gap-3">
        <Clock className="h-5 w-5 text-brand shrink-0 mt-0.5" />
        <div className="text-xs sm:text-sm text-ink/90">
          <span className="font-semibold text-brand">7-Day Retention Policy:</span> Message logs are retained for 7 days to help staff verify delivery triggers and patient communications. Records older than 7 days are automatically pruned to keep the database fast and lightweight.
        </div>
      </div>

      {/* Summary KPI stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-2xl border border-line bg-paper p-4">
          <div className="text-xs text-muted font-medium">Logged (Last 7 Days)</div>
          <div className="text-xl sm:text-2xl font-bold mt-1">{stats.total}</div>
        </div>
        <div className="rounded-2xl border border-line bg-paper p-4">
          <div className="text-xs text-muted font-medium">Delivered to Meta</div>
          <div className="text-xl sm:text-2xl font-bold text-in mt-1">{stats.sent}</div>
        </div>
        <div className="rounded-2xl border border-line bg-paper p-4">
          <div className="text-xs text-muted font-medium">Failed / Errors</div>
          <div className={`text-xl sm:text-2xl font-bold mt-1 ${stats.failed > 0 ? "text-out" : "text-muted"}`}>
            {stats.failed}
          </div>
        </div>
      </div>

      {/* Controls: Search + Status + Type filters */}
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between bg-paper p-3.5 rounded-2xl border border-line">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted" />
          <input
            type="text"
            placeholder="Search by phone, patient name, or template..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-xs sm:text-sm rounded-xl border border-line bg-white outline-none focus:border-brand"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-ink"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Status filter pills */}
          <div className="flex items-center rounded-xl border border-line bg-white p-0.5">
            {(["all", "sent", "failed", "skipped"] as const).map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-lg capitalize transition ${
                  statusFilter === st ? "bg-brand text-white font-semibold" : "text-muted hover:text-ink"
                }`}
              >
                {st}
              </button>
            ))}
          </div>

          {/* Type filter */}
          <div className="flex items-center rounded-xl border border-line bg-white p-0.5">
            {(["all", "template", "text", "interactive"] as const).map((tp) => (
              <button
                key={tp}
                onClick={() => setTypeFilter(tp)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded-lg capitalize transition ${
                  typeFilter === tp ? "bg-ink text-white font-semibold" : "text-muted hover:text-ink"
                }`}
              >
                {tp}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Logs Table / Card List */}
      {error && (
        <div className="rounded-xl border border-out/20 bg-out/10 p-4 text-xs sm:text-sm text-out flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-2xl border border-line bg-paper p-12 text-center text-sm text-muted">
          <RefreshCw className="h-6 w-6 animate-spin text-brand mx-auto mb-3" />
          Loading message logs…
        </div>
      ) : filteredLogs.length === 0 ? (
        <div className="rounded-2xl border border-line bg-paper p-12 text-center text-sm text-muted">
          <MessageSquare className="h-8 w-8 text-line mx-auto mb-2" />
          {logs.length === 0
            ? "No outgoing messages logged yet in the last 7 days."
            : "No messages match your search or filters."}
        </div>
      ) : (
        <div className="space-y-2.5">
          {filteredLogs.map((log) => {
            const isSent = log.status === "sent";
            const isFailed = log.status === "failed";
            const isSkipped = log.status === "skipped";

            return (
              <div
                key={log.id}
                className="group rounded-2xl border border-line bg-paper p-4 transition hover:border-brand/40 sm:flex sm:items-start sm:justify-between gap-4"
              >
                <div className="space-y-1.5 flex-1 min-w-0">
                  {/* Row Top: Badges + Timestamp */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                        isSent
                          ? "bg-in/15 text-in"
                          : isFailed
                          ? "bg-out/15 text-out"
                          : "bg-line/60 text-muted"
                      }`}
                    >
                      {isSent ? (
                        <CheckCircle2 className="h-3 w-3" />
                      ) : isFailed ? (
                        <XCircle className="h-3 w-3" />
                      ) : (
                        <AlertCircle className="h-3 w-3" />
                      )}
                      {log.status.toUpperCase()}
                    </span>

                    <span className="inline-flex items-center gap-1 rounded-full bg-bone px-2 py-0.5 text-[11px] font-medium text-ink/80 border border-line">
                      {log.messageType === "template"
                        ? "Template"
                        : log.messageType === "interactive"
                        ? "Interactive"
                        : "Direct Text"}
                    </span>

                    {log.templateName && (
                      <span className="text-[11px] font-semibold text-brand truncate max-w-[14rem] sm:max-w-none">
                        {getTemplateLabel(log.templateName)}
                      </span>
                    )}

                    <span className="text-[11px] text-muted ml-auto sm:ml-0">
                      {formatTimestamp(log.createdAt)}
                    </span>
                  </div>

                  {/* Recipient info */}
                  <div className="flex flex-wrap items-center gap-3 pt-1 text-xs sm:text-sm">
                    {log.patientName && (
                      <div className="flex items-center gap-1 font-semibold text-ink">
                        <User className="h-3.5 w-3.5 text-muted" />
                        {log.patientName}
                      </div>
                    )}
                    <div className="flex items-center gap-1 font-mono text-xs text-muted">
                      <Phone className="h-3.5 w-3.5" />
                      {formatPhone(log.phone)}
                    </div>
                  </div>

                  {/* Details or content preview */}
                  {log.details && (
                    <div className="text-xs text-ink/80 font-mono bg-white/70 rounded-xl border border-line/60 px-3 py-2 mt-1 break-words">
                      {log.details}
                    </div>
                  )}

                  {/* Error Message if failed */}
                  {log.errorMessage && (
                    <div className="text-xs text-out font-mono bg-out/5 rounded-xl border border-out/20 px-3 py-2 mt-1 break-words">
                      Error: {log.errorMessage}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
