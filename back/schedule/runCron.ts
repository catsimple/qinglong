import { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { RunCronRequest, RunCronResponse } from '../protos/cron';
import { runCron } from '../shared/runCron';
import Logger from '../loaders/logger';

const runCronTask = (
  call: ServerUnaryCall<RunCronRequest, RunCronResponse>,
  callback: sendUnaryData<RunCronResponse>,
) => {
  call.request.crons.forEach((cron) => {
    Logger.info(
      '[schedule][manual run cron], taskId: %s, name: %s, command: %s',
      cron.id,
      cron.name,
      cron.command,
    );
    runCron(cron.command, cron, { manual: true }).catch((error) => {
      Logger.error(
        '[schedule][manual run cron failed], taskId: %s, error: %j',
        cron.id,
        error,
      );
    });
  });

  callback(null, {});
};

export { runCronTask };
