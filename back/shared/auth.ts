import { AuthInfo } from '../data/system';

export function isInitializedAuthInfo(
  authInfo?: Partial<AuthInfo> | null,
): boolean {
  if (!authInfo) return true;
  return !(
    Object.keys(authInfo).length === 2 &&
    authInfo.username === 'admin' &&
    authInfo.password === 'admin'
  );
}
