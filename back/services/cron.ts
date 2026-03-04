import { Service, Inject } from 'typedi';
import winston from 'winston';
import config from '../config';
import { Crontab, CrontabModel, CrontabStatus } from '../data/cron';
import { exec } from 'child_process';
import fs from 'fs/promises';
import { createWriteStream, WriteStream } from 'fs';
import cron_parser from 'cron-parser';
import {
  getFileContentByName,
  fileExist,
  killTask,
  getUniqPath,
  safeJSONParse,
} from '../config/util';
import { Op, where, col as colFn, FindOptions, fn, Order } from 'sequelize';
import path from 'path';
import { TASK_PREFIX, QL_PREFIX } from '../config/const';
import cronClient from '../schedule/client';
import taskLimit from '../shared/pLimit';
import { spawn } from 'cross-spawn';
import dayjs from 'dayjs';
import pickBy from 'lodash/pickBy';
import omit from 'lodash/omit';
import { writeFileWithLock } from '../shared/utils';
import SockService from './sock';

interface ILogChunkResult {
  content: string;
  offset: number;
  nextOffset: number;
  done: boolean;
  total: number;
  log_path: string;
}

interface IStatusPayload {
  ids: number[];
  status: CrontabStatus;
  pid?: number;
  log_path?: string;
  last_running_time?: number;
  last_execution_time?: number;
}

