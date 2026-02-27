import { fileExist, readDirs, readDir, rmPath } from '../config/util';
import { Router, Request, Response, NextFunction } from 'express';
import { Container } from 'typedi';
import { Logger } from 'winston';
import config from '../config';
import * as fs from 'fs/promises';
import { celebrate, Joi } from 'celebrate';
import path, { join, parse } from 'path';
import ScriptService from '../services/script';
import multer from 'multer';
import { writeFileWithLock } from '../shared/utils';
const route = Router();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, config.scriptPath);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage: storage });

const isPathUnderDir = (childPath: string, parentDir: string) => {
  const parent = path.resolve(parentDir);
  const child = path.resolve(childPath);
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const safeName = (value: string) => value.replace(/[\\/]/g, '');

export default (app: Router) => {
  app.use('/scripts', route);

  route.get('/', async (req: Request, res: Response, next: NextFunction) => {
    const logger: Logger = Container.get('logger');
    try {
      let result = [];
      const blacklist = [
        'node_modules',
        '.git',
        '.pnpm',
        'pnpm-lock.yaml',
        'yarn.lock',
        'package-lock.json',
      ];
      if (req.query.path) {
        const targetPath = path.resolve(
          config.scriptPath,
          req.query.path as string,
        );
        if (!isPathUnderDir(targetPath, config.scriptPath)) {
          return res.send({ code: 430, message: '文件路径禁止访问' });
        }
        result = await readDir(targetPath, config.scriptPath, blacklist);
      } else {
        result = await readDirs(
          config.scriptPath,
          config.scriptPath,
          blacklist,
          (a, b) => {
            if (a.type === b.type) {
              return a.title.localeCompare(b.title);
            } else {
              return a.type === 'directory' ? -1 : 1;
            }
          },
        );
      }
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
        const scriptService = Container.get(ScriptService);
        const content = await scriptService.getFile(
          req.query.path as string,
          req.query.file as string,
        );
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
        const scriptService = Container.get(ScriptService);
        const content = await scriptService.getFile(
          req.query.path as string,
          req.params.file,
        );
        res.send({ code: 200, data: content });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.post(
    '/',
    upload.single('file'),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename, path: dirPath, content, originFilename, directory } =
          req.body as {
            filename: string;
            path: string;
            content: string;
            originFilename: string;
            directory: string;
          };

        let targetDir = dirPath
          ? path.isAbsolute(dirPath)
            ? dirPath
            : join(config.scriptPath, dirPath)
          : config.scriptPath;
        targetDir = path.resolve(targetDir);
        if (config.writePathList.every((x) => !isPathUnderDir(targetDir, x))) {
          return res.send({
            code: 430,
            message: '文件路径禁止访问',
          });
        }

        if (req.file) {
          const safeFilename = safeName(filename);
          await fs.rename(req.file.path, join(targetDir, safeFilename));
          return res.send({ code: 200 });
        }

        if (directory) {
          const targetPath = path.resolve(targetDir, directory);
          if (!isPathUnderDir(targetPath, targetDir)) {
            return res.send({ code: 430, message: '文件路径禁止访问' });
          }
          await fs.mkdir(targetPath, { recursive: true });
          return res.send({ code: 200 });
        }

        if (!originFilename) {
          originFilename = filename;
        }
        const safeOrigin = safeName(originFilename);
        const safeFilename = safeName(filename);
        const originFilePath = join(targetDir, safeOrigin);
        const filePath = join(targetDir, safeFilename);
        const fileExists = await fileExist(filePath);
        if (fileExists) {
          await fs.copyFile(
            originFilePath,
            join(config.bakPath, safeOrigin),
          );
          if (filename !== originFilename) {
            await rmPath(originFilePath);
          }
        }
        await writeFileWithLock(filePath, content);
        return res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().optional().allow(''),
        content: Joi.string().required().allow(''),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename, content, path: dirPath } = req.body as {
          filename: string;
          content: string;
          path: string;
        };
        const targetDir = dirPath
          ? path.resolve(config.scriptPath, dirPath)
          : config.scriptPath;
        if (!isPathUnderDir(targetDir, config.scriptPath)) {
          return res.send({ code: 430, message: '文件路径禁止访问' });
        }
        const safeFilename = safeName(filename);
        const filePath = path.resolve(targetDir, safeFilename);
        if (!isPathUnderDir(filePath, config.scriptPath)) {
          return res.send({ code: 430, message: '文件路径禁止访问' });
        }
        await writeFileWithLock(filePath, content);
        return res.send({ code: 200 });
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
      const logger: Logger = Container.get('logger');
      try {
        let { filename, path: dirPath, type } = req.body as {
          filename: string;
          path: string;
          type: string;
        };
        const targetDir = dirPath
          ? path.resolve(config.scriptPath, dirPath)
          : config.scriptPath;
        if (!isPathUnderDir(targetDir, config.scriptPath)) {
          return res.send({ code: 430, message: '文件路径禁止访问' });
        }
        const safeFilename = safeName(filename);
        const filePath = path.resolve(targetDir, safeFilename);
        if (!isPathUnderDir(filePath, config.scriptPath)) {
          return res.send({ code: 430, message: '文件路径禁止访问' });
        }
        await rmPath(filePath);
        res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.post(
    '/download',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename } = req.body as {
          filename: string;
        };
        const safeFilename = safeName(filename);
        const filePath = path.resolve(config.scriptPath, safeFilename);
        if (!isPathUnderDir(filePath, config.scriptPath)) {
          return res.send({ code: 430, message: '文件路径禁止访问' });
        }
        // const stats = fs.statSync(filePath);
        // res.set({
        //   'Content-Type': 'application/octet-stream', //告诉浏览器这是一个二进制文件
        //   'Content-Disposition': 'attachment; filename=' + filename, //告诉浏览器这是一个需要下载的文件
        //   'Content-Length': stats.size  //文件大小
        // });
        // fs.createReadStream(filePath).pipe(res);
        return res.download(filePath, filename, (err) => {
          return next(err);
        });
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/run',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        content: Joi.string().optional().allow(''),
        path: Joi.string().optional().allow(''),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      const logger: Logger = Container.get('logger');
      try {
        let { filename, content, path: dirPath } = req.body;
        const safeFilename = safeName(filename);
        const { name, ext } = parse(safeFilename);
        const targetDir = dirPath
          ? path.resolve(config.scriptPath, dirPath)
          : config.scriptPath;
        if (!isPathUnderDir(targetDir, config.scriptPath)) {
          return res.send({ code: 430, message: '文件路径禁止访问' });
        }
        const filePath = path.resolve(
          targetDir,
          `${name}.swap${ext}`,
        );
        if (!isPathUnderDir(filePath, config.scriptPath)) {
          return res.send({ code: 430, message: '文件路径禁止访问' });
        }
        await writeFileWithLock(filePath, content || '');

        const scriptService = Container.get(ScriptService);
        const result = await scriptService.runScript(filePath);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/stop',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().optional().allow(''),
        pid: Joi.number().optional().allow(''),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path: dirPath, pid } = req.body;
        const safeFilename = safeName(filename);
        const { name, ext } = parse(safeFilename);
        const targetDir = dirPath
          ? path.resolve(config.scriptPath, dirPath)
          : config.scriptPath;
        if (!isPathUnderDir(targetDir, config.scriptPath)) {
          return res.send({ code: 430, message: '文件路径禁止访问' });
        }
        const filePath = path.resolve(
          targetDir,
          `${name}.swap${ext}`,
        );
        const logPath = path.resolve(
          config.logPath,
          dirPath || '',
          `${name}.swap`,
        );
        if (
          !isPathUnderDir(filePath, config.scriptPath) ||
          !isPathUnderDir(logPath, config.logPath)
        ) {
          return res.send({ code: 430, message: '文件路径禁止访问' });
        }

        const scriptService = Container.get(ScriptService);
        const result = await scriptService.stopScript(filePath, pid);
        setTimeout(() => {
          rmPath(logPath);
        }, 3000);
        res.send(result);
      } catch (e) {
        return next(e);
      }
    },
  );

  route.put(
    '/rename',
    celebrate({
      body: Joi.object({
        filename: Joi.string().required(),
        path: Joi.string().allow(''),
        newFilename: Joi.string().required(),
      }),
    }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        let { filename, path: dirPath, type, newFilename } = req.body as {
          filename: string;
          path: string;
          type: string;
          newFilename: string;
        };
        const targetDir = dirPath
          ? path.resolve(config.scriptPath, dirPath)
          : config.scriptPath;
        if (!isPathUnderDir(targetDir, config.scriptPath)) {
          return res.send({ code: 430, message: '文件路径禁止访问' });
        }
        const safeFilename = safeName(filename);
        const safeNewFilename = safeName(newFilename);
        const filePath = path.resolve(targetDir, safeFilename);
        const newPath = path.resolve(targetDir, safeNewFilename);
        if (
          !isPathUnderDir(filePath, config.scriptPath) ||
          !isPathUnderDir(newPath, config.scriptPath)
        ) {
          return res.send({ code: 430, message: '文件路径禁止访问' });
        }
        await fs.rename(filePath, newPath);
        res.send({ code: 200 });
      } catch (e) {
        return next(e);
      }
    },
  );
};
