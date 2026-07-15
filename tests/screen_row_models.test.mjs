import assert from "node:assert/strict";
import { test } from "node:test";
import { arxiv_id_after_selection_move, build_paper_list_rows, build_settings_rows, fit_text_to_width, interactive_settings_row_indexes, masked_api_key_text, nearest_interactive_settings_row_index, selected_paper_row_index, settings_cursor_index_after_move, weekday_day_month_label } from "../source/screen_row_models.mjs";

const selected_paper = (arxiv_id, primary_arxiv_category_code, source_feed_category_code = primary_arxiv_category_code) => ({ arxiv_id, title: `Title ${arxiv_id}`, primary_arxiv_category_code, source_feed_category_code });
const daily_selection_fixture = { selection_date_iso: "2026-07-15", arxiv_announcement_date_iso: "2026-07-10", selected_papers: [selected_paper("2607.00001", "cond-mat.str-el", "physics.space-ph"), selected_paper("2607.00002", "cs.RO"), selected_paper("2607.00003", "cond-mat.str-el", "physics.space-ph")], mark_by_arxiv_id: {} };
const settings_fixture = { tracked_arxiv_category_codes: ["cs.LG", "hep-ex", "physics"], papers_per_category_per_day: 10, interests_blurb_text: "world models", reading_intent_blurb_text: "", openrouter_api_key: "or_secret_key_material", openrouter_chat_model_id: "deepseek/deepseek-v4-flash" };

test("fit text truncates with ellipsis and pads short text", () => {
  assert.equal(fit_text_to_width("abcdef", 4), "abc…");
  assert.equal(fit_text_to_width("ab", 4), "ab  ");
});

test("weekday label renders an iso date", () => assert.match(weekday_day_month_label("2026-07-15"), /Wed.*15.*Jul/));

test("paper list groups by tracked source category rather than paper primary category", () => {
  const rows = build_paper_list_rows(daily_selection_fixture);
  assert.match(rows[0].text, /announced/);
  assert.deepEqual(rows.filter((row) => row.type === "category_heading").map((row) => row.text), ["cs.RO — Robotics", "physics.space-ph — Space Physics"]);
  assert.deepEqual(rows.filter((row) => row.type === "paper").map((row) => row.paper.arxiv_id), ["2607.00002", "2607.00001", "2607.00003"]);
});

test("selection defaults to the first paper and moves with clamping", () => {
  const rows = build_paper_list_rows(daily_selection_fixture);
  assert.equal(rows[selected_paper_row_index(rows, null)].paper.arxiv_id, "2607.00002");
  assert.equal(arxiv_id_after_selection_move(rows, "2607.00002", 1), "2607.00001");
});

test("settings show a category tree, API key only, and a hard reset action", () => {
  const rows = build_settings_rows(settings_fixture);
  assert.ok(rows.some((row) => row.type === "category_group"));
  assert.ok(rows.some((row) => row.type === "category_checkbox" && row.arxiv_category_code === "physics" && /all Physics categories/.test(row.label)));
  assert.deepEqual(rows.filter((row) => row.type === "text_setting").map((row) => row.setting_key), ["interests_blurb_text", "reading_intent_blurb_text", "papers_per_category_per_day", "openrouter_api_key"]);
  assert.equal(rows.filter((row) => row.type === "hard_reset_action").length, 1);
});

test("settings cursor moves only across interactive rows", () => {
  const rows = build_settings_rows(settings_fixture);
  const interactive_row_indexes = interactive_settings_row_indexes(rows);
  assert.equal(nearest_interactive_settings_row_index(rows, 0), interactive_row_indexes[0]);
  assert.equal(settings_cursor_index_after_move(rows, interactive_row_indexes[0], 1), interactive_row_indexes[1]);
});

test("api key is masked to a short prefix", () => {
  assert.equal(masked_api_key_text("or_secret_key_material"), "or_sec…");
  assert.equal(masked_api_key_text(""), "(not set)");
});
