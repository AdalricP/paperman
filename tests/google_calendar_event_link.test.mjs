import assert from "node:assert/strict";
import { test } from "node:test";
import { google_calendar_event_link, next_full_hour_at_least_minutes_away } from "../source/google_calendar_event_link.mjs";

test("event link carries title, details, timezone and a local timestamp range", () => {
  const event_link = google_calendar_event_link({
    event_title: "Read: A Paper",
    event_details: "why it matters",
    start_date: new Date(2026, 6, 15, 18, 0, 0),
    duration_in_minutes: 60,
    timezone_name: "Asia/Kolkata",
  });
  const link_url = new URL(event_link);
  assert.equal(link_url.origin + link_url.pathname, "https://calendar.google.com/calendar/render");
  assert.equal(link_url.searchParams.get("action"), "TEMPLATE");
  assert.equal(link_url.searchParams.get("text"), "Read: A Paper");
  assert.equal(link_url.searchParams.get("details"), "why it matters");
  assert.equal(link_url.searchParams.get("dates"), "20260715T180000/20260715T190000");
  assert.equal(link_url.searchParams.get("ctz"), "Asia/Kolkata");
});

test("next full hour respects the minimum lead time", () => {
  const session_start = next_full_hour_at_least_minutes_away({
    now_date: new Date(2026, 6, 15, 17, 30, 0),
    minimum_minutes_away: 60,
  });
  assert.equal(session_start.getHours(), 19);
  assert.equal(session_start.getMinutes(), 0);
});

test("next full hour keeps an exact-hour boundary that satisfies the lead time", () => {
  const session_start = next_full_hour_at_least_minutes_away({
    now_date: new Date(2026, 6, 15, 17, 0, 0),
    minimum_minutes_away: 60,
  });
  assert.equal(session_start.getHours(), 18);
});
