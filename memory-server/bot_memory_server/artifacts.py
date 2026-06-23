import os


JIRA_BASE_URL = os.environ.get("JIRA_URL", "").rstrip("/") + "/browse"


def build_artifacts(metadata) -> list[dict]:
    artifacts = []
    seen_urls: set[str] = set()

    meta = metadata if isinstance(metadata, dict) else {}
    for pr in meta.get("prs", []):
        url = pr.get("url", "")
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        number = pr.get("number", "?")
        pr_type = "merge_request" if pr.get("host") == "gitlab" else "pull_request"
        prefix = "MR" if pr_type == "merge_request" else "PR"
        artifacts.append({"name": f"{prefix} #{number}", "url": url, "type": pr_type})

    return artifacts
