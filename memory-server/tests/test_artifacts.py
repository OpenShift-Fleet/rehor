from bot_memory_server.artifacts import build_artifacts


def test_build_artifacts_includes_related_items_and_pull_requests():
    artifacts = build_artifacts(
        {
            "related_items": [
                {"name": "Related item", "url": "https://tracker.test/item/1", "type": "issue"},
                {"name": "Source item", "url": "https://tracker.test/item/2", "type": "issue"},
            ],
            "prs": [{"number": 42, "url": "https://forge.test/repo/pull/42"}],
        }
    )

    assert artifacts == [
        {
            "name": "Related item",
            "url": "https://tracker.test/item/1",
            "type": "issue",
        },
        {
            "name": "Source item",
            "url": "https://tracker.test/item/2",
            "type": "issue",
        },
        {
            "name": "PR #42",
            "url": "https://forge.test/repo/pull/42",
            "type": "pull_request",
        },
    ]


def test_build_artifacts_deduplicates_related_items():
    artifacts = build_artifacts(
        {
            "related_items": [
                {"name": "Same", "url": "https://example.test/item", "type": "related"},
                {"name": "Same again", "url": "https://example.test/item", "type": "related"},
            ]
        }
    )

    assert len(artifacts) == 1
