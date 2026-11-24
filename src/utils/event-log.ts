import { parseError } from '.';
import type { Logger } from 'pino';
import type { Event, EventRepository } from '../repositories/event-repository';

export class EventLog {
  constructor(
    public readonly logger: Logger,
    public readonly eventRepo?: EventRepository,
  ) { }

  log(event: Event) {
    this.logger.info(event);
    this.eventRepo?.save(event);
  }

  error(event: Event, error?: unknown) {
    this.logger.error({ ...event, err: error });
    if (!this.eventRepo) return;
    const { data, ...rest } = event;
    this.eventRepo.save({ ...rest, data: { ...data, error: parseError(error) } });
  }
}
