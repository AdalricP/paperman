const airtable_api_url = "https://api.airtable.com/v0";
const airtable_papers_table_name = "Papers";

const paper_table_fields = [
  { name: "Title", type: "singleLineText" },
  { name: "Crossed at", type: "singleLineText" },
  { name: "arXiv ID", type: "singleLineText" },
  { name: "Source category", type: "singleLineText" },
  { name: "Primary category", type: "singleLineText" },
  { name: "arXiv URL", type: "singleLineText" },
  { name: "Selection reason", type: "multilineText" },
  { name: "Abstract", type: "multilineText" },
];

export function airtable_base_id_from_input(airtable_base_input) {
  const matched_base_id = String(airtable_base_input ?? "").trim().match(/app[A-Za-z0-9]+/);
  return matched_base_id?.[0] ?? "";
}

function response_error_details(response_text) {
  try {
    const parsed_error_body = JSON.parse(response_text);
    const error = parsed_error_body.error ?? {};
    return {
      error_type: String(error.type ?? ""),
      message: String(error.message ?? error.type ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    };
  } catch {
    return { error_type: "", message: response_text.replace(/\s+/g, " ").trim().slice(0, 300) };
  }
}

async function require_successful_response(response, action_description) {
  if (response.ok) return;
  const { message } = response_error_details(await response.text());
  throw new Error(`${action_description} (HTTP ${response.status})${message ? `: ${message}` : ""}`);
}

function airtable_request_options(airtable_personal_access_token, request_body) {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${airtable_personal_access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request_body),
  };
}

function paper_record_fields(paper, crossed_at_iso) {
  return {
    Title: paper.title,
    "Crossed at": crossed_at_iso,
    "arXiv ID": paper.arxiv_id,
    "Source category": paper.source_feed_category_code ?? "",
    "Primary category": paper.primary_arxiv_category_code ?? "",
    "arXiv URL": paper.arxiv_abstract_url ?? "",
    "Selection reason": paper.language_model_selection_reason ?? "",
    Abstract: paper.abstract_text ?? "",
  };
}

function records_endpoint_url(airtable_base_id) {
  return `${airtable_api_url}/${encodeURIComponent(airtable_base_id)}/${encodeURIComponent(airtable_papers_table_name)}`;
}

async function create_papers_table({ airtable_personal_access_token, airtable_base_id }) {
  let create_table_response;
  try {
    create_table_response = await fetch(`${airtable_api_url}/meta/bases/${encodeURIComponent(airtable_base_id)}/tables`, airtable_request_options(airtable_personal_access_token, {
      name: airtable_papers_table_name,
      fields: paper_table_fields,
    }));
  } catch (request_error) {
    throw new Error(`Airtable request failed: ${request_error.message}`);
  }
  await require_successful_response(create_table_response, "could not create Airtable Papers table");
}

async function create_paper_record({ airtable_personal_access_token, airtable_base_id, paper, crossed_at_iso }) {
  let create_record_response;
  try {
    create_record_response = await fetch(records_endpoint_url(airtable_base_id), airtable_request_options(airtable_personal_access_token, {
      fields: paper_record_fields(paper, crossed_at_iso),
    }));
  } catch (request_error) {
    throw new Error(`Airtable request failed: ${request_error.message}`);
  }
  if (create_record_response.ok) return { was_created: true, table_was_missing: false };
  const error_details = response_error_details(await create_record_response.text());
  if (error_details.error_type === "MODEL_NOT_FOUND") return { was_created: false, table_was_missing: true };
  throw new Error(`could not add paper to Airtable (HTTP ${create_record_response.status})${error_details.message ? `: ${error_details.message}` : ""}`);
}

export async function append_crossed_paper_to_airtable({ airtable_personal_access_token, airtable_base_input, paper, crossed_at_iso }) {
  const airtable_base_id = airtable_base_id_from_input(airtable_base_input);
  if (!airtable_personal_access_token || !airtable_base_id) return false;

  const first_create_attempt = await create_paper_record({ airtable_personal_access_token, airtable_base_id, paper, crossed_at_iso });
  if (first_create_attempt.was_created) return true;

  await create_papers_table({ airtable_personal_access_token, airtable_base_id });
  const second_create_attempt = await create_paper_record({ airtable_personal_access_token, airtable_base_id, paper, crossed_at_iso });
  if (second_create_attempt.was_created) return true;
  throw new Error("Airtable Papers table was not available after creating it");
}
