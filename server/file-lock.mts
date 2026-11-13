// One writer per file: callers that target the same path run one after another.
// A failed write does not poison the queue; the next caller still gets its turn.
const writers = new Map<string, Promise<void>>();

export async function withFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const run = (writers.get(file) ?? Promise.resolve()).then(work);
  const settled = run.then(() => {}, () => {});
  writers.set(file, settled);
  try {
    return await run;
  } finally {
    if (writers.get(file) === settled) writers.delete(file);
  }
}
