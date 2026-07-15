import assert from "node:assert/strict";
import { test } from "node:test";
import { build_daily_pick_prompt, validate_daily_pick_response } from "../source/fireworks_api.mjs";

const candidate_paper = (arxiv_id) => ({
  arxiv_id,
  title: `Title ${arxiv_id}`,
  abstract_text: `Abstract ${arxiv_id}`,
  arxiv_category_codes: ["cs.LG"],
});

test("prompt carries categories, blurbs, candidates and the required count", () => {
  const prompt_text = build_daily_pick_prompt({
    tracked_arxiv_category_codes: ["cs.LG", "cs.RO"],
    interests_blurb_text: "world models",
    reading_intent_blurb_text: "write a blog post weekly",
    candidate_papers: [candidate_paper("2607.00001")],
    candidate_relevance_scores: [0.7315],
    number_of_papers_to_select: 10,
  });
  assert.match(prompt_text, /cs\.LG, cs\.RO/);
  assert.match(prompt_text, /world models/);
  assert.match(prompt_text, /write a blog post weekly/);
  assert.match(prompt_text, /"arxiv_id":"2607\.00001"/);
  assert.match(prompt_text, /0\.732/);
  assert.match(prompt_text, /Select exactly 10 distinct papers/);
});

test("prompt marks missing blurbs and cold-start scores", () => {
  const prompt_text = build_daily_pick_prompt({
    tracked_arxiv_category_codes: ["cs.LG"],
    interests_blurb_text: "",
    reading_intent_blurb_text: "",
    candidate_papers: [candidate_paper("2607.00001")],
    candidate_relevance_scores: null,
    number_of_papers_to_select: 1,
  });
  assert.match(prompt_text, /Their interests: \(not provided\)/);
  assert.match(prompt_text, /"local_relevance_score":null/);
});

const valid_response_text = JSON.stringify({
  selected_papers: [
    { arxiv_id: "2607.00001", selection_reason: "matches the stated goal" },
    { arxiv_id: "2607.00002", selection_reason: "strong local score" },
  ],
});

test("validator accepts a well-formed response", () => {
  const validated_picks = validate_daily_pick_response({
    response_text: valid_response_text,
    candidate_arxiv_ids: ["2607.00001", "2607.00002", "2607.00003"],
    number_of_papers_to_select: 2,
  });
  assert.deepEqual(validated_picks.map((validated_pick) => validated_pick.arxiv_id), ["2607.00001", "2607.00002"]);
});

test("validator rejects malformed and dishonest responses", () => {
  const validation_arguments = { candidate_arxiv_ids: ["2607.00001", "2607.00002"], number_of_papers_to_select: 2 };
  assert.throws(() => validate_daily_pick_response({ ...validation_arguments, response_text: "not json" }), /not valid JSON/);
  assert.throws(() => validate_daily_pick_response({ ...validation_arguments, response_text: '{"other": []}' }), /no selected_papers/);
  assert.throws(
    () =>
      validate_daily_pick_response({
        ...validation_arguments,
        response_text: JSON.stringify({ selected_papers: [{ arxiv_id: "2607.00001", selection_reason: "only one" }] }),
      }),
    /returned 1 papers, expected 2/
  );
  assert.throws(
    () =>
      validate_daily_pick_response({
        ...validation_arguments,
        response_text: JSON.stringify({
          selected_papers: [
            { arxiv_id: "9999.99999", selection_reason: "made up" },
            { arxiv_id: "2607.00002", selection_reason: "real" },
          ],
        }),
      }),
    /invented arxiv_id/
  );
  assert.throws(
    () =>
      validate_daily_pick_response({
        ...validation_arguments,
        response_text: JSON.stringify({
          selected_papers: [
            { arxiv_id: "2607.00001", selection_reason: "twice" },
            { arxiv_id: "2607.00001", selection_reason: "twice" },
          ],
        }),
      }),
    /twice/
  );
  assert.throws(
    () =>
      validate_daily_pick_response({
        ...validation_arguments,
        response_text: JSON.stringify({
          selected_papers: [
            { arxiv_id: "2607.00001", selection_reason: "" },
            { arxiv_id: "2607.00002", selection_reason: "fine" },
          ],
        }),
      }),
    /no selection_reason/
  );
});
