import { Server, ServerCredentials } from '@grpc/grpc-js';
import { CronService } from '../protos/cron';
import { addCron } from './addCron';
import { delCron } from './delCron';
import { runCronTask } from './runCron';
import { HealthService } from '../protos/health';
import { check } from './health';
import config from '../config';
import Logger from '../loaders/logger';

const server = new Server({ 'grpc.enable_http_proxy': 0 });
server.addService(HealthService, { check });
server.addService(CronService, { addCron, delCron, runCron: runCronTask });
server.bindAsync(
  `0.0.0.0:${config.cronPort}`,
  ServerCredentials.createInsecure(),
  (err) => {
    if (err) {
      throw err;
    }
    Logger.debug('schedule service started');
    console.debug('schedule service started');
    process.send?.('ready');
  },
);
