import assert from "node:assert/strict";
import { test } from "node:test";
import {
  build_daily_pick_prompt,
  request_daily_pick,
  total_selection_target,
  validate_daily_pick_response,
} from "../source/model_provider_api.mjs";

const candidate_paper = (arxiv_id, source_feed_category_code) => ({
  arxiv_id,
  title: `Title ${arxiv_id}`,
  abstract_text: `Abstract ${arxiv_id}`,
  arxiv_category_codes: [source_feed_category_code],
  source_feed_category_code,
  age_in_days: 0,
});

test("prompt carries categories, blurbs, candidates and per-category quotas", () => {
  const prompt_text = build_daily_pick_prompt({
    tracked_arxiv_category_codes: ["cs.LG", "cs.RO"],
    interests_blurb_text: "world models",
    reading_intent_blurb_text: "write a blog post weekly",
    candidate_papers: [candidate_paper("2607.00001", "cs.LG")],
    selection_target_by_category_code: { "cs.LG": 3, "cs.RO": 2 },
  });
  assert.match(prompt_text, /cs\.LG, cs\.RO/);
  assert.match(prompt_text, /world models/);
  assert.match(prompt_text, /write a blog post weekly/);
  assert.match(prompt_text, /"arxiv_id":"2607\.00001"/);
  assert.match(prompt_text, /"quota_category":"cs\.LG"/);
  assert.match(prompt_text, /"age_in_days":/);
  assert.match(prompt_text, /paper_contribution/);
  assert.match(prompt_text, /exactly these counts \(total 5\): cs\.LG: 3 · cs\.RO: 2/);
});

test("prompt marks missing blurbs without a feedback score", () => {
  const prompt_text = build_daily_pick_prompt({
    tracked_arxiv_category_codes: ["cs.LG"],
    interests_blurb_text: "",
    reading_intent_blurb_text: "",
    candidate_papers: [candidate_paper("2607.00001", "cs.LG")],
    selection_target_by_category_code: { "cs.LG": 1 },
  });
  assert.match(prompt_text, /Their interests: \(not provided\)/);
  assert.doesNotMatch(prompt_text, /local_relevance_score/);
});

test("prompt retains titles and shortens only long abstracts", () => {
  const full_title = "A complete title that must not be shortened";
  const prompt_text = build_daily_pick_prompt({
    tracked_arxiv_category_codes: ["cs.LG"],
    interests_blurb_text: "",
    reading_intent_blurb_text: "",
    candidate_papers: [{ ...candidate_paper("2607.00001", "cs.LG"), title: full_title, abstract_text: "a".repeat(351) }],
    selection_target_by_category_code: { "cs.LG": 1 },
  });
  const candidate_line = prompt_text.split("\n").find((prompt_line) => prompt_line.startsWith('{"arxiv_id"'));
  const prompt_candidate = JSON.parse(candidate_line);
  assert.equal(prompt_candidate.title, full_title);
  assert.equal(prompt_candidate.abstract.length, 350);
});

test("OpenRouter requests enable medium reasoning without returning it in JSON", async () => {
  const original_fetch = globalThis.fetch;
  let request_payload;
  let captured_request_options;
  globalThis.fetch = async (_endpoint_url, request_options) => {
    captured_request_options = request_options;
    request_payload = JSON.parse(request_options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"selected_papers":[]}' } }] }) };
  };
  try {
    const response_text = await request_daily_pick({
      openrouter_api_key: "test-key",
      openrouter_chat_model_id: "test-model",
      prompt_text: "test prompt",
    });
    assert.equal(response_text, '{"selected_papers":[]}');
    assert.deepEqual(request_payload.reasoning, { effort: "medium", exclude: true });
    assert.equal(captured_request_options.signal, undefined);
  } finally {
    globalThis.fetch = original_fetch;
  }
});

test("total selection target sums the per-category quotas", () => {
  assert.equal(total_selection_target({ "cs.LG": 3, "cs.RO": 2 }), 5);
});

const validation_arguments = {
  candidate_papers: [
    candidate_paper("2607.00001", "cs.LG"),
    candidate_paper("2607.00002", "cs.LG"),
    candidate_paper("2607.00003", "cs.RO"),
  ],
  selection_target_by_category_code: { "cs.LG": 2, "cs.RO": 1 },
};

const response_with = (selected_papers) => JSON.stringify({ selected_papers });

test("validator accepts a response that meets every category quota", () => {
  const validated_picks = validate_daily_pick_response({
    ...validation_arguments,
    response_text: response_with([
      { arxiv_id: "2607.00001", selection_reason: "matches the stated goal", paper_contribution: "introduces a practical control method" },
      { arxiv_id: "2607.00002", selection_reason: "strong local score", paper_contribution: "benchmarks transfer across systems" },
      { arxiv_id: "2607.00003", selection_reason: "solid robotics result", paper_contribution: "improves robot exploration safety" },
    ]),
  });
  assert.deepEqual(
    validated_picks.map((validated_pick) => validated_pick.arxiv_id),
    ["2607.00001", "2607.00002", "2607.00003"]
  );
  assert.equal(validated_picks[0].paper_contribution, "introduces a practical control method");
});

test("validator rejects malformed and dishonest responses", () => {
  assert.throws(
    () => validate_daily_pick_response({ ...validation_arguments, response_text: "not json" }),
    /not valid JSON/
  );
  assert.throws(
    () => validate_daily_pick_response({ ...validation_arguments, response_text: '{"other": []}' }),
    /no selected_papers/
  );
  assert.throws(
    () =>
      validate_daily_pick_response({
        ...validation_arguments,
        response_text: response_with([{ arxiv_id: "9999.99999", selection_reason: "made up" }]),
      }),
    /invented arxiv_id/
  );
  assert.throws(
    () =>
      validate_daily_pick_response({
        ...validation_arguments,
        response_text: response_with([
          { arxiv_id: "2607.00001", selection_reason: "twice" },
          { arxiv_id: "2607.00001", selection_reason: "twice" },
        ]),
      }),
    /twice/
  );
  assert.throws(
    () =>
      validate_daily_pick_response({
        ...validation_arguments,
        response_text: response_with([
          { arxiv_id: "2607.00001", selection_reason: "" },
          { arxiv_id: "2607.00002", selection_reason: "fine" },
        ]),
      }),
    /no selection_reason/
  );
});

test("validator rejects a response that misses a category quota", () => {
  assert.throws(
    () =>
      validate_daily_pick_response({
        ...validation_arguments,
        response_text: response_with([
          { arxiv_id: "2607.00001", selection_reason: "good" },
          { arxiv_id: "2607.00002", selection_reason: "good" },
        ]),
      }),
    /chose 0 papers for cs\.RO, expected 1/
  );
});
