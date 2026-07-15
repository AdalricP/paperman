import assert from "node:assert/strict";
import { test } from "node:test";
import { parse_arxiv_rss_feed } from "../source/arxiv_paper_feed.mjs";

const rss_item = ({ arxiv_id, title, announce_type, categories, creators }) => `
    <item>
      <title>${title}</title>
      <link>https://arxiv.org/abs/${arxiv_id}</link>
      <description>arXiv:${arxiv_id}v1 Announce Type: ${announce_type}
Abstract: An abstract   about ${title}.</description>
      <guid isPermaLink="false">oai:arXiv.org:${arxiv_id}v1</guid>
      ${categories.map((category_code) => `<category>${category_code}</category>`).join("")}
      <pubDate>Fri, 10 Jul 2026 00:00:00 -0400</pubDate>
      <arxiv:announce_type>${announce_type}</arxiv:announce_type>
      <dc:creator>${creators}</dc:creator>
    </item>`;

const rss_document = (items_xml) => `<?xml version='1.0' encoding='UTF-8'?>
<rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <channel>
    <title>cs.LG updates on arXiv.org</title>
    <pubDate>Fri, 10 Jul 2026 00:00:00 -0400</pubDate>
    ${items_xml}
  </channel>
</rss>`;

test("keeps new and cross announcements, drops replacements", () => {
  const feed_xml = rss_document(
    rss_item({ arxiv_id: "2607.00001", title: "Kept New", announce_type: "new", categories: ["cs.LG"], creators: "Ada Lovelace" }) +
      rss_item({ arxiv_id: "2607.00002", title: "Kept Cross", announce_type: "cross", categories: ["cs.RO", "cs.LG"], creators: "Alan Turing" }) +
      rss_item({ arxiv_id: "2607.00003", title: "Dropped Replace", announce_type: "replace", categories: ["cs.LG"], creators: "Grace Hopper" })
  );
  const parsed_feed = parse_arxiv_rss_feed(feed_xml);
  assert.deepEqual(
    parsed_feed.papers.map((paper) => paper.arxiv_id),
    ["2607.00001", "2607.00002"]
  );
});

test("extracts paper fields from an item", () => {
  const feed_xml = rss_document(
    rss_item({ arxiv_id: "2607.00001", title: "A Paper", announce_type: "new", categories: ["cs.RO", "cs.LG"], creators: "Ada Lovelace, Alan Turing" })
  );
  const [paper] = parse_arxiv_rss_feed(feed_xml).papers;
  assert.equal(paper.arxiv_id, "2607.00001");
  assert.equal(paper.title, "A Paper");
  assert.equal(paper.abstract_text, "An abstract about A Paper.");
  assert.deepEqual(paper.author_names, ["Ada Lovelace", "Alan Turing"]);
  assert.deepEqual(paper.arxiv_category_codes, ["cs.RO", "cs.LG"]);
  assert.equal(paper.primary_arxiv_category_code, "cs.RO");
  assert.equal(paper.arxiv_abstract_url, "https://arxiv.org/abs/2607.00001");
});

test("reads the announcement date from the stale weekend channel pubDate", () => {
  const feed_xml = rss_document(
    rss_item({ arxiv_id: "2607.00001", title: "Friday Paper", announce_type: "new", categories: ["cs.LG"], creators: "Ada Lovelace" })
  );
  assert.equal(parse_arxiv_rss_feed(feed_xml).announcement_date_iso, "2026-07-10");
});

test("throws on a response without an rss channel", () => {
  assert.throws(() => parse_arxiv_rss_feed("<html>rate limited</html>"), /no <rss><channel> root/);
});
