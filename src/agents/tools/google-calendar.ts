import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { jsonResult, readNumberParam, readStringArrayParam, readStringParam } from "./common.js";
import { withTimeout } from "./web-shared.js";

const GOOGLE_CALENDAR_ACTIONS = ["create_event", "quick_add", "list_calendars"] as const;
const GOOGLE_CALENDAR_SEND_UPDATES = ["all", "none", "externalOnly"] as const;

const GoogleCalendarToolSchema = Type.Object({
  action: stringEnum(GOOGLE_CALENDAR_ACTIONS, {
    description: "Tool action: create_event, quick_add, list_calendars.",
  }),
  calendarId: Type.Optional(
    Type.String({
      description:
        'Calendar id (default: env GOOGLE_CALENDAR_ID or "primary"). For shared calendars, use the calendarId string.',
    }),
  ),
  // create_event
  summary: Type.Optional(Type.String({ description: "Event summary/title." })),
  description: Type.Optional(Type.String({ description: "Event description." })),
  location: Type.Optional(Type.String({ description: "Event location." })),
  start: Type.Optional(
    Type.String({
      description:
        "Start datetime ISO string. Prefer including timezone offset (e.g. 2026-02-17T08:00:00+03:00).",
    }),
  ),
  end: Type.Optional(
    Type.String({
      description: "End datetime ISO string. If omitted, durationMinutes is used (default 30).",
    }),
  ),
  timezone: Type.Optional(
    Type.String({
      description:
        'IANA timezone (used only when start/end omit offset). Default: env GOOGLE_CALENDAR_TZ or "Europe/Moscow".',
    }),
  ),
  durationMinutes: Type.Optional(
    Type.Number({ description: "Duration in minutes when end is not provided.", minimum: 1 }),
  ),
  attendees: Type.Optional(
    Type.Array(Type.String({ description: "Attendee email address." }), {
      description: "Attendees (emails).",
    }),
  ),
  remindersMinutesBefore: Type.Optional(
    Type.Array(
      Type.Number({ description: "Minutes before start for popup reminder.", minimum: 0 }),
      { description: "Popup reminder offsets (minutes). Example: [10]." },
    ),
  ),
  sendUpdates: optionalStringEnum(GOOGLE_CALENDAR_SEND_UPDATES, {
    description: 'Guest notification behavior ("all"|"none"|"externalOnly").',
  }),
  // quick_add
  text: Type.Optional(
    Type.String({
      description:
        "Quick-add text (natural language). Example: 'Подключение с Поповой 17.02.2026 08:00'.",
    }),
  ),
  // internal / overrides
  timeoutSeconds: Type.Optional(
    Type.Number({ description: "HTTP timeout in seconds (default 20).", minimum: 1 }),
  ),
});

type GoogleCalendarEnv = {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  calendarId?: string;
  timezone?: string;
};

function readEnv(): GoogleCalendarEnv {
  const clientId = (process.env.GOOGLE_CALENDAR_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GOOGLE_CALENDAR_CLIENT_SECRET ?? "").trim();
  const refreshToken = (process.env.GOOGLE_CALENDAR_REFRESH_TOKEN ?? "").trim();
  const calendarId = (process.env.GOOGLE_CALENDAR_ID ?? "").trim();
  const timezone = (process.env.GOOGLE_CALENDAR_TZ ?? "").trim();
  return {
    clientId: clientId || undefined,
    clientSecret: clientSecret || undefined,
    refreshToken: refreshToken || undefined,
    calendarId: calendarId || undefined,
    timezone: timezone || undefined,
  };
}

function hasCreds(
  env: GoogleCalendarEnv,
): env is Required<Pick<GoogleCalendarEnv, "clientId" | "clientSecret" | "refreshToken">> &
  GoogleCalendarEnv {
  return Boolean(env.clientId && env.clientSecret && env.refreshToken);
}

function assertAllowedGoogleUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid Google Calendar URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Google Calendar requests must use https");
  }
  const host = parsed.host.toLowerCase();
  const allowed = host === "oauth2.googleapis.com" || host === "www.googleapis.com";
  if (!allowed) {
    throw new Error("Blocked Google Calendar request host");
  }
}

async function fetchAccessToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  timeoutSeconds: number;
}): Promise<{ accessToken: string; expiresIn?: number }> {
  const url = "https://oauth2.googleapis.com/token";
  assertAllowedGoogleUrl(url);
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !payload.access_token) {
    const detail = payload.error_description || payload.error || res.statusText;
    throw new Error(`Google OAuth token exchange failed (${res.status}): ${detail}`.trim());
  }
  return { accessToken: payload.access_token, expiresIn: payload.expires_in };
}

async function googleJson<T>(params: {
  url: string;
  method: "GET" | "POST";
  accessToken: string;
  timeoutSeconds: number;
  body?: unknown;
}): Promise<T> {
  assertAllowedGoogleUrl(params.url);
  const res = await fetch(params.url, {
    method: params.method,
    headers: {
      Authorization: `Bearer ${params.accessToken}`,
      "Content-Type": "application/json",
    },
    body: params.body === undefined ? undefined : JSON.stringify(params.body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });
  const text = await res.text();
  const json = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: text } as unknown;
    }
  })();
  if (!res.ok) {
    const detail = typeof json === "object" && json ? JSON.stringify(json) : String(text);
    throw new Error(`Google Calendar API error (${res.status}): ${detail}`.trim());
  }
  return json as T;
}

function parseIsoDate(input: string): Date | null {
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) {
    return null;
  }
  return new Date(ms);
}

function toIsoOrThrow(date: Date): string {
  const iso = date.toISOString();
  if (!iso) {
    throw new Error("Failed to serialize datetime");
  }
  return iso;
}

