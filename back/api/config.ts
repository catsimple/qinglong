import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import * as fs from 'fs/promises';
import { celebrate, Joi } from 'celebrate';
import path, { resolve } from 'path';
import { SAMPLE_FILES } from '../config/const';
import ConfigService from '../services/config';
import { writeFileWithLock } from '../shared/utils';
const route = Router();

export default (app: Router) => {
  app.use('/configs', route);

  const isPathUnderDir = (childPath: string, parentDir: string) => {
    const parent = resolve(parentDir);
    const child = resolve(childPath);
    return child === parent || child.startsWith(parent + path.sep);
  };

  route.get(
    '/sample',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.send({
          code: 200,
          data: SAMPLE_FILES,
        });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/files',
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const fileList = await fs.readdir(config.configPath, 'utf-8');
        res.send({
          code: 200,
          data: fileList
            .filter((x) => !config.blackFileList.includes(x))
            .map((x) => {
              return { title: x, value: x };
            }),
        });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/detail',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const configService = Container.get(ConfigService);
        await configService.getFile(req.query.path as string, res);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.post(
    '/save',
    celebrate({
      body: Joi.object({
        name: Joi.string().required(),
        content: Joi.string().allow('').optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        const { name, content } = req.body;
        if (config.blackFileList.includes(name)) {
          return res.send({ code: 403, message: '文件无法访问' });
        }
        const isScript = name.startsWith('data/scripts/');
        const targetPath = isScript
          ? resolve(config.rootPath, name)
          : resolve(config.configPath, name);
        const allowedBase = isScript ? config.scriptPath : config.configPath;
        if (!isPathUnderDir(targetPath, allowedBase)) {
          return res.send({ code: 403, message: '文件无法访问' });
        }
        await writeFileWithLock(targetPath, content);
        res.send({ code: 200, message: '保存成功' });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/:file',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const configService = Container.get(ConfigService);
        await configService.getFile(req.params.file, res);
      } catch (e) {
        return next(e);
      }
    },
  );
};