@Service()
export default class CronService {
  private readonly crontabApplyDebounceMs = Math.max(
    Number(process.env.CRONTAB_APPLY_DEBOUNCE_MS || 500),
    0,
  );
  private readonly statusBatchFlushMs = Math.max(
    Number(process.env.CRON_STATUS_BATCH_FLUSH_MS || 200),
    0,
  );
  private readonly logOffsetCacheTtlMs = Math.max(
    Number(process.env.CRON_LOG_OFFSET_CACHE_TTL_MS || 5000),
    0,
  );
  private pendingCrontabData?: { data: Crontab[]; total: number };
  private crontabApplyWaiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private crontabApplyTimer: NodeJS.Timeout | null = null;
  private crontabApplyInFlight: Promise<void> = Promise.resolve();
  private pendingStatusPayloads: Array<{
    payload: IStatusPayload;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  private statusBatchTimer: NodeJS.Timeout | null = null;
  private statusBatchInFlight: Promise<void> = Promise.resolve();
  private activeLogOffsets = new Map<string, number>();

  constructor(
    @Inject('logger') private logger: winston.Logger,
    private sockService: SockService,
  ) {}

  private isNodeCron(cron: Crontab) {
    const { schedule, extra_schedules } = cron;
    if (Number(schedule?.split(/ +/).length) > 5 || extra_schedules?.length) {
      return true;
    }
    return false;
  }

  public async create(payload: Crontab): Promise<Crontab> {
    const tab = new Crontab(payload);
    tab.saved = false;
    const doc = await this.insert(tab);
    if (this.isNodeCron(doc)) {
      await cronClient.addCron([
        {
          name: doc.name || '',
          id: String(doc.id),
          schedule: doc.schedule!,
          command: this.makeCommand(doc),
          extraSchedules: doc.extra_schedules || [],
        },
      ]);
    }
    await this.set_crontab();
    return doc;
  }

  public async insert(payload: Crontab): Promise<Crontab> {
    return await CrontabModel.create(payload, { returning: true });
  }

  public async update(payload: Crontab): Promise<Crontab> {
    const doc = await this.getDb({ id: payload.id });
    const tab = new Crontab({ ...doc, ...payload });
    tab.saved = false;
    const newDoc = await this.updateDb(tab);
    if (doc.isDisabled === 1) {
      return newDoc;
    }
    if (this.isNodeCron(doc)) {
      await cronClient.delCron([String(doc.id)]);
    }
    if (this.isNodeCron(newDoc)) {
      await cronClient.addCron([
        {
          name: doc.name || '',
          id: String(newDoc.id),
          schedule: newDoc.schedule!,
          command: this.makeCommand(newDoc),
          extraSchedules: newDoc.extra_schedules || [],
        },
      ]);
    }
    await this.set_crontab();
    return newDoc;
  }

  public async updateDb(payload: Crontab): Promise<Crontab> {
    await CrontabModel.update(payload, { where: { id: payload.id } });
    return await this.getDb({ id: payload.id });
  }

  private async applyStatus({
    ids,
    status,
    pid,
    log_path,
    last_running_time = 0,
    last_execution_time = 0,
  }: IStatusPayload) {
    if (!ids?.length) {
      return;
    }

    const options: Record<string, number | string | undefined> = {
      status,
      pid,
      log_path,
      last_execution_time,
    };
    if (last_running_time > 0) {
      options.last_running_time = last_running_time;
    }

    if (status !== CrontabStatus.idle || !log_path) {
      await CrontabModel.update(
        { ...pickBy(options, (v) => v === 0 || !!v) },
        { where: { id: ids } },
      );
      return;
    }

    const docs = await CrontabModel.findAll({
      where: { id: ids },
      attributes: ['id', 'log_path'],
      raw: true,
    });

    const normalIds: number[] = [];
    const staleLogIds: number[] = [];
    docs.forEach((doc) => {
      if (
        status === CrontabStatus.idle &&
        log_path &&
        doc.log_path &&
        log_path !== doc.log_path
      ) {
        staleLogIds.push(Number(doc.id));
      } else {
        normalIds.push(Number(doc.id));
      }
    });

    if (normalIds.length) {
      await CrontabModel.update(
        { ...pickBy(options, (v) => v === 0 || !!v) },
        { where: { id: normalIds } },
      );
    }

    if (staleLogIds.length) {
      const staleOptions = omit(options, ['status', 'log_path', 'pid']);
      if (Object.keys(staleOptions).length) {
        await CrontabModel.update(
          { ...pickBy(staleOptions, (v) => v === 0 || !!v) },
          { where: { id: staleLogIds } },
        );
      }
    }
  }

  private getStatusGroupKey(payload: IStatusPayload) {
    return JSON.stringify([
      payload.status,
      payload.pid,
      payload.log_path,
      payload.last_running_time || 0,
      payload.last_execution_time || 0,
    ]);
  }

  private async flushStatusBatch() {
    const queue = this.pendingStatusPayloads.splice(0);
    this.statusBatchTimer = null;
    if (!queue.length) {
      return;
    }

    const latestById = new Map<number, IStatusPayload>();
    queue.forEach(({ payload }) => {
      payload.ids.forEach((id) => {
        if (typeof id !== 'number' || isNaN(id)) {
          return;
        }
        latestById.set(id, { ...payload, ids: [id] });
      });
    });

    const grouped = new Map<string, IStatusPayload>();
    latestById.forEach((payload) => {
      const id = payload.ids[0];
      const key = this.getStatusGroupKey(payload);
      const current = grouped.get(key);
      if (current) {
        current.ids.push(id);
      } else {
        grouped.set(key, { ...payload, ids: [id] });
      }
    });

    this.statusBatchInFlight = this.statusBatchInFlight
      .catch(() => undefined)
      .then(async () => {
        for (const payload of grouped.values()) {
          await this.applyStatus(payload);
        }
      });

    this.statusBatchInFlight
      .then(() => {
        queue.forEach((item) => item.resolve());
      })
      .catch((error) => {
        queue.forEach((item) => item.reject(error));
      });
  }

  public async status(payload: IStatusPayload) {
    if (!payload.ids?.length) {
      return;
    }
    if (this.statusBatchFlushMs <= 0) {
      await this.applyStatus(payload);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.pendingStatusPayloads.push({ payload, resolve, reject });
      if (!this.statusBatchTimer) {
        this.statusBatchTimer = setTimeout(() => {
          this.flushStatusBatch();
        }, this.statusBatchFlushMs);
      }
    });
  }

  public async remove(ids: number[]) {
    await CrontabModel.destroy({ where: { id: ids } });
    await cronClient.delCron(ids.map(String));
    await this.set_crontab();
  }

  public async pin(ids: number[]) {
    await CrontabModel.update({ isPinned: 1 }, { where: { id: ids } });
  }

