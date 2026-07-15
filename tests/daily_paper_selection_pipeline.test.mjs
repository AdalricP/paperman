import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
  const call_log = { fetched_categories: [], embedded_text_batches: [], pick_prompts: [], written_daily_selections: [] };
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
      embed_texts: async (paper_texts) => {
        call_log.embedded_text_batches.push(paper_texts);
        return paper_texts.map((paper_text) => (paper_text.includes("robot") ? [1, 0] : [0, 1]));
      },
      request_pick: async (prompt_text) => {
        call_log.pick_prompts.push(prompt_text);
        return (request_pick ?? quota_honoring_request_pick)(prompt_text);
      },
      report_progress: () => {},
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

test("cold start selects without local scores and freezes embeddings and reasons", async () => {
  const { call_log, dependencies } = in_memory_pipeline_dependencies();
  const { daily_selection, warnings } = await daily_paper_selection_for_date(dependencies);
  assert.equal(daily_selection.selection_date_iso, "2026-07-15");
  assert.equal(daily_selection.arxiv_announcement_date_iso, "2026-07-14");
  assert.equal(daily_selection.selected_papers.length, 2);
  assert.equal(daily_selection.selected_papers[0].local_relevance_score, null);
  assert.match(daily_selection.selected_papers[0].language_model_selection_reason, /reason for/);
  assert.ok(daily_selection.selected_papers[0].abstract_embedding_vector);
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

test("marked papers are excluded from candidates", async () => {
  const { dependencies } = in_memory_pipeline_dependencies({
    marked_papers_by_arxiv_id: {
      "2607.00001": { arxiv_id: "2607.00001", title: "T", abstract_text: "A", mark_kind: "completed", marked_at_iso: "2026-07-14T00:00:00.000Z", abstract_embedding_vector: null },
    },
  });
  const { daily_selection } = await daily_paper_selection_for_date(dependencies);
  assert.deepEqual(daily_selection.selected_papers.map((selected_paper) => selected_paper.arxiv_id), ["2607.00002"]);
});

test("history with embeddings produces local scores that favor similar papers", async () => {
  const { dependencies } = in_memory_pipeline_dependencies({
    papers_by_category: { "cs.RO": [feed_paper("2607.00010", "cs.RO"), { ...feed_paper("2607.00011", "cs.RO"), abstract_text: "robot grasping study" }] },
    marked_papers_by_arxiv_id: {
      "2607.99999": { arxiv_id: "2607.99999", title: "robot paper", abstract_text: "robot learning", mark_kind: "completed", marked_at_iso: "2026-07-01T00:00:00.000Z", abstract_embedding_vector: [1, 0] },
    },
  });
  const { daily_selection } = await daily_paper_selection_for_date(dependencies);
  const score_by_arxiv_id = new Map(
    daily_selection.selected_papers.map((selected_paper) => [selected_paper.arxiv_id, selected_paper.local_relevance_score])
  );
  assert.ok(score_by_arxiv_id.get("2607.00011") > score_by_arxiv_id.get("2607.00010"));
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

test("cross-listed papers merge their category codes across feeds", () => {
  const merged_papers = merged_papers_across_feeds([
    { papers: [feed_paper("2607.00001", "cs.LG")] },
    { papers: [{ ...feed_paper("2607.00001", "cs.RO"), arxiv_category_codes: ["cs.RO", "cs.LG"] }] },
  ]);
  assert.equal(merged_papers.length, 1);
  assert.deepEqual(merged_papers[0].arxiv_category_codes, ["cs.LG", "cs.RO"]);
});

test("force regeneration on the same day carries over marks for surviving papers", async () => {
  const existing_daily_selection = {
    selection_date_iso: "2026-07-15",
    selected_papers: [feed_paper("2607.00001", "cs.LG")],
    mark_by_arxiv_id: { "2607.00001": "completed", "2607.77777": "crossed_out" },
  };
  const { dependencies } = in_memory_pipeline_dependencies({ existing_daily_selection });
  const { daily_selection } = await daily_paper_selection_for_date({ ...dependencies, force_regeneration: true });
  assert.deepEqual(daily_selection.mark_by_arxiv_id, { "2607.00001": "completed" });
});

test("papers per category sanitizes to a positive whole number with a default of three", () => {
  assert.equal(sanitized_papers_per_category_per_day(undefined), 3);
  assert.equal(sanitized_papers_per_category_per_day("nonsense"), 3);
  assert.equal(sanitized_papers_per_category_per_day(0), 3);
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
