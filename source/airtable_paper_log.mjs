const airtable_api_url = "https://api.airtable.com/v0";
const airtable_reading_notes_table_name = "Reading Notes";
const airtable_pushes_table_name = "Pushes";
const missing_model_error_types = new Set(["MODEL_NOT_FOUND", "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND"]);
const checkbox_field_options = { color: "greenBright", icon: "check" };

const pushes_table_fields = [
  { name: "Push", type: "singleLineText" },
  { name: "Notes", type: "multilineText" },
];

function reading_notes_table_fields(pushes_table_id) {
  return [
    { name: "Paper Name", type: "singleLineText" },
    { name: "Link", type: "url" },
    { name: "Useful?", type: "checkbox", options: checkbox_field_options },
    { name: "Robotics?", type: "checkbox", options: checkbox_field_options },
    { name: "Key Push", type: "multipleRecordLinks", options: { linkedTableId: pushes_table_id } },
    { name: "Artifact", type: "url" },
  ];
}

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

function airtable_request_options(airtable_personal_access_token, method, request_body) {
  return {
    method,
    headers: {
      Authorization: `Bearer ${airtable_personal_access_token}`,
      "Content-Type": "application/json",
    },
    ...(request_body ? { body: JSON.stringify(request_body) } : {}),
  };
}

function arxiv_pdf_url(paper) {
  if (paper.arxiv_abstract_url?.includes("/abs/")) return paper.arxiv_abstract_url.replace("/abs/", "/pdf/");
  return `https://arxiv.org/pdf/${paper.arxiv_id}`;
}

function paper_record_fields(paper) {
  return {
    "Paper Name": paper.title,
    Link: arxiv_pdf_url(paper),
    "Useful?": false,
    "Robotics?": false,
    Artifact: null,
  };
}

function records_endpoint_url(airtable_base_id, airtable_record_id = "") {
  const endpoint_segments = [airtable_api_url, encodeURIComponent(airtable_base_id), encodeURIComponent(airtable_reading_notes_table_name)];
  if (airtable_record_id) endpoint_segments.push(encodeURIComponent(airtable_record_id));
  return endpoint_segments.join("/");
}

async function create_pushes_table({ airtable_personal_access_token, airtable_base_id }) {
  let create_table_response;
  try {
    create_table_response = await fetch(`${airtable_api_url}/meta/bases/${encodeURIComponent(airtable_base_id)}/tables`, airtable_request_options(airtable_personal_access_token, "POST", {
      name: airtable_pushes_table_name,
      fields: pushes_table_fields,
    }));
  } catch (request_error) {
    throw new Error(`Airtable request failed: ${request_error.message}`);
  }
  if (create_table_response.ok) {
    const created_pushes_table = await create_table_response.json();
    if (!created_pushes_table.id) throw new Error("Airtable did not return the new Pushes table ID");
    return created_pushes_table.id;
  }
  return existing_pushes_table_id({ airtable_personal_access_token, airtable_base_id, create_table_error_details: response_error_details(await create_table_response.text()) });
}

async function existing_pushes_table_id({ airtable_personal_access_token, airtable_base_id, create_table_error_details }) {
  let base_schema_response;
  try {
    base_schema_response = await fetch(`${airtable_api_url}/meta/bases/${encodeURIComponent(airtable_base_id)}/tables`, airtable_request_options(airtable_personal_access_token, "GET"));
  } catch (request_error) {
    throw new Error(`Airtable request failed: ${request_error.message}`);
  }
  if (!base_schema_response.ok) {
    const { message } = response_error_details(await base_schema_response.text());
    throw new Error(`could not reuse Airtable Pushes table (HTTP ${base_schema_response.status})${message ? `: ${message}` : ""} · add schema.bases:read to your Airtable token`);
  }
  const base_schema = await base_schema_response.json();
  const existing_pushes_table = base_schema.tables?.find((table) => table.name === airtable_pushes_table_name);
  if (existing_pushes_table?.id) return existing_pushes_table.id;
  throw new Error(`could not create Airtable Pushes table${create_table_error_details.message ? `: ${create_table_error_details.message}` : ""}`);
}

async function create_reading_notes_table({ airtable_personal_access_token, airtable_base_id, pushes_table_id }) {
  let create_table_response;
  try {
    create_table_response = await fetch(`${airtable_api_url}/meta/bases/${encodeURIComponent(airtable_base_id)}/tables`, airtable_request_options(airtable_personal_access_token, "POST", {
      name: airtable_reading_notes_table_name,
      fields: reading_notes_table_fields(pushes_table_id),
    }));
  } catch (request_error) {
    throw new Error(`Airtable request failed: ${request_error.message}`);
  }
  await require_successful_response(create_table_response, "could not create Airtable Reading Notes table");
}

async function create_paper_record({ airtable_personal_access_token, airtable_base_id, paper }) {
  let create_record_response;
  try {
    create_record_response = await fetch(records_endpoint_url(airtable_base_id), airtable_request_options(airtable_personal_access_token, "POST", {
      fields: paper_record_fields(paper),
    }));
  } catch (request_error) {
    throw new Error(`Airtable request failed: ${request_error.message}`);
  }
  if (create_record_response.ok) {
    const created_record = await create_record_response.json();
    if (!created_record.id) throw new Error("Airtable did not return the new record ID");
    return { was_created: true, airtable_record_id: created_record.id };
  }
  const error_details = response_error_details(await create_record_response.text());
  if (missing_model_error_types.has(error_details.error_type)) return { was_created: false, airtable_record_id: "" };
  throw new Error(`could not add paper to Airtable (HTTP ${create_record_response.status})${error_details.message ? `: ${error_details.message}` : ""}`);
}

export async function append_crossed_paper_to_airtable({ airtable_personal_access_token, airtable_base_input, paper }) {
  const airtable_base_id = airtable_base_id_from_input(airtable_base_input);
  if (!airtable_personal_access_token || !airtable_base_id) return false;

  const first_create_attempt = await create_paper_record({ airtable_personal_access_token, airtable_base_id, paper });
  if (first_create_attempt.was_created) return { airtable_base_id, airtable_record_id: first_create_attempt.airtable_record_id };

  const pushes_table_id = await create_pushes_table({ airtable_personal_access_token, airtable_base_id });
  await create_reading_notes_table({ airtable_personal_access_token, airtable_base_id, pushes_table_id });
  const second_create_attempt = await create_paper_record({ airtable_personal_access_token, airtable_base_id, paper });
  if (second_create_attempt.was_created) return { airtable_base_id, airtable_record_id: second_create_attempt.airtable_record_id };
  throw new Error("Airtable Reading Notes table was not available after creating it");
}

export async function remove_crossed_paper_from_airtable({ airtable_personal_access_token, airtable_base_input, airtable_record_sync }) {
  const airtable_base_id = airtable_base_id_from_input(airtable_base_input);
  if (!airtable_personal_access_token || !airtable_base_id || !airtable_record_sync || airtable_record_sync.airtable_base_id !== airtable_base_id) return false;

  let delete_record_response;
  try {
    delete_record_response = await fetch(records_endpoint_url(airtable_base_id, airtable_record_sync.airtable_record_id), airtable_request_options(airtable_personal_access_token, "DELETE"));
  } catch (request_error) {
    throw new Error(`Airtable request failed: ${request_error.message}`);
  }
  await require_successful_response(delete_record_response, "could not remove paper from Airtable");
  return true;
}
