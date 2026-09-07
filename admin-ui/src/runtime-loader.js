export function createRuntimeLoader({ fetchRuntime, fetchStats, initialFilters }) {
  let filters = { ...initialFilters };
  let generation = 0;
  return {
    updateFilters(patch) {
      filters = { ...filters, ...patch };
      generation += 1;
      return { ...filters };
    },
    start() {
      const requestGeneration = ++generation;
      return {
        runtime: fetchRuntime(),
        stats: fetchStats({ ...filters }),
        isCurrent: () => requestGeneration === generation
      };
    }
  };
}