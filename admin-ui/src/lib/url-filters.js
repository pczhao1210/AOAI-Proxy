import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

export function useUrlFilters(defaults, enabled, aliases = {}) {
  const [params, setParams] = useSearchParams();
  const [retained, setRetained] = useState(defaults);
  const serialized = params.toString();
  const filters = useMemo(() => {
    if (!enabled) return retained;
    const next = { ...defaults };
    for (const [field, fallback] of Object.entries(defaults)) {
      const value = params.get(aliases[field] || field);
      if (value == null) continue;
      if (Array.isArray(fallback)) next[field] = value.split(",").filter(Boolean);
      else if (typeof fallback === "boolean") next[field] = value === "true";
      else if (typeof fallback === "number") {
        const number = Number(value);
        next[field] = Number.isFinite(number) && number > 0 ? number : fallback;
      } else next[field] = value;
    }
    return next;
  }, [enabled, serialized, retained]);
  useEffect(() => { if (enabled) setRetained(current => JSON.stringify(current) === JSON.stringify(filters) ? current : filters); }, [enabled, filters]);
  const setFilters = update => {
    const next = typeof update === "function" ? update(filters) : update;
    setRetained(next);
    if (!enabled) return;
    setParams(current => {
      const search = new URLSearchParams(current);
      for (const [field, fallback] of Object.entries(defaults)) {
        const name = aliases[field] || field;
        const value = next[field];
        if (JSON.stringify(value) === JSON.stringify(fallback) || value === "" || value == null) search.delete(name);
        else search.set(name, Array.isArray(value) ? value.join(",") : String(value));
      }
      return search;
    });
  };
  return [filters, setFilters];
}
