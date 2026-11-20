export function resolveRestartTargetPid(isContainerized, processId) {
  if (isContainerized) return 1;
  return processId === 1 ? 1 : null;
}
