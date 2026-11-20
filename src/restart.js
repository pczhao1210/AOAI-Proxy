function positivePid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function resolveRestartTargetPid(isContainerized, processId, { supervisorPid, parentPid } = {}) {
  // docker/start.sh supervises node and handles SIGTERM; containerd/Kubernetes lack /.dockerenv.
  const supervisor = positivePid(supervisorPid);
  if (supervisor !== null && supervisor === positivePid(parentPid)) return supervisor;
  if (isContainerized) return 1;
  return processId === 1 ? 1 : null;
}
