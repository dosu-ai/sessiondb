/** One run at a time, and callers that arrive meanwhile share the next run, never the one
 * already going: a caller that changed something sees a run that started after its change. */
export class Coalesced<T> {
  private running: Promise<T> | undefined;
  private queued: Promise<T> | undefined;

  run(task: () => Promise<T>): Promise<T> {
    if (this.queued) return this.queued;
    const start = (): Promise<T> => {
      this.queued = undefined;
      const run = task().finally(() => {
        if (this.running === run) this.running = undefined;
      });
      this.running = run;
      return run;
    };
    if (!this.running) return start();
    this.queued = this.running.then(start, start);
    return this.queued;
  }
}
