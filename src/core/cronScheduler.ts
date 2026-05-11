import { Cron } from 'croner';

export interface CronSchedulerOptions {
  tz?: string;
}

export class CronScheduler {
  private jobs = new Set<Cron>();

  constructor(private opts: CronSchedulerOptions = {}) {}

  register(pattern: string, cb: () => void): () => void {
    const job = new Cron(pattern, this.opts.tz ? { timezone: this.opts.tz } : {}, () => {
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
