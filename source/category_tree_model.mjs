import { arxiv_category_groups, display_name_for_arxiv_category_code } from "./arxiv_category_catalog.mjs";

function legacy_whole_archive_leaf_when_tracked(category_group, tracked_arxiv_category_codes) {
  if (!tracked_arxiv_category_codes.includes(category_group.archive_code)) return [];
  if (category_group.categories.some(({ arxiv_category_code }) => arxiv_category_code === category_group.archive_code)) return [];
  return [
    {
      type: "category_checkbox",
      arxiv_category_code: category_group.archive_code,
      label: `${category_group.archive_code} — ${category_group.group_name} (whole archive)`,
      indentation_level: 1,
    },
  ];
}

function category_leaf_rows(category_group, tracked_arxiv_category_codes) {
  return [
    ...category_group.categories.map(({ arxiv_category_code }) => ({
      type: "category_checkbox",
      arxiv_category_code,
      label: `${arxiv_category_code} — ${display_name_for_arxiv_category_code(arxiv_category_code)}`,
      indentation_level: 1,
    })),
    ...legacy_whole_archive_leaf_when_tracked(category_group, tracked_arxiv_category_codes),
  ];
}

export function initial_expanded_category_group_codes(tracked_arxiv_category_codes) {
  return new Set(
    arxiv_category_groups
      .filter((category_group) =>
        category_group.categories.some(({ arxiv_category_code }) => tracked_arxiv_category_codes.includes(arxiv_category_code)) ||
        tracked_arxiv_category_codes.includes(category_group.archive_code)
      )
      .filter((category_group) => category_group.categories.length > 1)
      .map((category_group) => category_group.archive_code)
  );
}

export function category_tree_rows({ tracked_arxiv_category_codes, expanded_category_group_codes }) {
  return arxiv_category_groups.flatMap((category_group) => {
    if (category_group.categories.length === 1) {
      const [only_category] = category_group.categories;
      return [
        {
          type: "category_checkbox",
          arxiv_category_code: only_category.arxiv_category_code,
          label: `${only_category.arxiv_category_code} — ${only_category.display_name}`,
          indentation_level: 0,
        },
      ];
    }
    const is_expanded = expanded_category_group_codes.has(category_group.archive_code);
    return [
      {
        type: "category_group",
        archive_code: category_group.archive_code,
        label: `${category_group.group_name} (${category_group.archive_code})`,
        is_expanded,
      },
      ...(is_expanded ? category_leaf_rows(category_group, tracked_arxiv_category_codes) : []),
    ];
  });
}

export function expanded_category_group_codes_after_toggle(expanded_category_group_codes, archive_code) {
  const next_expanded_category_group_codes = new Set(expanded_category_group_codes);
  if (next_expanded_category_group_codes.has(archive_code)) {
    next_expanded_category_group_codes.delete(archive_code);
    return next_expanded_category_group_codes;
  }
  next_expanded_category_group_codes.add(archive_code);
  return next_expanded_category_group_codes;
}
