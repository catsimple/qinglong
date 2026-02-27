import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import { getFileContentByName, readDirs, rmPath } from '../config/util';
import path, { resolve } from 'path';
import { celebrate, Joi } from 'celebrate';
const route = Router();
const blacklist = ['.tmp'];

const isPathUnderDir = (childPath: string, parentDir: string) => {
  const parent = path.resolve(parentDir);
  const child = path.resolve(childPath);
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const safeName = (value: string) => value.replace(/[\\/]/g, '');

export default (app: Router) => {
  app.use('/logs', route);

  route.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const logger: Logger = Container.get('logger');
    try {
      const result = await readDirs(config.logPath, config.logPath, blacklist);
      res.send({
        code: 200,
        data: result,
      });
    } catch (e) {
      logger.error('🔥 error: %o', e);
      return next(e);
    }
  });

  route.get(
    '/detail',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const finalPath = resolve(
          config.logPath,
          (req.query.path as string) || '',
          (req.query.file as string) || '',
        );

        if (
          blacklist.includes(req.query.path as string) ||
          !isPathUnderDir(finalPath, config.logPath)
        ) {
          return res.send({ code: 403, message: '暂无权限' });
        }
        const content = await getFileContentByName(finalPath);
        res.send({ code: 200, data: content });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.get(
    '/:file',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const finalPath = resolve(
          config.logPath,
          (req.query.path as string) || '',
          (req.params.file as string) || '',
        );
        if (
          blacklist.includes(req.query.path as string) ||
          !isPathUnderDir(finalPath, config.logPath)
        ) {
          return res.send({ code: 403, message: '暂无权限' });
        }
        const content = await getFileContentByName(finalPath);
        res.send({ code: 200, data: content });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.delete(
    '/',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().allow(''),
        type: Joi.string().optional(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path, type } = req.body as {
          filename: string;
          path: string;
          type: string;
        };
        if (blacklist.includes(path)) {
          return res.send({ code: 403, message: '暂无权限' });
        }
        const safeFilename = safeName(filename);
        const filePath = path
          ? resolve(config.logPath, path, safeFilename)
          : resolve(config.logPath, safeFilename);
        if (!isPathUnderDir(filePath, config.logPath)) {
          return res.send({ code: 403, message: '暂无权限' });
        }
        await rmPath(filePath);
        res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );
};
