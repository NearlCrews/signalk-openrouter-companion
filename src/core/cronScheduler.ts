import { Cron } from 'croner';

export class CronScheduler {
  private jobs = new Set<Cron>();

  // `tz` is the per-job IANA timezone. Each analyzer carries its own
  // `triggers.cron.timezone`, so callers pass that per-analyzer value here.
  // Jobs are torn down together via stopAll(); there is no per-job removal
  // because the lifecycle only ever stops the whole scheduler.
  register(pattern: string, cb: () => void, tz?: string): void {
    const job = new Cron(pattern, tz ? { timezone: tz } : {}, () => {
      try {
        cb();
      } catch {
        // analyzer dispatch handles its own errors; swallow here so a
        // broken callback does not kill the cron job's schedule.
      }
    });
    this.jobs.add(job);
  }

  stopAll(): void {
    for (const j of this.jobs) j.stop();
    this.jobs.clear();
  }
}
