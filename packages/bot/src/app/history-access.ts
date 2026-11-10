let activeRuns = 0;
let mutationDone: Promise<void> | undefined;

export class HistoryBusyError extends Error {
  constructor() {
    super("正在处理消息或修改历史，请稍后重试");
  }
}

/** 历史操作必须覆盖整个 agent 调用，避免模型持有旧快照时 WebUI 改写文件。 */
export async function withHistoryRun<T>(run: () => Promise<T>): Promise<T> {
  while (mutationDone) await mutationDone;
  activeRuns++;
  try {
    return await run();
  } finally {
    activeRuns--;
  }
}

export async function withHistoryMutation<T>(mutate: () => Promise<T>): Promise<T> {
  if (activeRuns > 0 || mutationDone) throw new HistoryBusyError();
  let release!: () => void;
  mutationDone = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    return await mutate();
  } finally {
    mutationDone = undefined;
    release();
  }
}
