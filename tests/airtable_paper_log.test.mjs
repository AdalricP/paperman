import assert from "node:assert/strict";
import { test } from "node:test";
import { airtable_base_id_from_input, append_crossed_paper_to_airtable, remove_crossed_paper_from_airtable } from "../source/airtable_paper_log.mjs";

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
  assert.equal(await append_crossed_paper_to_airtable({ airtable_personal_access_token: "", airtable_base_input: airtable_base_id, paper }), false);
  assert.equal(await append_crossed_paper_to_airtable({ airtable_personal_access_token: airtable_token, airtable_base_input: "", paper }), false);
});

test("crossed papers are added to the configured Airtable Reading Notes table", async () => {
  const original_fetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (requested_url, options) => {
    requests.push({ requested_url, options });
    return { ok: true, json: async () => ({ id: "recExample" }) };
  };
  try {
    assert.deepEqual(await append_crossed_paper_to_airtable({ airtable_personal_access_token: airtable_token, airtable_base_input: `https://airtable.com/${airtable_base_id}`, paper }), { airtable_base_id, airtable_record_id: "recExample" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].requested_url, `https://api.airtable.com/v0/${airtable_base_id}/Reading%20Notes`);
    assert.equal(requests[0].options.headers.Authorization, `Bearer ${airtable_token}`);
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      fields: {
        "Paper Name": paper.title,
        Link: "https://arxiv.org/pdf/2607.00001",
        "Useful?": false,
        "Robotics?": false,
        Artifact: null,
      },
    });
  } finally {
    globalThis.fetch = original_fetch;
  }
});

test("the first crossed paper creates a missing Airtable Reading Notes table", async () => {
  const original_fetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (requested_url, options) => {
    requests.push({ requested_url, options });
    if (requests.length === 1) return { ok: false, status: 403, text: async () => JSON.stringify({ error: { type: "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND", message: "Could not find table" } }) };
    if (requests.length === 2) return { ok: true, json: async () => ({ id: "tblPushes" }) };
    if (requests.length === 3) return { ok: true };
    return { ok: true, json: async () => ({ id: "recExample" }) };
  };
  try {
    assert.deepEqual(await append_crossed_paper_to_airtable({ airtable_personal_access_token: airtable_token, airtable_base_input: airtable_base_id, paper }), { airtable_base_id, airtable_record_id: "recExample" });
    assert.equal(requests.length, 4);
    assert.equal(requests[1].requested_url, `https://api.airtable.com/v0/meta/bases/${airtable_base_id}/tables`);
    assert.deepEqual(JSON.parse(requests[1].options.body).name, "Pushes");
    assert.deepEqual(JSON.parse(requests[2].options.body).name, "Reading Notes");
    const reading_notes_fields = JSON.parse(requests[2].options.body).fields;
    assert.deepEqual(reading_notes_fields.find((field) => field.name === "Useful?"), { name: "Useful?", type: "checkbox", options: { color: "greenBright", icon: "check" } });
    assert.deepEqual(reading_notes_fields.find((field) => field.name === "Key Push"), { name: "Key Push", type: "multipleRecordLinks", options: { linkedTableId: "tblPushes" } });
    assert.equal(requests[3].requested_url, `https://api.airtable.com/v0/${airtable_base_id}/Reading%20Notes`);
  } finally {
    globalThis.fetch = original_fetch;
  }
});

test("a partially created Pushes table is reused before Reading Notes is created", async () => {
  const original_fetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (requested_url, options) => {
    requests.push({ requested_url, options });
    if (requests.length === 1) return { ok: false, status: 403, text: async () => JSON.stringify({ error: { type: "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND", message: "Could not find table" } }) };
    if (requests.length === 2) return { ok: false, status: 422, text: async () => JSON.stringify({ error: { type: "DUPLICATE_TABLE_NAME", message: "Pushes already exists" } }) };
    if (requests.length === 3) return { ok: true, json: async () => ({ tables: [{ id: "tblExistingPushes", name: "Pushes" }] }) };
    if (requests.length === 4) return { ok: true };
    return { ok: true, json: async () => ({ id: "recExample" }) };
  };
  try {
    assert.deepEqual(await append_crossed_paper_to_airtable({ airtable_personal_access_token: airtable_token, airtable_base_input: airtable_base_id, paper }), { airtable_base_id, airtable_record_id: "recExample" });
    assert.equal(requests[2].options.method, "GET");
    assert.deepEqual(JSON.parse(requests[3].options.body).fields.find((field) => field.name === "Key Push"), { name: "Key Push", type: "multipleRecordLinks", options: { linkedTableId: "tblExistingPushes" } });
  } finally {
    globalThis.fetch = original_fetch;
  }
});

test("uncrossing removes the matching Airtable record", async () => {
  const original_fetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (requested_url, options) => {
    request = { requested_url, options };
    return { ok: true };
  };
  try {
    assert.equal(await remove_crossed_paper_from_airtable({
      airtable_personal_access_token: airtable_token,
      airtable_base_input: airtable_base_id,
      airtable_record_sync: { airtable_base_id, airtable_record_id: "recExample" },
    }), true);
    assert.equal(request.requested_url, `https://api.airtable.com/v0/${airtable_base_id}/Reading%20Notes/recExample`);
    assert.equal(request.options.method, "DELETE");
  } finally {
    globalThis.fetch = original_fetch;
  }
});
