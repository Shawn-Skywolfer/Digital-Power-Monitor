export type SettledSourceJob<T, R> =
  | { item: T; index: number; status: "fulfilled"; value: R }
  | { item: T; index: number; status: "rejected"; reason: unknown };

/**
 * Runs every queued source unless a fatal control error (for example, an
 * explicit stop request) is raised. A failure from one source is isolated and
 * cannot prevent later sources from being scheduled.
 */
export async function runAllSourceJobs<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettled?: (outcome: SettledSourceJob<T, R>) => void | Promise<void>,
  isFatal: (error: unknown) => boolean = () => false,
) {
  const outcomes: Array<SettledSourceJob<T, R> | undefined> = new Array(items.length);
  let nextIndex = 0;
  let fatalError: unknown;

  const loop = async () => {
    while (fatalError === undefined) {
      const index = nextIndex++;
      if (index >= items.length) return;
      const item = items[index];
      let outcome: SettledSourceJob<T, R>;
      try {
        outcome = { item, index, status: "fulfilled", value: await worker(item, index) };
      } catch (error) {
        if (isFatal(error)) {
          fatalError = error;
          return;
        }
        outcome = { item, index, status: "rejected", reason: error };
      }
      outcomes[index] = outcome;
      await onSettled?.(outcome);
    }
  };

  const workerCount = items.length === 0 ? 0 : Math.max(1, Math.min(Math.trunc(concurrency) || 1, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => loop()));
  if (fatalError !== undefined) throw fatalError;
  return outcomes.filter((outcome): outcome is SettledSourceJob<T, R> => Boolean(outcome));
}
