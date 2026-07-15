import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { default_settings, open_paperman_home_files, pruned_candidate_pool, pruned_mark_history } from "../source/paperman_home_files.mjs";

const with_scratch_home_files = (run_with_home_files) => {
  const scratch_home_directory_path = mkdtempSync(join(tmpdir(), "paperman-test-"));
  try {
    run_with_home_files(open_paperman_home_files(scratch_home_directory_path));
  } finally {
    rmSync(scratch_home_directory_path, { recursive: true, force: true });
  }
};

test("settings read falls back to defaults and merges saved changes", () => {
  with_scratch_home_files((home_files) => {
    assert.deepEqual(home_files.read_settings(), default_settings);
    home_files.write_settings({ interests_blurb_text: "world models" });
    const settings = home_files.read_settings();
    assert.equal(settings.interests_blurb_text, "world models");
    assert.deepEqual(settings.tracked_arxiv_category_codes, default_settings.tracked_arxiv_category_codes);
  });
});

test("daily selection round-trips and is null before the first write", () => {
  with_scratch_home_files((home_files) => {
    assert.equal(home_files.read_daily_selection(), null);
    const daily_selection = {
      selection_date_iso: "2026-07-15",
      arxiv_announcement_date_iso: "2026-07-14",
      selected_papers: [{ arxiv_id: "2607.00001", title: "A Paper" }],
      mark_by_arxiv_id: { "2607.00001": "completed" },
    };
    home_files.write_daily_selection(daily_selection);
    assert.deepEqual(home_files.read_daily_selection(), daily_selection);
  });
});

test("marks upsert and remove from history", () => {
  with_scratch_home_files((home_files) => {
    const marked_paper = {
      arxiv_id: "2607.00001",
      title: "A Paper",
      abstract_text: "An abstract",
      primary_arxiv_category_code: "cs.LG",
      mark_kind: "completed",
      marked_at_iso: "2026-07-15T09:00:00.000Z",
    };
    home_files.upsert_mark(marked_paper);
    assert.deepEqual(home_files.read_mark_history()["2607.00001"], marked_paper);
    home_files.upsert_mark({ ...marked_paper, mark_kind: "crossed_out" });
    assert.equal(home_files.read_mark_history()["2607.00001"].mark_kind, "crossed_out");
    home_files.remove_mark("2607.00001");
    assert.deepEqual(home_files.read_mark_history(), {});
  });
});

test("pruning caps history at 1000 marks", () => {
  const synthetic_marked_papers = Object.fromEntries(
    Array.from({ length: 1200 }, (_unused, mark_index) => [
      `2607.${String(mark_index).padStart(5, "0")}`,
      {
        arxiv_id: `2607.${String(mark_index).padStart(5, "0")}`,
        mark_kind: "completed",
        marked_at_iso: new Date(Date.UTC(2026, 0, 1) + mark_index * 60_000).toISOString(),
      },
    ])
  );
  const pruned_marked_papers = Object.values(pruned_mark_history(synthetic_marked_papers));
  assert.equal(pruned_marked_papers.length, 1000);
  const newest_mark = pruned_marked_papers.find((marked_paper) => marked_paper.arxiv_id === "2607.01199");
  assert.equal(newest_mark.mark_kind, "completed");
});

test("candidate pool drops papers older than twenty-one days", () => {
  const pruned_candidate_papers_by_arxiv_id = pruned_candidate_pool({
    recent: { arxiv_id: "recent", first_seen_date_iso: "2026-07-01" },
    stale: { arxiv_id: "stale", first_seen_date_iso: "2026-06-23" },
  }, "2026-07-15");
  assert.deepEqual(Object.keys(pruned_candidate_papers_by_arxiv_id), ["recent"]);
});
