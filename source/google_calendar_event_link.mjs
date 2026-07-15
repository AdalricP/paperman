const google_calendar_render_url = "https://calendar.google.com/calendar/render";
const milliseconds_per_minute = 60_000;

function compact_local_timestamp(date) {
  return (
    date.getFullYear().toString() +
    String(date.getMonth() + 1).padStart(2, "0") +
    String(date.getDate()).padStart(2, "0") +
    "T" +
    String(date.getHours()).padStart(2, "0") +
    String(date.getMinutes()).padStart(2, "0") +
    "00"
  );
}

export function google_calendar_event_link({
  event_title,
  event_details,
  start_date,
  duration_in_minutes,
  timezone_name,
}) {
  const end_date = new Date(start_date.getTime() + duration_in_minutes * milliseconds_per_minute);
  const query_parameters = new URLSearchParams({
    action: "TEMPLATE",
    text: event_title,
    details: event_details,
    dates: `${compact_local_timestamp(start_date)}/${compact_local_timestamp(end_date)}`,
    ctz: timezone_name,
  });
  return `${google_calendar_render_url}?${query_parameters}`;
}

export function next_full_hour_at_least_minutes_away({ now_date, minimum_minutes_away }) {
  const earliest_acceptable_date = new Date(now_date.getTime() + minimum_minutes_away * milliseconds_per_minute);
  const next_full_hour_date = new Date(earliest_acceptable_date);
  next_full_hour_date.setMinutes(0, 0, 0);
  if (next_full_hour_date.getTime() < earliest_acceptable_date.getTime()) {
    next_full_hour_date.setHours(next_full_hour_date.getHours() + 1);
  }
  return next_full_hour_date;
}
