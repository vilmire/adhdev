export interface AsyncBatchOptions {
  concurrency?: number;
}

export async function runAsyncBatch<T>(
  items: Iterable<T>,
  worker: (item: T, index: number) => Promise<void>,
  options: AsyncBatchOptions = {},
): Promise<void> {
  const list = Array.from(items);
  if (list.length === 0) return;

  const concurrency = Math.max(1, Math.min(list.length, Math.floor(options.concurrency || 1)));
  let nextIndex = 0;

  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= list.length) return;
      await worker(list[currentIndex], currentIndex);
    }
  });

  await Promise.all(runners);
}
