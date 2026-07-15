import assert from "node:assert/strict";
import { test } from "node:test";
import {
  candidate_pool_after_merging_fetched_papers,
  daily_paper_selection_for_date,
  merged_papers_across_feeds,
  sanitized_papers_per_category_per_day,
  selection_targets_for_candidates,
} from "../source/daily_paper_selection_pipeline.mjs";

const feed_paper = (arxiv_id, category_code) => ({
  arxiv_id,
  title: `Title ${arxiv_id}`,
  abstract_text: `Abstract about ${arxiv_id}`,
  author_names: [],
  arxiv_category_codes: [category_code],
  primary_arxiv_category_code: category_code,
  arxiv_abstract_url: `https://arxiv.org/abs/${arxiv_id}`,
});

const quota_honoring_request_pick = async (prompt_text) => {
  const candidate_papers = prompt_text
    .split("\n")
    .filter((prompt_line) => prompt_line.startsWith('{"arxiv_id"'))
    .map((candidate_line) => JSON.parse(candidate_line));
  const quota_summary = prompt_text.match(/exactly these counts \(total \d+\): ([^\n]+)\./)[1];
  const remaining_target_by_category = Object.fromEntries(
    quota_summary.split(" · ").map((quota_part) => {
      const [category_code, target_count] = quota_part.split(": ");
      return [category_code, Number(target_count)];
    })
  );
  const picked_candidates = candidate_papers.filter((candidate) => {
    if ((remaining_target_by_category[candidate.quota_category] ?? 0) === 0) return false;
    remaining_target_by_category[candidate.quota_category] -= 1;
    return true;
  });
  return JSON.stringify({
    selected_papers: picked_candidates.map((candidate) => ({
      arxiv_id: candidate.arxiv_id,
      selection_reason: `reason for ${candidate.arxiv_id}`,
    })),
  });
};

const in_memory_pipeline_dependencies = ({
  existing_daily_selection = null,
  marked_papers_by_arxiv_id = {},
  papers_by_category = { "cs.LG": [feed_paper("2607.00001", "cs.LG"), feed_paper("2607.00002", "cs.LG")] },
  papers_per_category_per_day = undefined,
  request_pick,
} = {}) => {
  const call_log = { fetched_categories: [], pick_prompts: [], progress_messages: [], written_daily_selections: [] };
  return {
    call_log,
    dependencies: {
      current_date_iso: "2026-07-15",
      force_regeneration: false,
      settings: {
        tracked_arxiv_category_codes: Object.keys(papers_by_category),
        interests_blurb_text: "robots",
        reading_intent_blurb_text: "stay current",
        papers_per_category_per_day,
      },
      read_daily_selection: () => existing_daily_selection,
      write_daily_selection: (daily_selection) => call_log.written_daily_selections.push(daily_selection),
      read_mark_history: () => marked_papers_by_arxiv_id,
      fetch_papers_for_category: async (category_code) => {
        call_log.fetched_categories.push(category_code);
        const papers = papers_by_category[category_code];
        if (!papers) throw new Error(`feed down for ${category_code}`);
        return { announcement_date_iso: "2026-07-14", papers };
      },
      request_pick: async (prompt_text) => {
        call_log.pick_prompts.push(prompt_text);
        return (request_pick ?? quota_honoring_request_pick)(prompt_text);
      },
      report_progress: (progress_message) => call_log.progress_messages.push(progress_message),
    },
  };
};

test("a selection frozen for today is returned without any fetching", async () => {
  const frozen_daily_selection = { selection_date_iso: "2026-07-15", selected_papers: [], mark_by_arxiv_id: {} };
  const { call_log, dependencies } = in_memory_pipeline_dependencies({ existing_daily_selection: frozen_daily_selection });
  const { daily_selection } = await daily_paper_selection_for_date(dependencies);
  assert.equal(daily_selection, frozen_daily_selection);
  assert.deepEqual(call_log.fetched_categories, []);
});

test("cold start selects without local scores and freezes reasons", async () => {
  const { call_log, dependencies } = in_memory_pipeline_dependencies();
  const { daily_selection, warnings } = await daily_paper_selection_for_date(dependencies);
  assert.equal(daily_selection.selection_date_iso, "2026-07-15");
  assert.equal(daily_selection.arxiv_announcement_date_iso, "2026-07-14");
  assert.equal(daily_selection.selected_papers.length, 2);
  assert.match(daily_selection.selected_papers[0].language_model_selection_reason, /reason for/);
  assert.deepEqual(warnings, []);
  assert.deepEqual(call_log.written_daily_selections, [daily_selection]);
});

