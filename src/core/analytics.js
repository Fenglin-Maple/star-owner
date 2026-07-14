function buildAnalytics(store) {
  const tasks = store.listTasks();
  const taskEvents = store.list('taskEvents');
  const toolRuns = store.listToolRuns();
  const workers = store.listWorkers();
  const workerMap = new Map(workers.map((worker) => [worker.id, worker]));
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const collections = {};

  for (const collection of store.listCollections()) {
    const collectionTasks = tasks.filter((task) => task.collectionId === collection.id);
    const collectionEvents = taskEvents.filter((event) => String(event.collectionId || taskMap.get(event.taskId)?.collectionId || '') === String(collection.id));
    collections[collection.id] = buildCollectionStats(collectionTasks, collectionEvents, workerMap);
  }

  return {
    collections,
    workers: buildWorkerStats(workers, tasks, taskEvents, toolRuns),
    tools: buildToolStats(store.listTools(), toolRuns, workerMap),
    generatedAt: new Date().toISOString()
  };
}

function buildCollectionStats(tasks, taskEvents, workerMap) {
  const enabled = tasks.filter((task) => task.enabled !== false);
  const statuses = {};
  for (const task of enabled) statuses[task.status || 'pending'] = (statuses[task.status || 'pending'] || 0) + 1;
  const agents = buildTaskAgentRows(tasks, taskEvents, workerMap);
  const done = statuses.done || 0;
  const activeRejected = enabled.filter((task) => task.status === 'rejected' && task.workId && task.claimedBy).length;
  return {
    total: tasks.length,
    enabled: enabled.length,
    disabled: tasks.length - enabled.length,
    done,
    claimed: (statuses.claimed || 0) + activeRejected,
    pending: statuses.pending || 0,
    failed: (statuses.failed || 0) + Math.max(0, (statuses.rejected || 0) - activeRejected),
    progress: enabled.length ? done / enabled.length : 0,
    statuses,
    agents
  };
}

function buildTaskAgentRows(tasks, taskEvents, workerMap) {
  const agents = new Map();
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const eventTaskIds = new Set(taskEvents.map((event) => event.taskId));
  for (const event of taskEvents) consumeTaskEvent(agents, taskMap.get(event.taskId) || {}, event, workerMap);
  for (const task of tasks) {
    if (!eventTaskIds.has(task.id) && task.claimedBy) {
      const agent = agentRow(agents, task.claimedBy, workerMap);
      agent.claimed += Math.max(1, Number(task.attempts || 1));
      if (task.status === 'done') {
        agent.completed += 1;
        agent.successes += 1;
        addWeightedTime(agent, secondsBetween(task.claimedAt, task.completedAt), task.duration);
      } else if (task.status === 'failed' || task.status === 'rejected') {
        agent.failures += 1;
      }
    }
  }
  return [...agents.values()].map(finalizeAgent).sort(sortAgents);
}