export function createGoogleCalendarTool(): AnyAgentTool {
  return {
    label: "Google Calendar",
    name: "google_calendar",
    description:
      "Create Google Calendar events (requires OAuth refresh token credentials). Supports create_event, quick_add, and list_calendars.",
    parameters: GoogleCalendarToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const timeoutSecondsRaw = readNumberParam(params, "timeoutSeconds", { integer: true });
      const timeoutSeconds =
        typeof timeoutSecondsRaw === "number" && Number.isFinite(timeoutSecondsRaw)
          ? Math.max(1, Math.floor(timeoutSecondsRaw))
          : 20;
      const env = readEnv();
      const calendarId = readStringParam(params, "calendarId") ?? env.calendarId ?? "primary";
      const timezone = readStringParam(params, "timezone") ?? env.timezone ?? "Europe/Moscow";

      if (!hasCreds(env)) {
        return jsonResult({
          error: "missing_google_calendar_credentials",
          message:
            "Google Calendar tool is not configured. Set env vars: GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET, GOOGLE_CALENDAR_REFRESH_TOKEN (optional: GOOGLE_CALENDAR_ID, GOOGLE_CALENDAR_TZ).",
          calendarId,
          timezone,
        });
      }

      const { accessToken, expiresIn } = await fetchAccessToken({
        clientId: env.clientId,
        clientSecret: env.clientSecret,
        refreshToken: env.refreshToken,
        timeoutSeconds,
      });

      if (action === "list_calendars") {
        const url = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
        const result = await googleJson<{
          items?: Array<{ id?: string; summary?: string; primary?: boolean; accessRole?: string }>;
        }>({
          url,
          method: "GET",
          accessToken,
          timeoutSeconds,
        });
        const calendars = (result.items ?? []).map((c) => ({
          id: c.id ?? "",
          summary: c.summary ?? "",
          primary: Boolean(c.primary),
          accessRole: c.accessRole ?? "",
        }));
        return jsonResult({ calendars, expiresIn });
      }

      if (action === "quick_add") {
        const text = readStringParam(params, "text", { required: true });
        const sendUpdates = readStringParam(params, "sendUpdates") as
          | (typeof GOOGLE_CALENDAR_SEND_UPDATES)[number]
          | undefined;
        const url =
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/quickAdd?` +
          new URLSearchParams({
            text,
            ...(sendUpdates ? { sendUpdates } : {}),
          }).toString();
        const created = await googleJson<{
          id?: string;
          htmlLink?: string;
          summary?: string;
          start?: { dateTime?: string; date?: string; timeZone?: string };
          end?: { dateTime?: string; date?: string; timeZone?: string };
          status?: string;
        }>({
          url,
          method: "POST",
          accessToken,
          timeoutSeconds,
        });
        return jsonResult({
          calendarId,
          created: {
            id: created.id,
            htmlLink: created.htmlLink,
            summary: created.summary,
            status: created.status,
            start: created.start,
            end: created.end,
          },
          expiresIn,
        });
      }

      if (action !== "create_event") {
        throw new Error(`Unknown action: ${action}`);
      }

      const summary = readStringParam(params, "summary", { required: true, label: "summary" });
      const description = readStringParam(params, "description");
      const location = readStringParam(params, "location");
      const start = readStringParam(params, "start", { required: true, label: "start" });
      const end = readStringParam(params, "end");
      const durationMinutesRaw = readNumberParam(params, "durationMinutes", { integer: true });
      const durationMinutes =
        typeof durationMinutesRaw === "number" && Number.isFinite(durationMinutesRaw)
          ? Math.max(1, Math.floor(durationMinutesRaw))
          : 30;

      const startDate = parseIsoDate(start);
      if (!startDate) {
        throw new Error('Invalid "start": expected ISO datetime');
      }
      const endDate = end
        ? parseIsoDate(end)
        : new Date(startDate.getTime() + durationMinutes * 60_000);
      if (!endDate) {
        throw new Error('Invalid "end": expected ISO datetime');
      }
      if (endDate.getTime() <= startDate.getTime()) {
        throw new Error('"end" must be after "start"');
      }

      const attendeesEmails = readStringArrayParam(params, "attendees") ?? [];
      const remindersRaw = params.remindersMinutesBefore;
      const remindersMinutesBefore = Array.isArray(remindersRaw)
        ? remindersRaw
            .map((v) =>
              typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : null,
            )
            .filter((v): v is number => v != null)
        : [];
      const sendUpdates = readStringParam(params, "sendUpdates") as
        | (typeof GOOGLE_CALENDAR_SEND_UPDATES)[number]
        | undefined;

      const url =
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events` +
        (sendUpdates ? `?${new URLSearchParams({ sendUpdates }).toString()}` : "");

      const body: Record<string, unknown> = {
        summary,
        ...(description ? { description } : {}),
        ...(location ? { location } : {}),
        start: { dateTime: toIsoOrThrow(startDate), timeZone: timezone },
        end: { dateTime: toIsoOrThrow(endDate), timeZone: timezone },
        ...(attendeesEmails.length > 0
          ? { attendees: attendeesEmails.map((email) => ({ email })) }
          : {}),
        ...(remindersMinutesBefore.length > 0
          ? {
              reminders: {
                useDefault: false,
                overrides: remindersMinutesBefore.map((minutes) => ({
                  method: "popup",
                  minutes,
                })),
              },
            }
          : {}),
      };

      const created = await googleJson<{
        id?: string;
        htmlLink?: string;
        summary?: string;
        status?: string;
        start?: { dateTime?: string; date?: string; timeZone?: string };
        end?: { dateTime?: string; date?: string; timeZone?: string };
      }>({
        url,
        method: "POST",
        accessToken,
        timeoutSeconds,
        body,
      });

      return jsonResult({
        calendarId,
        created: {
          id: created.id,
          htmlLink: created.htmlLink,
          summary: created.summary,
          status: created.status,
          start: created.start,
          end: created.end,
        },
        expiresIn,
      });
    },
  };
}
