import assert from "node:assert/strict";
import { test } from "node:test";
import {
  arxiv_id_after_selection_move,
  build_paper_list_rows,
  build_settings_rows,
  fit_text_to_width,
  interactive_settings_row_indexes,
  masked_api_key_text,
  nearest_interactive_settings_row_index,
  selected_paper_row_index,
  settings_cursor_index_after_move,
  weekday_day_month_label,
} from "../source/screen_row_models.mjs";

const selected_paper = (arxiv_id, category_code) => ({
  arxiv_id,
  title: `Title ${arxiv_id}`,
  primary_arxiv_category_code: category_code,
});

const daily_selection_fixture = {
  selection_date_iso: "2026-07-15",
  arxiv_announcement_date_iso: "2026-07-10",
  selected_papers: [
    selected_paper("2607.00001", "cs.LG"),
    selected_paper("2607.00002", "cs.RO"),
    selected_paper("2607.00003", "cs.LG"),
  ],
  mark_by_arxiv_id: {},
};

test("fit text truncates with ellipsis and pads short text", () => {
  assert.equal(fit_text_to_width("abcdef", 4), "abc…");
  assert.equal(fit_text_to_width("ab", 4), "ab  ");
});

test("weekday label renders an iso date", () => {
  assert.match(weekday_day_month_label("2026-07-15"), /Wed.*15.*Jul/);
});

test("paper list groups papers under category headings and flags stale announcements", () => {
  const rows = build_paper_list_rows(daily_selection_fixture);
  assert.match(rows[0].text, /announced/);
  const heading_texts = rows.filter((row) => row.type === "category_heading").map((row) => row.text);
  assert.deepEqual(heading_texts, ["cs.LG — Machine Learning", "cs.RO — Robotics"]);
  const paper_ids_in_row_order = rows.filter((row) => row.type === "paper").map((row) => row.paper.arxiv_id);
  assert.deepEqual(paper_ids_in_row_order, ["2607.00001", "2607.00003", "2607.00002"]);
  const last_heading = rows.findLast((row) => row.type === "category_heading");
  assert.equal(last_heading.is_last_category, true);
});

test("selection defaults to the first paper and moves with clamping", () => {
  const rows = build_paper_list_rows(daily_selection_fixture);
  const first_paper_row_index = selected_paper_row_index(rows, null);
  assert.equal(rows[first_paper_row_index].paper.arxiv_id, "2607.00001");
  assert.equal(arxiv_id_after_selection_move(rows, "2607.00001", 1), "2607.00003");
  assert.equal(arxiv_id_after_selection_move(rows, "2607.00001", -1), "2607.00001");
  assert.equal(arxiv_id_after_selection_move(rows, "2607.00002", 1), "2607.00002");
});

const settings_fixture = {
  tracked_arxiv_category_codes: ["cs.LG", "hep-ex"],
  interests_blurb_text: "world models",
  reading_intent_blurb_text: "",
  fireworks_api_key: "fw_secret_key_material",
  fireworks_chat_model_id: "accounts/fireworks/models/glm-5p2",
};

test("settings rows list catalog plus custom categories and the editable settings", () => {
  const rows = build_settings_rows(settings_fixture);
  const checkbox_codes = rows.filter((row) => row.type === "category_checkbox").map((row) => row.arxiv_category_code);
  assert.ok(checkbox_codes.includes("cs.LG"));
  assert.ok(checkbox_codes.includes("hep-ex"));
  const text_setting_keys = rows.filter((row) => row.type === "text_setting").map((row) => row.setting_key);
  assert.deepEqual(text_setting_keys, [
    "interests_blurb_text",
    "reading_intent_blurb_text",
    "fireworks_api_key",
    "fireworks_chat_model_id",
  ]);
  assert.equal(rows.filter((row) => row.type === "add_custom_category_action").length, 1);
});

test("settings cursor moves only across interactive rows", () => {
  const rows = build_settings_rows(settings_fixture);
  const interactive_indexes = interactive_settings_row_indexes(rows);
  assert.equal(nearest_interactive_settings_row_index(rows, 0), interactive_indexes[0]);
  const second_interactive_index = settings_cursor_index_after_move(rows, interactive_indexes[0], 1);
  assert.equal(second_interactive_index, interactive_indexes[1]);
  const clamped_top_index = settings_cursor_index_after_move(rows, interactive_indexes[0], -1);
  assert.equal(clamped_top_index, interactive_indexes[0]);
});

test("api key is masked to a short prefix", () => {
  assert.equal(masked_api_key_text("fw_secret_key_material"), "fw_sec…");
  assert.equal(masked_api_key_text(""), "(not set)");
});