test("the per-category quota caps how many papers each category contributes", async () => {
  const { dependencies } = in_memory_pipeline_dependencies({
    papers_by_category: {
      "cs.LG": Array.from({ length: 6 }, (_unused, paper_index) => feed_paper(`2607.1000${paper_index}`, "cs.LG")),
      "cs.RO": [feed_paper("2607.20000", "cs.RO")],
    },
    papers_per_category_per_day: 2,
  });
  const { daily_selection } = await daily_paper_selection_for_date(dependencies);
  const selected_counts = {};
  for (const selected_paper of daily_selection.selected_papers) {
    selected_counts[selected_paper.source_feed_category_code] =
      (selected_counts[selected_paper.source_feed_category_code] ?? 0) + 1;
  }
  assert.deepEqual(selected_counts, { "cs.LG": 2, "cs.RO": 1 });
});

test("model considers at most twice each category quota", async () => {
  const { call_log, dependencies } = in_memory_pipeline_dependencies({
    papers_by_category: {
      "cs.LG": Array.from({ length: 25 }, (_unused, paper_index) => feed_paper(`2607.500${paper_index}`, "cs.LG")),
    },
    papers_per_category_per_day: 10,
  });
  await daily_paper_selection_for_date(dependencies);
  const prompt_candidates = call_log.pick_prompts[0]
    .split("\n")
    .filter((prompt_line) => prompt_line.startsWith('{"arxiv_id"'));
  assert.equal(prompt_candidates.length, 20);
});

test("crossed-out papers are excluded from candidates", async () => {
  const { dependencies } = in_memory_pipeline_dependencies({
    marked_papers_by_arxiv_id: {
      "2607.00001": { arxiv_id: "2607.00001", title: "T", abstract_text: "A", mark_kind: "crossed_out", marked_at_iso: "2026-07-14T00:00:00.000Z" },
    },
  });
  const { daily_selection } = await daily_paper_selection_for_date(dependencies);
  assert.deepEqual(daily_selection.selected_papers.map((selected_paper) => selected_paper.arxiv_id), ["2607.00002"]);
});

test("completed marks do not affect the candidate pool", async () => {
  const { dependencies } = in_memory_pipeline_dependencies({
    papers_by_category: { "cs.RO": [feed_paper("2607.00010", "cs.RO"), feed_paper("2607.00011", "cs.RO")] },
    marked_papers_by_arxiv_id: {
      "2607.00010": { arxiv_id: "2607.00010", title: "old mark", abstract_text: "old mark", mark_kind: "completed", marked_at_iso: "2026-07-01T00:00:00.000Z" },
    },
  });
  const { daily_selection } = await daily_paper_selection_for_date(dependencies);
  assert.deepEqual(daily_selection.selected_papers.map((selected_paper) => selected_paper.arxiv_id), ["2607.00010", "2607.00011"]);
});

test("a failing feed degrades to a warning while others proceed", async () => {
  const { dependencies } = in_memory_pipeline_dependencies({
    papers_by_category: { "cs.LG": [feed_paper("2607.00001", "cs.LG")], "cs.XX": undefined },
  });
  const { daily_selection, warnings } = await daily_paper_selection_for_date(dependencies);
  assert.equal(daily_selection.selected_papers.length, 1);
  assert.match(warnings[0], /cs\.XX: feed down/);
});

test("an invalid model response is retried once then falls back to local ranking", async () => {
  const { call_log, dependencies } = in_memory_pipeline_dependencies({ request_pick: async () => "not json at all" });
  const { daily_selection, warnings } = await daily_paper_selection_for_date(dependencies);
  assert.equal(call_log.pick_prompts.length, 2);
  assert.equal(daily_selection.selected_papers.length, 2);
  assert.match(daily_selection.selected_papers[0].language_model_selection_reason, /model unavailable/);
  assert.match(warnings[0], /model pick failed/);
});

test("a model response missing one category slot is completed in recency order", async () => {
  const { call_log, dependencies } = in_memory_pipeline_dependencies({
    request_pick: async (prompt_text) => {
      const first_candidate = prompt_text
        .split("\n")
        .find((prompt_line) => prompt_line.startsWith('{"arxiv_id"'));
      return JSON.stringify({
        selected_papers: [{ arxiv_id: JSON.parse(first_candidate).arxiv_id, selection_reason: "the model's first pick" }],
      });
    },
  });
  const { daily_selection, warnings } = await daily_paper_selection_for_date(dependencies);
  assert.equal(call_log.pick_prompts.length, 1);
  assert.equal(daily_selection.selected_papers.length, 2);
  assert.match(daily_selection.selected_papers[1].language_model_selection_reason, /complete the category quota/);
  assert.deepEqual(warnings, []);
});

