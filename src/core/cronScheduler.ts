import { Cron } from 'croner';

export interface CronSchedulerOptions {
  tz?: string;
}

export class CronScheduler {
  private jobs = new Set<Cron>();

  constructor(private opts: CronSchedulerOptions = {}) {}

  // `tz` overrides the scheduler-wide default for this job only. Each analyzer
  // carries its own `triggers.cron.timezone`, so a single global tz cannot
  // honor them all: callers pass the per-analyzer value here.
  register(pattern: string, cb: () => void, tz?: string): () => void {
    const timezone = tz || this.opts.tz;
    const job = new Cron(pattern, timezone ? { timezone } : {}, () => {
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
