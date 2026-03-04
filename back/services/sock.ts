import { Service, Inject } from 'typedi';
import winston from 'winston';
import { Connection } from 'sockjs';
import { SockMessage } from '../data/sock';
import { SockMessageType } from '../data/sock';

type TTopicSubscription = Set<number> | null;
type TClientSubscriptions = Map<SockMessageType, TTopicSubscription>;

@Service()
export default class SockService {
  private clients: Connection[] = [];
  private subscriptions = new Map<Connection, TClientSubscriptions>();

  constructor(@Inject('logger') private logger: winston.Logger) { }

  public getClients() {
    return this.clients;
  }

  public addClient(conn: Connection) {
    if (this.clients.indexOf(conn) === -1) {
      this.clients.push(conn);
      this.subscriptions.set(conn, new Map());
    }
  }

  public removeClient(conn: Connection) {
    const index = this.clients.indexOf(conn);
    if (index !== -1) {
      this.clients.splice(index, 1);
    }
    this.subscriptions.delete(conn);
  }

  public subscribe(
    conn: Connection,
    topic: SockMessageType,
    references?: number[],
  ) {
    const topicMap = this.subscriptions.get(conn) || new Map();
    this.subscriptions.set(conn, topicMap);

    if (!references?.length) {
      topicMap.set(topic, null);
      return;
    }

    const current = topicMap.get(topic);
    if (current === null) {
      return;
    }

    const next = current || new Set<number>();
    references.forEach((x) => {
      if (typeof x === 'number' && !isNaN(x)) {
        next.add(x);
      }
    });
    topicMap.set(topic, next);
  }

  public unsubscribe(
    conn: Connection,
    topic: SockMessageType,
    references?: number[],
  ) {
    const topicMap = this.subscriptions.get(conn);
    if (!topicMap || !topicMap.has(topic)) {
      return;
    }

    if (!references?.length) {
      topicMap.delete(topic);
      return;
    }

    const current = topicMap.get(topic);
    if (!current) {
      topicMap.delete(topic);
      return;
    }

    references.forEach((x) => current.delete(x));
    if (current.size === 0) {
      topicMap.delete(topic);
    } else {
      topicMap.set(topic, current);
    }
  }

  private shouldSend(conn: Connection, msg: SockMessage) {
    const topic = msg.type;
    if (!topic) {
      return false;
    }
    const topicMap = this.subscriptions.get(conn);
    const current = topicMap?.get(topic);
    if (typeof current === 'undefined') {
      return false;
    }
    if (current === null) {
      return true;
    }
    if (!msg.references?.length) {
      return true;
    }
    return msg.references.some((x) => current.has(x));
  }

  public sendMessage(msg: SockMessage) {
    this.clients.forEach((x) => {
      if (this.shouldSend(x, msg)) {
        x.write(JSON.stringify(msg));
      }
    });
  }
}
