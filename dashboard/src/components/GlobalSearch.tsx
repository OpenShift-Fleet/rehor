import { SearchInput } from "@patternfly/react-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import "./GlobalSearch.css";

export default function GlobalSearch() {
  const location = useLocation();
  const navigate = useNavigate();
  const list = location.pathname.match(/\/(tasks|archived)\/?$/)?.[1];
  const instanceBase = location.pathname.match(/^\/instances\/[^/]+/)?.[0] || "";
  const urlQuery = list ? new URLSearchParams(location.search).get("q") || "" : "";
  const [query, setQuery] = useState(urlQuery);

  const previousQuery = useRef(urlQuery);
  useEffect(() => {
    // A list navigation with the same URL query must not erase a fresh draft.
    if (previousQuery.current !== urlQuery) {
      previousQuery.current = urlQuery;
      setQuery(urlQuery);
    }
  }, [urlQuery]);

  const applyQuery = useCallback(
    (value: string) => {
      if (!list && value.trim().length < 2) return;
      const params = list ? new URLSearchParams(location.search) : new URLSearchParams();
      params.delete("task_id");
      params.delete("page");
      if (value.trim()) params.set("q", value.trim());
      else params.delete("q");
      navigate({ pathname: `${instanceBase}/${list || "tasks"}`, search: params.toString() });
    },
    [list, instanceBase, location.search, navigate],
  );

  useEffect(() => {
    if (query.trim() === urlQuery.trim()) return;
    const timer = setTimeout(() => applyQuery(query), 200);
    return () => clearTimeout(timer);
  }, [query, urlQuery, applyQuery]);

  return (
    <search
      aria-label="Global search"
      className="global-search"
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          applyQuery(query);
        }
      }}
    >
      <SearchInput
        aria-label={
          list === "archived"
            ? instanceBase
              ? "Search archived tasks in this instance"
              : "Search archived tasks"
            : instanceBase
              ? "Search tasks in this instance"
              : "Search all instances"
        }
        placeholder={
          list === "archived"
            ? "Search archived tasks, labels, bots…"
            : "Search tasks, labels, bots…"
        }
        inputProps={{ role: "searchbox", maxLength: 200 }}
        value={query}
        onChange={(_event, value) => {
          previousQuery.current = urlQuery;
          setQuery(value);
        }}
        resetButtonLabel="Clear global search"
        onClear={() => {
          setQuery("");
          applyQuery("");
        }}
      />
    </search>
  );
}