test("category model requests launch together and report readiness independently", async () => {
  let release_slow_category;
  let report_both_categories_started;
  const both_categories_started = new Promise((resolve) => {
    report_both_categories_started = resolve;
  });
  const started_category_codes = [];
  const { call_log, dependencies } = in_memory_pipeline_dependencies({
    papers_by_category: {
      "cs.LG": [feed_paper("2607.30001", "cs.LG"), feed_paper("2607.30002", "cs.LG")],
      "cs.RO": [feed_paper("2607.40001", "cs.RO"), feed_paper("2607.40002", "cs.RO")],
    },
    request_pick: (prompt_text) => {
      const category_code = prompt_text.match(/Tracked arXiv categories: ([^\n]+)/)[1];
      started_category_codes.push(category_code);
      if (started_category_codes.length === 2) report_both_categories_started();
      if (category_code === "cs.LG") {
        return new Promise((resolve) => {
          release_slow_category = () => quota_honoring_request_pick(prompt_text).then(resolve);
        });
      }
      return quota_honoring_request_pick(prompt_text);
    },
  });

  const selection_promise = daily_paper_selection_for_date(dependencies);
  await both_categories_started;
  assert.deepEqual(started_category_codes, ["cs.LG", "cs.RO"]);
  assert.match(call_log.pick_prompts[0], /Tracked arXiv categories: cs\.LG/);
  assert.doesNotMatch(call_log.pick_prompts[0], /cs\.RO/);
  assert.match(call_log.pick_prompts[1], /Tracked arXiv categories: cs\.RO/);
  assert.doesNotMatch(call_log.pick_prompts[1], /cs\.LG/);

  release_slow_category();
  const { daily_selection } = await selection_promise;
  assert.equal(daily_selection.selected_papers.length, 4);
  assert.match(call_log.progress_messages.join("\n"), /cs\.RO ready \(1\/2\)/);
  assert.match(call_log.progress_messages.join("\n"), /cs\.LG ready \(2\/2\)/);
});

test("cross-listed papers merge their category codes across feeds", () => {
  const merged_papers = merged_papers_across_feeds([
    { papers: [feed_paper("2607.00001", "cs.LG")] },
    { papers: [{ ...feed_paper("2607.00001", "cs.RO"), arxiv_category_codes: ["cs.RO", "cs.LG"] }] },
  ]);
  assert.equal(merged_papers.length, 1);
  assert.deepEqual(merged_papers[0].arxiv_category_codes, ["cs.LG", "cs.RO"]);
});

test("force regeneration excludes papers already frozen for the day", async () => {
  const existing_daily_selection = {
    selection_date_iso: "2026-07-15",
    selected_papers: [feed_paper("2607.00001", "cs.LG")],
    mark_by_arxiv_id: { "2607.00001": "completed", "2607.77777": "crossed_out" },
  };
  const { dependencies } = in_memory_pipeline_dependencies({ existing_daily_selection });
  const { daily_selection } = await daily_paper_selection_for_date({ ...dependencies, force_regeneration: true });
  assert.deepEqual(daily_selection.selected_papers.map((selected_paper) => selected_paper.arxiv_id), ["2607.00002"]);
  assert.deepEqual(daily_selection.mark_by_arxiv_id, {});
});

test("papers per category sanitizes to a positive whole number with a default of ten", () => {
  assert.equal(sanitized_papers_per_category_per_day(undefined), 10);
  assert.equal(sanitized_papers_per_category_per_day("nonsense"), 10);
  assert.equal(sanitized_papers_per_category_per_day(0), 10);
  assert.equal(sanitized_papers_per_category_per_day("5"), 5);
  assert.equal(sanitized_papers_per_category_per_day(2), 2);
});

test("selection targets never exceed the available candidates per category", () => {
  const pruned_papers = [
    { arxiv_id: "a", source_feed_category_code: "cs.LG" },
    { arxiv_id: "b", source_feed_category_code: "cs.LG" },
    { arxiv_id: "c", source_feed_category_code: "cs.RO" },
  ];
  assert.deepEqual(selection_targets_for_candidates({ pruned_papers, papers_per_category_per_day: 3 }), {
    "cs.LG": 2,
    "cs.RO": 1,
  });
});

test("candidate pool keeps the earliest first-seen date while refreshing paper metadata", () => {
  const merged_candidate_papers_by_arxiv_id = candidate_pool_after_merging_fetched_papers({
    existing_candidate_papers_by_arxiv_id: {
      "2607.00001": { ...feed_paper("2607.00001", "cs.LG"), title: "Older title", first_seen_date_iso: "2026-07-01" },
    },
    fetched_candidate_papers: [{ ...feed_paper("2607.00001", "cs.LG"), title: "Corrected title" }],
    current_date_iso: "2026-07-15",
  });
  assert.equal(merged_candidate_papers_by_arxiv_id["2607.00001"].title, "Corrected title");
  assert.equal(merged_candidate_papers_by_arxiv_id["2607.00001"].first_seen_date_iso, "2026-07-01");
});

test("model prompt receives paper age and an explicit newer-paper preference", async () => {
  const { call_log, dependencies } = in_memory_pipeline_dependencies();
  await daily_paper_selection_for_date(dependencies);
  assert.match(call_log.pick_prompts[0], /"age_in_days":0/);
  assert.match(call_log.pick_prompts[0], /Prefer newer papers/);
});
