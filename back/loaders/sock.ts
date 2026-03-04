import sockJs from 'sockjs';
import { Server } from 'http';
import { Container } from 'typedi';
import SockService from '../services/sock';
import { getPlatform } from '../config/util';
import { shareStore } from '../shared/store';
import { SockMessageType } from '../data/sock';

interface ISocketActionMessage {
  action?: 'subscribe' | 'unsubscribe';
  topic?: SockMessageType;
  references?: number[];
  type?: string;
}

export default async ({ server }: { server: Server }) => {
  const echo = sockJs.createServer({ prefix: '/api/ws', log: () => {} });
  const sockService = Container.get(SockService);

  echo.on('connection', async (conn) => {
    if (!conn.headers || !conn.url || !conn.pathname) {
      conn.close('404');
      return;
    }

    const authInfo = await shareStore.getAuthInfo();
    const platform = getPlatform(conn.headers['user-agent'] || '') || 'desktop';
    const headerToken = conn.url.replace(`${conn.pathname}?token=`, '');
    if (authInfo) {
      const { token = '', tokens = {} } = authInfo;
      if (headerToken === token || tokens[platform] === headerToken) {
        sockService.addClient(conn);

        conn.on('data', (message) => {
          let payload: ISocketActionMessage = {};
          try {
            payload = JSON.parse(message);
          } catch (error) {
            return;
          }

          if (payload.type === 'heartbeat') {
            return;
          }

          if (
            payload.action === 'subscribe' &&
            payload.topic
          ) {
            sockService.subscribe(conn, payload.topic, payload.references);
          }

          if (
            payload.action === 'unsubscribe' &&
            payload.topic
          ) {
            sockService.unsubscribe(conn, payload.topic, payload.references);
          }
        });

        conn.on('close', function () {
          sockService.removeClient(conn);
        });

        return;
      }
    }

    conn.close('404');
  });

  echo.installHandlers(server);
};
