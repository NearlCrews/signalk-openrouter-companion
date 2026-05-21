import { Cron } from 'croner';

export class CronScheduler {
  private jobs = new Set<Cron>();

  // `tz` is the per-job IANA timezone. Each analyzer carries its own
  // `triggers.cron.timezone`, so callers pass that per-analyzer value here.
  register(pattern: string, cb: () => void, tz?: string): () => void {
    const job = new Cron(pattern, tz ? { timezone: tz } : {}, () => {
      try {
        cb();
      } catch {
        // analyzer dispatch handles its own errors; swallow here so a
        // broken callback does not kill the cron job's schedule.
      }
    });
    this.jobs.add(job);
    return () => {
      job.stop();
      this.jobs.delete(job);
    };
  }

  stopAll(): void {
    for (const j of this.jobs) j.stop();
    this.jobs.clear();
  }
}
