import assert from "node:assert/strict";
import { test } from "node:test";
import { append_crossed_paper_to_google_sheet } from "../source/google_sheets_webhook.mjs";

const paper = {
  arxiv_id: "2607.00001",
  title: "A paper",
  source_feed_category_code: "math-ph",
  primary_arxiv_category_code: "math-ph",
  arxiv_abstract_url: "https://arxiv.org/abs/2607.00001",
  language_model_selection_reason: "useful today",
  abstract_text: "An abstract",
};

test("crossed papers are appended to the configured Google Sheet webhook", async () => {
  const original_fetch = globalThis.fetch;
  let endpoint_url;
  let request_options;
  globalThis.fetch = async (requested_url, options) => {
    endpoint_url = requested_url;
    request_options = options;
    return { ok: true };
  };
  try {
    const was_appended = await append_crossed_paper_to_google_sheet({
      google_sheets_webhook_url: "https://script.google.com/macros/s/example/exec",
      paper,
      crossed_at_iso: "2026-07-16T00:00:00.000Z",
    });
    assert.equal(was_appended, true);
    assert.equal(endpoint_url, "https://script.google.com/macros/s/example/exec");
    assert.deepEqual(JSON.parse(request_options.body), {
      crossed_at_iso: "2026-07-16T00:00:00.000Z",
      arxiv_id: paper.arxiv_id,
      title: paper.title,
      source_category: paper.source_feed_category_code,
      primary_category: paper.primary_arxiv_category_code,
      arxiv_url: paper.arxiv_abstract_url,
      selection_reason: paper.language_model_selection_reason,
      abstract: paper.abstract_text,
    });
  } finally {
    globalThis.fetch = original_fetch;
  }
});

test("an empty Google Sheet webhook leaves the local read mark alone", async () => {
  assert.equal(await append_crossed_paper_to_google_sheet({ google_sheets_webhook_url: "", paper, crossed_at_iso: "2026-07-16T00:00:00.000Z" }), false);
});
