import { XMLParser } from "fast-xml-parser";

const arxiv_rss_feed_url_for_category = (arxiv_category_code) =>
  `https://rss.arxiv.org/rss/${arxiv_category_code}`;

const kept_announce_types = new Set(["new", "cross"]);
const maximum_abstract_characters_kept = 1500;
const milliseconds_per_second = 1000;
const arxiv_feed_response_timeout_in_seconds = 20;
const arxiv_feed_response_timeout_in_milliseconds = arxiv_feed_response_timeout_in_seconds * milliseconds_per_second;

const rss_xml_parser = new XMLParser({
  ignoreAttributes: false,
  isArray: (tag_name) => tag_name === "item" || tag_name === "category",
});

function collapsed_whitespace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function abstract_text_from_item_description(item_description_text) {
  const description_text = String(item_description_text ?? "");
  const abstract_marker_index = description_text.indexOf("Abstract:");
  if (abstract_marker_index === -1) return collapsed_whitespace(description_text).slice(0, maximum_abstract_characters_kept);
  const text_after_marker = description_text.slice(abstract_marker_index + "Abstract:".length);
  return collapsed_whitespace(text_after_marker).slice(0, maximum_abstract_characters_kept);
}

function arxiv_id_from_item_guid(item_guid) {
  const guid_text = typeof item_guid === "object" ? item_guid?.["#text"] : item_guid;
  const guid_without_prefix = String(guid_text ?? "").replace(/^oai:arXiv\.org:/i, "");
  return guid_without_prefix.replace(/v\d+$/, "");
}

function author_names_from_item_creator(item_creator_text) {
  const creator_text = collapsed_whitespace(item_creator_text);
  if (!creator_text) return [];
  return creator_text.split(", ").map(collapsed_whitespace).filter(Boolean);
}

function paper_from_rss_item(rss_item) {
  const arxiv_category_codes = (rss_item.category ?? []).map(collapsed_whitespace).filter(Boolean);
  return {
    arxiv_id: arxiv_id_from_item_guid(rss_item.guid),
    title: collapsed_whitespace(rss_item.title),
    abstract_text: abstract_text_from_item_description(rss_item.description),
    author_names: author_names_from_item_creator(rss_item["dc:creator"]),
    arxiv_category_codes,
    primary_arxiv_category_code: arxiv_category_codes[0] ?? "",
    arxiv_abstract_url: collapsed_whitespace(rss_item.link),
  };
}

function announcement_date_iso_from_channel(rss_channel) {
  const parsed_publication_date = new Date(rss_channel?.pubDate ?? "");
  if (Number.isNaN(parsed_publication_date.getTime())) return null;
  return parsed_publication_date.toISOString().slice(0, 10);
}

export function parse_arxiv_rss_feed(rss_xml_text) {
  const parsed_rss_document = rss_xml_parser.parse(rss_xml_text);
  const rss_channel = parsed_rss_document?.rss?.channel;
  if (!rss_channel) throw new Error("arXiv RSS response has no <rss><channel> root");

  const announced_papers = (rss_channel.item ?? [])
    .filter((rss_item) => kept_announce_types.has(collapsed_whitespace(rss_item["arxiv:announce_type"]) || "new"))
    .map(paper_from_rss_item)
    .filter((paper) => paper.arxiv_id && paper.title);

  return {
    announcement_date_iso: announcement_date_iso_from_channel(rss_channel),
    papers: announced_papers,
  };
}

export async function fetch_arxiv_papers_for_category(arxiv_category_code) {
  let feed_response;
  try {
    feed_response = await fetch(arxiv_rss_feed_url_for_category(arxiv_category_code), {
      headers: { "User-Agent": "paperman (daily arxiv reading TUI)" },
      signal: AbortSignal.timeout(arxiv_feed_response_timeout_in_milliseconds),
    });
  } catch (arxiv_feed_error) {
    if (arxiv_feed_error.name === "TimeoutError") {
      throw new Error(`arXiv feed ${arxiv_category_code} timed out after ${arxiv_feed_response_timeout_in_seconds} seconds`);
    }
    throw new Error(`arXiv feed ${arxiv_category_code} request failed: ${arxiv_feed_error.message}`);
  }
  if (!feed_response.ok) {
    throw new Error(`arXiv feed ${arxiv_category_code} returned HTTP ${feed_response.status}`);
  }
  return parse_arxiv_rss_feed(await feed_response.text());
}
