import { Service, Inject } from 'typedi';
import path from 'path';
import config from '../config';
import { getFileContentByName } from '../config/util';
import { Response } from 'express';
import got from 'got';

@Service()
export default class ConfigService {
  constructor() {}

  public async getFile(filePath: string, res: Response) {
    let content = '';
    const isPathUnderDir = (childPath: string, parentDir: string) => {
      const parent = path.resolve(parentDir);
      const child = path.resolve(childPath);
      const rel = path.relative(parent, child);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };

    if (
      config.blackFileList.includes(filePath) ||
      !filePath
    ) {
      return res.send({ code: 403, message: '文件无法访问' });
    }

    if (filePath.startsWith('sample/')) {
      const res = await got.get(
        `https://gitlab.com/whyour/qinglong/-/raw/master/${filePath}`,
      );
      content = res.body;
    } else if (filePath.startsWith('data/scripts/')) {
      const targetPath = path.resolve(config.rootPath, filePath);
      if (!isPathUnderDir(targetPath, config.scriptPath)) {
        return res.send({ code: 403, message: '文件无法访问' });
      }
      content = await getFileContentByName(targetPath);
    } else {
      const targetPath = path.resolve(config.configPath, filePath);
      if (!isPathUnderDir(targetPath, config.configPath)) {
        return res.send({ code: 403, message: '文件无法访问' });
      }
      content = await getFileContentByName(targetPath);
    }

    res.send({ code: 200, data: content });
  }
}