  public async unPin(ids: number[]) {
    await CrontabModel.update({ isPinned: 0 }, { where: { id: ids } });
  }

  public async addLabels(ids: string[], labels: string[]) {
    const docs = await CrontabModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      await CrontabModel.update(
        {
          labels: Array.from(new Set((doc.labels || []).concat(labels))),
        },
        { where: { id: doc.id } },
      );
    }
  }

  public async removeLabels(ids: string[], labels: string[]) {
    const docs = await CrontabModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      await CrontabModel.update(
        {
          labels: (doc.labels || []).filter((label) => !labels.includes(label)),
        },
        { where: { id: doc.id } },
      );
    }
  }

  private formatViewQuery(query: any, viewQuery: any) {
    if (viewQuery.filters && viewQuery.filters.length > 0) {
      const primaryOperate = viewQuery.filterRelation === 'or' ? Op.or : Op.and;
      if (!query[primaryOperate]) {
        query[primaryOperate] = [];
      }
      for (const col of viewQuery.filters) {
        const { property, value, operation } = col;
        let q: any = {};
        let operate2 = null;
        let operate = null;
        switch (operation) {
          case 'Reg':
            operate = Op.like;
            operate2 = Op.or;
            break;
          case 'NotReg':
            operate = Op.notLike;
            operate2 = Op.and;
            break;
          case 'In':
            q[Op.or] = [
              {
                [property]: Array.isArray(value) ? value : [value],
              },
              property === 'status' && value.includes(2)
                ? { isDisabled: 1 }
                : {},
            ];
            break;
          case 'Nin':
            q[Op.and] = [
              {
                [property]: {
                  [Op.notIn]: Array.isArray(value) ? value : [value],
                },
              },
              property === 'status' && value.includes(2)
                ? { isDisabled: { [Op.ne]: 1 } }
                : {},
            ];
            break;
          default:
            break;
        }
        if (operate && operate2) {
          q[property] = {
            [Op.or]: [
              {
                [operate2]: [
                  { [operate]: `%${value}%` },
                  { [operate]: `%${encodeURI(value)}%` },
                ],
              },
              {
                [operate2]: [
                  where(colFn(property), operate, `%${value}%`),
                  where(colFn(property), operate, `%${encodeURI(value)}%`),
                ],
              },
            ],
          };
        }
        query[primaryOperate].push(q);
      }
    }
  }

  private formatSearchText(query: any, searchText: string | undefined) {
    if (searchText) {
      if (!query[Op.and]) {
        query[Op.and] = [];
      }
      let q: any = {};
      const textArray = searchText.split(':');
      switch (textArray[0]) {
        case 'name':
        case 'command':
        case 'schedule':
        case 'label':
          const column = textArray[0] === 'label' ? 'labels' : textArray[0];
          q[column] = {
            [Op.or]: [
              { [Op.like]: `%${textArray[1]}%` },
              { [Op.like]: `%${encodeURI(textArray[1])}%` },
            ],
          };
          break;
        default:
          const reg = {
            [Op.or]: [
              { [Op.like]: `%${searchText}%` },
              { [Op.like]: `%${encodeURI(searchText)}%` },
            ],
          };
          q[Op.or] = [
            {
              name: reg,
            },
            {
              command: reg,
            },
            {
              schedule: reg,
            },
            {
              labels: reg,
            },
          ];
          break;
      }
      query[Op.and].push(q);
    }
  }

  private formatFilterQuery(query: any, filterQuery: any) {
    if (filterQuery) {
      if (!query[Op.and]) {
        query[Op.and] = [];
      }
      const filterKeys: any = Object.keys(filterQuery);
      for (const key of filterKeys) {
        let q: any = {};
        if (!filterQuery[key]) continue;
        if (key === 'status') {
          if (filterQuery[key].includes(CrontabStatus.disabled)) {
            q = { [Op.or]: [{ [key]: filterQuery[key] }, { isDisabled: 1 }] };
          } else {
            q = { [Op.and]: [{ [key]: filterQuery[key] }, { isDisabled: 0 }] };
          }
        } else {
          q[key] = filterQuery[key];
        }
        query[Op.and].push(q);
      }
    }
  }

  private formatViewSort(order: string[][], viewQuery: any) {
    if (viewQuery.sorts && viewQuery.sorts.length > 0) {
      for (const { property, type } of viewQuery.sorts) {
        order.unshift([property, type]);
      }
    }
  }

  public async find({
    log_path,
  }: {
    log_path: string;
  }): Promise<Crontab | null> {
    try {
      const result = await CrontabModel.findOne({ where: { log_path } });
      return result;
    } catch (error) {
      throw error;
    }
  }

  public async crontabs(params?: {
    searchValue: string;
    page: string;
    size: string;
    sorter: string;
    filters: string;
    queryString: string;
  }): Promise<{ data: Crontab[]; total: number }> {
    const searchText = params?.searchValue;
    const page = Number(params?.page || '0');
    const size = Number(params?.size || '0');
    const viewQuery = safeJSONParse(params?.queryString);
    const filterQuery = safeJSONParse(params?.filters);
    const sorterQuery = safeJSONParse(params?.sorter);

    let query: any = {};
    let order = [
      ['isPinned', 'DESC'],
      ['isDisabled', 'ASC'],
      ['status', 'ASC'],
      ['createdAt', 'DESC'],
    ];

    this.formatViewQuery(query, viewQuery);
    this.formatSearchText(query, searchText);
    this.formatFilterQuery(query, filterQuery);
    this.formatViewSort(order, viewQuery);

    if (sorterQuery) {
      const { field, type } = sorterQuery;
      if (field && type) {
        order.unshift([field, type]);
      }
    }
    let condition: FindOptions<Crontab> = {
      where: query,
      order: order as Order,
    };
    if (page && size) {
      condition.offset = (page - 1) * size;
      condition.limit = size;
    }
    try {
      const result = await CrontabModel.findAll(condition);
      const count = await CrontabModel.count({ where: query });
      return { data: result, total: count };
    } catch (error) {
      throw error;
    }
  }

  public async getDb(query: FindOptions<Crontab>['where']): Promise<Crontab> {
    const doc: any = await CrontabModel.findOne({ where: { ...query } });
    if (!doc) {
      throw new Error(`Cron ${JSON.stringify(query)} not found`);
    }
    return doc.get({ plain: true });
  }

  public async run(ids: number[]) {
    if (!ids?.length) {
      return;
    }
    await CrontabModel.update(
      { status: CrontabStatus.queued, pid: undefined, log_path: '' },
      { where: { id: ids } },
    );

    const docs = (await CrontabModel.findAll({
      where: { id: ids },
      attributes: ['id', 'name', 'schedule', 'command', 'extra_schedules'],
      raw: true,
    })) as unknown as Crontab[];
    const localIds = docs
      .map((x) => Number(x.id))
      .filter((x) => !isNaN(x));
    const useSchedule = process.env.CRON_MANUAL_RUN_USE_SCHEDULE !== 'false';

    if (useSchedule && docs.length) {
      const payload = docs.map((doc) => ({
        name: doc.name || '',
        id: String(doc.id),
        schedule: doc.schedule || '',
        command: `no_delay=true ${this.makeCommand(new Crontab(doc), false)}`,
        extraSchedules: doc.extra_schedules || [],
      }));

      if (payload.length) {
        try {
          await cronClient.runCron(payload);
          return;
        } catch (error) {
          this.logger.error(
            '[panel][manual run via schedule failed, fallback local] %o',
            error,
          );
        }
      }
    }

    (localIds.length ? localIds : ids).forEach((id) => {
      this.runSingle(id);
    });
  }

  public async stop(ids: number[]) {
    const docs = await CrontabModel.findAll({ where: { id: ids } });
    for (const doc of docs) {
      if (doc.pid) {
        try {
          await killTask(doc.pid);
        } catch (error) {
          this.logger.error(error);
        }
      }
    }

    await CrontabModel.update(
      { status: CrontabStatus.idle, pid: undefined },
      { where: { id: ids } },
    );
  }

  private async runSingle(cronId: number): Promise<number | void> {
    return taskLimit.manualRunWithCronLimit(() => {
      return new Promise(async (resolve: any) => {
        const cron = await this.getDb({ id: cronId });
        const params = {
          name: cron.name,
          command: cron.command,
          schedule: cron.schedule,
          extraSchedules: cron.extra_schedules,
        };
        if (cron.status !== CrontabStatus.queued) {
          resolve(params);
          return;
        }

        this.logger.info(
          `[panel][start manual cron] params: ${JSON.stringify(params)}`,
        );

        const { command, log_path } = cron;
        const id = cron.id;
        if (typeof id !== 'number') {
          resolve(params);
          return;
        }
        const uniqPath = await getUniqPath(command, `${id}`);
        const logTime = dayjs().format('YYYY-MM-DD-HH-mm-ss-SSS');
        const logDirPath = path.resolve(config.logPath, `${uniqPath}`);
        if (log_path?.split('/')?.every((x) => x !== uniqPath)) {
          await fs.mkdir(logDirPath, { recursive: true });
        }
        const logPath = `${uniqPath}/${logTime}.log`;
        const absolutePath = path.resolve(config.logPath, `${logPath}`);
        const logStream = createWriteStream(absolutePath, {
          flags: 'a',
          encoding: 'utf8',
        });
        this.activeLogOffsets.set(logPath, 0);
        const cp = spawn(
          `real_log_path=${logPath} no_delay=true ${this.makeCommand(
            cron,
            true,
          )}`,
          { shell: '/bin/bash' },
        );

        await CrontabModel.update(
          { status: CrontabStatus.running, pid: cp.pid, log_path: logPath },
          { where: { id } },
        );

        let logOffset = 0;
        const pushLog = (message: string) => {
          const startOffset = logOffset;
          const nextOffset = startOffset + Buffer.byteLength(message, 'utf8');
          logOffset = nextOffset;
          this.activeLogOffsets.set(logPath, nextOffset);
          this.writeStreamLog(logStream, message);
          this.sockService.sendMessage({
            type: 'cronLog',
            message,
            references: [id],
            log_path: logPath,
            offset: startOffset,
            nextOffset,
          });
        };

        cp.stdout.on('data', async (data) => {
          pushLog(data.toString());
        });
        cp.stderr.on('data', async (data) => {
          this.logger.info(
            '[panel][manual cron stderr] command:%s, stderr:%j',
            command,
            data.toString(),
          );
          pushLog(data.toString());
        });
        cp.on('error', async (err) => {
          this.logger.error(
            '[panel][manual cron spawn error] command:%s, error:%j',
            command,
            err,
          );
          pushLog(JSON.stringify(err));
          await this.closeStream(logStream);
          this.activeLogOffsets.delete(logPath);
        });

        cp.on('exit', async (code) => {
          await this.closeStream(logStream);
          this.keepLogOffsetInShortCache(logPath, logOffset);
          this.logger.info(
            '[panel][manual cron finished] params:%s, exitCode:%j',
            JSON.stringify(params),
            code,
          );
          await CrontabModel.update(
            { status: CrontabStatus.idle, pid: undefined },
            { where: { id } },
          );
          resolve({ ...params, pid: cp.pid, code });
        });
      });
    });
  }

  public async disabled(ids: number[]) {
    await CrontabModel.update({ isDisabled: 1 }, { where: { id: ids } });
    await cronClient.delCron(ids.map(String));
    await this.set_crontab();
  }

  public async enabled(ids: number[]) {
    await CrontabModel.update({ isDisabled: 0 }, { where: { id: ids } });
    const docs = await CrontabModel.findAll({ where: { id: ids } });
    const sixCron = docs
      .filter((x) => this.isNodeCron(x))
      .map((doc) => ({
        name: doc.name || '',
        id: String(doc.id),
        schedule: doc.schedule!,
        command: this.makeCommand(doc),
        extraSchedules: doc.extra_schedules || [],
      }));
    await cronClient.addCron(sixCron);
    await this.set_crontab();
  }

  public async log(id: number) {
    const doc = await this.getDb({ id });
    if (!doc) {
      return '';
    }

    const absolutePath = path.resolve(config.logPath, `${doc.log_path}`);
    const logFileExist = doc.log_path && (await fileExist(absolutePath));
    if (logFileExist) {
      return await getFileContentByName(`${absolutePath}`);
    }
    return 'Task not run';
  }

  public async logChunk(
    id: number,
    offset: number = 0,
    limit: number = 256 * 1024,
  ): Promise<ILogChunkResult> {
    const doc = await this.getDb({ id });
    if (!doc?.log_path) {
      return {
        content: '',
        offset: 0,
        nextOffset: 0,
        done: true,
        total: 0,
        log_path: '',
      };
    }

    const absolutePath = path.resolve(config.logPath, `${doc.log_path}`);
    const logFileExist = await fileExist(absolutePath);
    if (!logFileExist) {
      return {
        content: '',
        offset: 0,
        nextOffset: 0,
        done: true,
        total: 0,
        log_path: doc.log_path,
      };
    }

    const cachedTotal = this.activeLogOffsets.get(doc.log_path);
    const total =
      typeof cachedTotal === 'number'
        ? cachedTotal
        : (await fs.stat(absolutePath)).size;
    const safeOffset = Math.min(Math.max(Number(offset) || 0, 0), total);
    const safeLimit = Math.min(
      Math.max(Number(limit) || 256 * 1024, 1024),
      1024 * 1024,
    );
    const nextOffset = Math.min(safeOffset + safeLimit, total);
    let content = '';
    let nextReadableOffset = safeOffset;

    if (nextOffset > safeOffset) {
      const file = await fs.open(absolutePath, 'r');
      try {
        const length = nextOffset - safeOffset;
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await file.read(buffer, 0, length, safeOffset);
        if (bytesRead > 0) {
          content = buffer.subarray(0, bytesRead).toString('utf8');
          nextReadableOffset = safeOffset + bytesRead;
        }
      } finally {
        await file.close();
      }
    }

    return {
      content,
      offset: safeOffset,
      nextOffset: nextReadableOffset,
      done: nextReadableOffset >= total,
      total,
      log_path: doc.log_path,
    };
  }

  public async logs(id: number) {
    const doc = await this.getDb({ id });
    if (!doc || !doc.log_path) {
      return [];
    }

    const relativeDir = path.dirname(`${doc.log_path}`);
    const dir = path.resolve(config.logPath, relativeDir);
    const dirExist = await fileExist(dir);
    if (dirExist) {
      let files = await fs.readdir(dir);
      return (
        await Promise.all(
          files.map(async (x) => ({
            filename: x,
            directory: relativeDir.replace(config.logPath, ''),
            time: (await fs.lstat(`${dir}/${x}`)).mtime.getTime(),
          })),
        )
      ).sort((a, b) => b.time - a.time);
    } else {
      return [];
    }
  }

  private writeStreamLog(stream: WriteStream, message: string) {
    if (!stream.destroyed && !stream.writableEnded) {
      stream.write(message);
    }
  }

  private async closeStream(stream: WriteStream) {
    if (stream.destroyed || stream.writableEnded) {
      return;
    }
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }

  private keepLogOffsetInShortCache(logPath: string, offset: number) {
    if (!logPath) {
      return;
    }
    if (this.logOffsetCacheTtlMs <= 0) {
      this.activeLogOffsets.delete(logPath);
      return;
    }
    this.activeLogOffsets.set(logPath, offset);
    setTimeout(() => {
      if (this.activeLogOffsets.get(logPath) === offset) {
        this.activeLogOffsets.delete(logPath);
      }
    }, this.logOffsetCacheTtlMs);
  }

  private makeCommand(tab: Crontab, realTime?: boolean) {
    let command = tab.command.trim();
    if (!command.startsWith(TASK_PREFIX) && !command.startsWith(QL_PREFIX)) {
      command = `${TASK_PREFIX}${tab.command}`;
    }
    let commandVariable = `real_time=${Boolean(realTime)} no_tee=true ID=${
      tab.id
    } `;
    if (tab.task_before) {
      commandVariable += `task_before='${tab.task_before
        .replace(/'/g, "'\\''")
        .replace(/;? *\n/g, ';')
        .trim()}' `;
    }
    if (tab.task_after) {
      commandVariable += `task_after='${tab.task_after
        .replace(/'/g, "'\\''")
        .replace(/;? *\n/g, ';')
        .trim()}' `;
    }

    const crontab_job_string = `${commandVariable}${command}`;
    return crontab_job_string;
  }

  private async applyCrontabNow(data?: { data: Crontab[]; total: number }) {
    const tabs = data ?? this.pendingCrontabData ?? (await this.crontabs());
    this.pendingCrontabData = undefined;
    var crontab_string = '';
    tabs.data.forEach((tab) => {
      const _schedule = tab.schedule && tab.schedule.split(/ +/);
      if (
        tab.isDisabled === 1 ||
        _schedule!.length !== 5 ||
        tab.extra_schedules?.length
      ) {
        crontab_string += '# ';
        crontab_string += tab.schedule;
        crontab_string += ' ';
        crontab_string += this.makeCommand(tab);
        crontab_string += '\n';
      } else {
        crontab_string += tab.schedule;
        crontab_string += ' ';
        crontab_string += this.makeCommand(tab);
        crontab_string += '\n';
      }
    });

    await writeFileWithLock(config.crontabFile, crontab_string);

    await new Promise<void>((resolve, reject) => {
      const cp = spawn('crontab', [config.crontabFile]);
      let errorOutput = '';
      cp.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });
      cp.on('error', (error) => reject(error));
      cp.on('exit', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(errorOutput || `crontab apply failed with code ${code}`),
        );
      });
    });
    await CrontabModel.update({ saved: true }, { where: {} });
  }

  private async set_crontab(data?: { data: Crontab[]; total: number }) {
    if (data) {
      this.pendingCrontabData = data;
    }

    if (this.crontabApplyDebounceMs <= 0) {
      await this.applyCrontabNow(data);
      return;
    }

    return await new Promise<void>((resolve, reject) => {
      this.crontabApplyWaiters.push({ resolve, reject });
      if (this.crontabApplyTimer) {
        clearTimeout(this.crontabApplyTimer);
      }
      this.crontabApplyTimer = setTimeout(() => {
        const waiters = this.crontabApplyWaiters.splice(0);
        const applyData = this.pendingCrontabData;
        this.pendingCrontabData = undefined;
        this.crontabApplyTimer = null;

        this.crontabApplyInFlight = this.crontabApplyInFlight
          .catch(() => undefined)
          .then(async () => {
            await this.applyCrontabNow(applyData);
          });

        this.crontabApplyInFlight
          .then(() => {
            waiters.forEach((item) => item.resolve());
          })
          .catch((error) => {
            waiters.forEach((item) => item.reject(error));
          });
      }, this.crontabApplyDebounceMs);
    });
  }

  public import_crontab() {
    exec('crontab -l', (error, stdout, stderr) => {
      const lines = stdout.split('\n');
      const namePrefix = new Date().getTime();

      lines.reverse().forEach(async (line, index) => {
        line = line.replace(/\t+/g, ' ');
        const regex =
          /^((\@[a-zA-Z]+\s+)|(([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+))/;
        const command = line.replace(regex, '').trim();
        const schedule = line.replace(command, '').trim();

        if (
          command &&
          schedule &&
          cron_parser.parseExpression(schedule).hasNext()
        ) {
          const name = namePrefix + '_' + index;

          const _crontab = await CrontabModel.findOne({
            where: { command, schedule },
          });
          if (!_crontab) {
            await this.create({ name, command, schedule });
          } else {
            _crontab.command = command;
            _crontab.schedule = schedule;
            await this.update(_crontab);
          }
        }
      });
    });
  }

  public async autosave_crontab() {
    const tabs = await this.crontabs();
    this.set_crontab(tabs);

    const sixCron = tabs.data
      .filter((x) => this.isNodeCron(x) && x.isDisabled !== 1)
      .map((doc) => ({
        name: doc.name || '',
        id: String(doc.id),
        schedule: doc.schedule!,
        command: this.makeCommand(doc),
        extraSchedules: doc.extra_schedules || [],
      }));
    await cronClient.addCron(sixCron);
  }
}
