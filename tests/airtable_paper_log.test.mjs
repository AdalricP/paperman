import assert from "node:assert/strict";
import { test } from "node:test";
import { airtable_base_id_from_input, append_crossed_paper_to_airtable } from "../source/airtable_paper_log.mjs";

const paper = {
  arxiv_id: "2607.00001",
  title: "A paper",
  source_feed_category_code: "math-ph",
  primary_arxiv_category_code: "math-ph",
  arxiv_abstract_url: "https://arxiv.org/abs/2607.00001",
  language_model_selection_reason: "useful today",
  abstract_text: "An abstract",
};

const airtable_token = "pat_example";
const airtable_base_id = "appExample123";
const crossed_at_iso = "2026-07-16T00:00:00.000Z";

test("reads an Airtable base ID from an ID or base URL", () => {
  assert.equal(airtable_base_id_from_input(airtable_base_id), airtable_base_id);
  assert.equal(airtable_base_id_from_input(`https://airtable.com/${airtable_base_id}/shrxample`), airtable_base_id);
  assert.equal(airtable_base_id_from_input("not a base"), "");
});

test("an incomplete Airtable connection leaves the local read mark alone", async () => {
  assert.equal(await append_crossed_paper_to_airtable({ airtable_personal_access_token: "", airtable_base_input: airtable_base_id, paper, crossed_at_iso }), false);
  assert.equal(await append_crossed_paper_to_airtable({ airtable_personal_access_token: airtable_token, airtable_base_input: "", paper, crossed_at_iso }), false);
});

test("crossed papers are added to the configured Airtable Papers table", async () => {
  const original_fetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (requested_url, options) => {
    requests.push({ requested_url, options });
    return { ok: true };
  };
  try {
    assert.equal(await append_crossed_paper_to_airtable({ airtable_personal_access_token: airtable_token, airtable_base_input: `https://airtable.com/${airtable_base_id}`, paper, crossed_at_iso }), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].requested_url, `https://api.airtable.com/v0/${airtable_base_id}/Papers`);
    assert.equal(requests[0].options.headers.Authorization, `Bearer ${airtable_token}`);
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      fields: {
        Title: paper.title,
        "Crossed at": crossed_at_iso,
        "arXiv ID": paper.arxiv_id,
        "Source category": paper.source_feed_category_code,
        "Primary category": paper.primary_arxiv_category_code,
        "arXiv URL": paper.arxiv_abstract_url,
        "Selection reason": paper.language_model_selection_reason,
        Abstract: paper.abstract_text,
      },
    });
  } finally {
    globalThis.fetch = original_fetch;
  }
});

test("the first crossed paper creates a missing Airtable Papers table", async () => {
  const original_fetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (requested_url, options) => {
    requests.push({ requested_url, options });
    if (requests.length === 1) return { ok: false, status: 404, text: async () => JSON.stringify({ error: { type: "MODEL_NOT_FOUND", message: "Could not find table" } }) };
    return { ok: true };
  };
  try {
    assert.equal(await append_crossed_paper_to_airtable({ airtable_personal_access_token: airtable_token, airtable_base_input: airtable_base_id, paper, crossed_at_iso }), true);
    assert.equal(requests.length, 3);
    assert.equal(requests[1].requested_url, `https://api.airtable.com/v0/meta/bases/${airtable_base_id}/tables`);
    assert.deepEqual(JSON.parse(requests[1].options.body).name, "Papers");
    assert.equal(requests[2].requested_url, `https://api.airtable.com/v0/${airtable_base_id}/Papers`);
  } finally {
    globalThis.fetch = original_fetch;
  }
});
