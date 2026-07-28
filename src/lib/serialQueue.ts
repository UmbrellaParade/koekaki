export interface SerialTaskQueue {
  tail: Promise<void>
}

export function createSerialTaskQueue(): SerialTaskQueue {
  return { tail: Promise.resolve() }
}

/**
 * 処理自体の失敗は呼び出し元へ返しつつ、待機列の末尾は必ずsettledにする。
 * 1回の保存失敗で、その後の保存や接続テストまで永久に止まるのを防ぐ。
 */
export function enqueueSerialTask(queue: SerialTaskQueue, task: () => Promise<void>): Promise<void> {
  const operation = queue.tail.then(task)
  queue.tail = operation.catch(() => undefined)
  return operation
}

export function waitForSerialTasks(queue: SerialTaskQueue): Promise<void> {
  return queue.tail
}
