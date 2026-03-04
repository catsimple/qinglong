import { AuthInfo } from '../data/system';
import { App } from '../data/open';
import Keyv from 'keyv';
import KeyvSqlite from '@keyv/sqlite';
import config from '../config';
import path from 'path';

export enum EKeyv {
  'apps' = 'apps',
  'authInfo' = 'authInfo',
}

export interface IKeyvStore {
  apps: App[];
  authInfo: AuthInfo;
}

const keyvSqlite = new KeyvSqlite(path.join(config.dbPath, 'keyv.sqlite'));
export const keyvStore = new Keyv<IKeyvStore>({ store: keyvSqlite });

let authInfoCache: IKeyvStore['authInfo'] | undefined;
let appsCache: IKeyvStore['apps'] | undefined;
let authInfoLoaded = false;
let appsLoaded = false;

export const shareStore = {
  async getAuthInfo() {
    if (authInfoLoaded) {
      return authInfoCache;
    }
    const value = await keyvStore.get<IKeyvStore['authInfo']>(EKeyv.authInfo);
    authInfoCache = value;
    authInfoLoaded = true;
    return value;
  },
  updateAuthInfo(value: IKeyvStore['authInfo']) {
    authInfoCache = value;
    authInfoLoaded = true;
    return keyvStore.set<IKeyvStore['authInfo']>(EKeyv.authInfo, value);
  },
  async getApps() {
    if (appsLoaded) {
      return appsCache;
    }
    const value = await keyvStore.get<IKeyvStore['apps']>(EKeyv.apps);
    appsCache = value;
    appsLoaded = true;
    return value;
  },
  updateApps(apps: App[]) {
    appsCache = apps;
    appsLoaded = true;
    return keyvStore.set<IKeyvStore['apps']>(EKeyv.apps, apps);
  },
};