function buildWorkerStats(workers, tasks, taskEvents, toolRuns) {
  const workerMap = new Map(workers.map((worker) => [worker.id, worker]));
  const agents = new Map();
  for (const worker of workers) agentRow(agents, worker.id, workerMap);
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const eventTaskIds = new Set(taskEvents.map((event) => event.taskId));
  for (const event of taskEvents) consumeTaskEvent(agents, taskMap.get(event.taskId) || {}, event, workerMap);

  for (const task of tasks) {
    if (!eventTaskIds.has(task.id) && task.claimedBy) {
      const agent = agentRow(agents, task.claimedBy, workerMap);
      agent.claimed += Math.max(1, Number(task.attempts || 1));
      if (task.status === 'done') {
        agent.completed += 1;
        agent.successes += 1;
        addWeightedTime(agent, secondsBetween(task.claimedAt, task.completedAt), task.duration);
      } else if (['failed', 'rejected'].includes(task.status)) {
        agent.failures += 1;
      }
    }
    if (task.claimedBy && (task.status === 'claimed' || (task.status === 'rejected' && task.workId))) {
      const agent = agentRow(agents, task.claimedBy, workerMap);
      agent.activeTasks += 1;
      agent.currentTasks.push({ id: task.id, bvid: task.bvid, title: task.title, claimedAt: task.claimedAt, leaseExpiresAt: task.leaseExpiresAt });
    }
  }

  const now = Date.now();
  for (const run of toolRuns) {
    const workerId = run.workerId || run.agentName || 'legacy-worker';
    const agent = agentRow(agents, workerId, workerMap);
    agent.toolCalls += 1;
    if (run.status === 'succeeded') agent.toolSucceeded += 1;
    if (['failed', 'timeout', 'cancelled'].includes(run.status)) agent.toolFailed += 1;
    const start = Date.parse(run.startedAt || run.createdAt || '');
    const finish = Date.parse(run.finishedAt || '') || (run.status === 'running' ? now : 0);
    if (start && finish >= start) {
      agent.toolDurationMs += finish - start;
      agent.toolDurationSamples += 1;
    }
  }

  return [...agents.values()].map((agent) => {
    const finalized = finalizeAgent(agent);
    return {
      ...finalized,
      averageToolDurationMs: agent.toolDurationSamples ? agent.toolDurationMs / agent.toolDurationSamples : 0,
      toolSuccessRate: agent.toolSucceeded + agent.toolFailed ? agent.toolSucceeded / (agent.toolSucceeded + agent.toolFailed) : null
    };
  }).sort((a, b) => Number(b.activeTasks > 0) - Number(a.activeTasks > 0) || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')));
}

function consumeTaskEvent(agents, task, event, workerMap) {
  const abortedFailure = event.type === 'attempt-aborted' && ['agent-fail', 'internal-agent-error', 'lease-expired'].includes(String(event.source || ''));
  if (!['claimed', 'completed', 'failed', 'rejected'].includes(event.type) && !abortedFailure) return;
  const workerId = event.workerId || event.agentName || task.claimedBy || 'legacy-worker';
  const agent = agentRow(agents, workerId, workerMap);
  if (event.type === 'claimed') agent.claimed += 1;
  if (event.type === 'completed') {
    agent.completed += 1;
    agent.successes += 1;
    addWeightedTime(agent, Number(event.processingSeconds || 0), Number(event.videoDuration || task.duration || 0));
  }
  if (event.type === 'failed' || event.type === 'rejected' || abortedFailure) agent.failures += 1;
}

function agentRow(map, workerId, workerMap) {
  const key = String(workerId || 'legacy-worker');
  if (!map.has(key)) {
    const worker = workerMap.get(key);
    map.set(key, {
      workerId: key,
      name: key,
      tool: worker?.tool || 'legacy',
      model: worker?.model || 'unknown',
      status: worker?.status || 'legacy',
      sessionLabel: worker?.sessionLabel || '',
      createdAt: worker?.createdAt || '',
      lastSeenAt: worker?.lastSeenAt || '',
      pauseReason: worker?.pauseReason || '',
      claimed: 0,
      completed: 0,
      successes: 0,
      failures: 0,
      processingSeconds: 0,
      videoSeconds: 0,
      activeTasks: 0,
      currentTasks: [],
      toolCalls: 0,
      toolSucceeded: 0,
      toolFailed: 0,
      toolDurationMs: 0,
      toolDurationSamples: 0
    });
  }
  return map.get(key);
}

function addWeightedTime(agent, processingSeconds, videoSeconds) {
  if (processingSeconds > 0 && videoSeconds > 0) {
    agent.processingSeconds += processingSeconds;
    agent.videoSeconds += videoSeconds;
  }
}

function finalizeAgent(agent) {
  const terminal = agent.successes + agent.failures;
  return {
    ...agent,
    weightedTimeRatio: agent.videoSeconds ? agent.processingSeconds / agent.videoSeconds : null,
    successRate: terminal ? agent.successes / terminal : null
  };
}

function sortAgents(a, b) {
  return b.completed - a.completed || b.claimed - a.claimed || a.workerId.localeCompare(b.workerId);
}

function buildToolStats(tools, runs, workerMap) {
  const now = Date.now();
  return tools.map((tool) => {
    const matching = runs.filter((run) => run.toolId === tool.id);
    const byAgent = new Map();
    let totalDurationMs = 0;
    let durationSamples = 0;
    for (const run of matching) {
      const workerId = run.workerId || run.agentName || 'legacy-worker';
      byAgent.set(workerId, (byAgent.get(workerId) || 0) + 1);
      const start = Date.parse(run.startedAt || run.createdAt || '');
      const finish = Date.parse(run.finishedAt || '') || (run.status === 'running' ? now : 0);
      if (start && finish >= start) {
        totalDurationMs += finish - start;
        durationSamples += 1;
      }
    }
    const succeeded = matching.filter((run) => run.status === 'succeeded').length;
    const failed = matching.filter((run) => ['failed', 'timeout', 'cancelled'].includes(run.status)).length;
    const terminal = succeeded + failed;
    return {
      toolId: tool.id,
      toolName: tool.name,
      calls: matching.length,
      succeeded,
      failed,
      queued: matching.filter((run) => run.status === 'queued').length,
      running: matching.filter((run) => run.status === 'running').length,
      callers: byAgent.size,
      averageDurationMs: durationSamples ? totalDurationMs / durationSamples : 0,
      successRate: terminal ? succeeded / terminal : null,
      byAgent: [...byAgent.entries()].map(([workerId, calls]) => ({
        workerId,
        agentName: workerId,
        tool: workerMap.get(workerId)?.tool || 'legacy',
        model: workerMap.get(workerId)?.model || 'unknown',
        calls
      })).sort((a, b) => b.calls - a.calls)
    };
  });
}

function secondsBetween(start, end) {
  const startMs = Date.parse(start || '');
  const endMs = Date.parse(end || '');
  return startMs && endMs >= startMs ? (endMs - startMs) / 1000 : 0;
}

module.exports = { buildAnalytics };
