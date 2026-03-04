import { spawn } from 'cross-spawn';
import taskLimit from './pLimit';
import Logger from '../loaders/logger';
import { ICron } from '../protos/cron';

interface IRunCronOptions {
  manual?: boolean;
}

export function runCron(
  cmd: string,
  cron: ICron,
  options: IRunCronOptions = {},
): Promise<number | void> {
  const runTask = (): Promise<any> => {
    return new Promise(async (resolve: any) => {
      Logger.info(
        `[schedule][start run cron] params ${JSON.stringify({
          ...cron,
          command: cmd,
        })}`,
      );
      const cp = spawn(cmd, { shell: '/bin/bash' });

      cp.stderr.on('data', (data) => {
        Logger.info(
          '[schedule][run cron stderr] command: %s, stderr: %j',
          cmd,
          data.toString(),
        );
      });
      cp.on('error', (err) => {
        Logger.error(
          '[schedule][run cron spawn error] command: %s, error: %j',
          cmd,
          err,
        );
      });

      cp.on('exit', async (code) => {
        if (!options.manual) {
          taskLimit.removeQueuedCron(cron.id);
        }
        Logger.info(
          '[schedule][run cron finished] params: %s, exitCode: %j',
          JSON.stringify({
            ...cron,
            command: cmd,
          }),
          code,
        );
        resolve({ ...cron, command: cmd, pid: cp.pid, code });
      });
    });
  };

  if (options.manual) {
    return taskLimit.manualRunWithCronLimit<any>(runTask);
  }
  return taskLimit.runWithCronLimit<any>(cron, runTask);
}
