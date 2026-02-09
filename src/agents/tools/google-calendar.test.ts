import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleCalendarTool } from "./google-calendar.js";

describe("google_calendar tool", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    vi.unstubAllEnvs();
    // @ts-expect-error restore fetch
    global.fetch = priorFetch;
  });

  it("returns a helpful payload when credentials are missing", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_SECRET", "");
    vi.stubEnv("GOOGLE_CALENDAR_REFRESH_TOKEN", "");
    const fetchMock = vi.fn();
    // @ts-expect-error mock fetch
    global.fetch = fetchMock;

    const tool = createGoogleCalendarTool();
    const res = await tool.execute("call1", {
      action: "create_event",
      summary: "Test",
      start: "2026-02-17T08:00:00+03:00",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res?.details).toMatchObject({
      error: "missing_google_calendar_credentials",
    });
  });

  it("exchanges refresh token and creates an event", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_ID", "cid");
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_SECRET", "csecret");
    vi.stubEnv("GOOGLE_CALENDAR_REFRESH_TOKEN", "rtok");
    vi.stubEnv("GOOGLE_CALENDAR_ID", "primary");

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://oauth2.googleapis.com/token") {
        expect(init?.method).toBe("POST");
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "at", expires_in: 3600, token_type: "Bearer" }),
        } as unknown as Response;
      }
      if (
        typeof url === "string" &&
        url.startsWith("https://www.googleapis.com/calendar/v3/calendars/")
      ) {
        expect(init?.method).toBe("POST");
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        expect(auth).toBe("Bearer at");
        const rawBody = typeof init?.body === "string" ? init.body : "";
        const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : null;
        expect(body?.summary).toBe("Подключение с Поповой");
        expect(body?.start?.dateTime).toContain("2026-02-17T"); // toISOString
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              id: "evt_1",
              htmlLink: "https://calendar.google.com/event?eid=evt_1",
              summary: body?.summary,
              status: "confirmed",
              start: body?.start,
              end: body?.end,
            }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    // @ts-expect-error mock fetch
    global.fetch = fetchMock;

    const tool = createGoogleCalendarTool();
    const res = await tool.execute("call1", {
      action: "create_event",
      summary: "Подключение с Поповой",
      start: "2026-02-17T08:00:00+03:00",
      durationMinutes: 30,
      remindersMinutesBefore: [10],
      sendUpdates: "none",
    });

    expect(res?.details).toMatchObject({
      calendarId: "primary",
      created: { id: "evt_1" },
    });
  });

  it("quick_add calls Google quickAdd endpoint", async () => {
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_ID", "cid");
    vi.stubEnv("GOOGLE_CALENDAR_CLIENT_SECRET", "csecret");
    vi.stubEnv("GOOGLE_CALENDAR_REFRESH_TOKEN", "rtok");
    vi.stubEnv("GOOGLE_CALENDAR_ID", "primary");

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "at", expires_in: 3600, token_type: "Bearer" }),
        } as unknown as Response;
      }
      if (typeof url === "string" && url.includes("/events/quickAdd?")) {
        expect(init?.method).toBe("POST");
        expect(url).toContain("text=");
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              id: "evt_qa",
              htmlLink: "https://calendar.google.com/event?eid=evt_qa",
              status: "confirmed",
            }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected url: ${url}`);
    });
    // @ts-expect-error mock fetch
    global.fetch = fetchMock;

    const tool = createGoogleCalendarTool();
    const res = await tool.execute("call1", {
      action: "quick_add",
      text: "Подключение с Поповой 17.02.2026 08:00",
      sendUpdates: "none",
    });
    expect(res?.details).toMatchObject({ created: { id: "evt_qa" } });
  });
});
