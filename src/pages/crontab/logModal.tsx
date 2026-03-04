import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Button, Typography } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import {
  Loading3QuartersOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import { PageLoading } from '@ant-design/pro-layout';
import { logEnded } from '@/utils';
import Ansi from 'ansi-to-react';
import WebSocketManager from '@/utils/websocket';

const CHUNK_LIMIT = 256 * 1024;
const POLL_INTERVAL = 2000;

interface ILogChunkResponse {
  content: string;
  offset: number;
  nextOffset: number;
  done: boolean;
  total: number;
  log_path: string;
}

interface ICronWsPayload {
  message?: string;
  references?: number[];
  log_path?: string;
  offset?: number;
  nextOffset?: number;
}

const CronLogModal = ({
  cron,
  handleCancel,
  visible,
  data,
  logUrl,
}: {
  cron?: any;
  visible: boolean;
  handleCancel: () => void;
  data?: string;
  logUrl?: string;
}) => {
  const startTip = 'Starting...';
  const emptyTip = 'No logs yet';
  const [value, setValue] = useState<string>(startTip);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(true);
  const [isPhone, setIsPhone] = useState(false);
  const scrollInfoRef = useRef({ value: 0, down: true });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(false);
  const offsetRef = useRef(0);
  const logPathRef = useRef('');
  const logTextRef = useRef(startTip);
  const uniqPath = logUrl ? logUrl : String(cron?.id);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const autoScroll = () => {
    if (!scrollInfoRef.current.down) {
      return;
    }
    setTimeout(() => {
      document
        .querySelector('#log-flag')
        ?.scrollIntoView({ behavior: 'smooth' });
    }, 300);
  };

  const appendLog = useCallback(
    (chunk: string) => {
      const base = [startTip, emptyTip].includes(logTextRef.current)
        ? ''
        : logTextRef.current;
      const next = chunk ? `${base}${chunk}` : base || emptyTip;
      logTextRef.current = next;
      setValue(next);
      return next;
    },
    [emptyTip, startTip],
  );

  function scheduleNext(delay: number) {
    clearTimer();
    timerRef.current = setTimeout(() => {
      getCronLog();
    }, delay);
  }

  const getCronLog = () => {
    if (!mountedRef.current || !visible || !cron?.id) {
      return;
    }

    if (logUrl) {
      request
        .get(logUrl)
        .then(({ code, data: logData }) => {
          if (code === 200 && localStorage.getItem('logCron') === uniqPath) {
            const log = (logData as string) || emptyTip;
            logTextRef.current = log;
            setValue(log);
            setExecuting(false);
          }
        })
        .finally(() => setLoading(false));
      return;
    }

    request
      .get(
        `${config.apiPrefix}crons/${cron.id}/log/chunk?offset=${offsetRef.current}&limit=${CHUNK_LIMIT}`,
      )
      .then(({ code, data: logData }) => {
        if (code !== 200 || localStorage.getItem('logCron') !== uniqPath) {
          return;
        }
        const chunk = logData as ILogChunkResponse;
        if (
          chunk.log_path &&
          logPathRef.current &&
          chunk.log_path !== logPathRef.current
        ) {
          logPathRef.current = chunk.log_path;
          offsetRef.current = 0;
          logTextRef.current = emptyTip;
          setValue(emptyTip);
          scheduleNext(0);
          return;
        }
        if (chunk.log_path && !logPathRef.current) {
          logPathRef.current = chunk.log_path;
        }

        offsetRef.current = Math.max(offsetRef.current, chunk.nextOffset || 0);

        if (chunk.content) {
          appendLog(chunk.content);
          autoScroll();
        } else if (chunk.total === 0 && [startTip, emptyTip].includes(value)) {
          logTextRef.current = emptyTip;
          setValue(emptyTip);
        }

        const merged = logTextRef.current;
        const hasNext = Boolean(merged && !logEnded(merged));
        setExecuting(hasNext);

        if (!mountedRef.current || !visible) {
          return;
        }
        if (!chunk.done) {
          scheduleNext(0);
          return;
        }
        if (hasNext) {
          scheduleNext(POLL_INTERVAL);
        }
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const cancel = () => {
    clearTimer();
    localStorage.removeItem('logCron');
    handleCancel();
  };

  const handleScroll: React.UIEventHandler<HTMLDivElement> = (e) => {
    const sTop = (e.target as HTMLDivElement).scrollTop;
    if (scrollInfoRef.current.down) {
      scrollInfoRef.current = {
        value: sTop,
        down: sTop - scrollInfoRef.current.value > -5 || !sTop,
      };
    }
  };

  const handleWsLog = useCallback(
    (payload: ICronWsPayload) => {
      if (!visible || !cron?.id || logUrl) {
        return;
      }
      const {
        message = '',
        references = [],
        log_path,
        offset,
        nextOffset,
      } = payload;
      if (!message || !references.includes(cron.id)) {
        return;
      }

      if (log_path && logPathRef.current && log_path !== logPathRef.current) {
        logPathRef.current = log_path;
        offsetRef.current = 0;
        logTextRef.current = emptyTip;
        setValue(emptyTip);
        scheduleNext(0);
        return;
      }
      if (log_path && !logPathRef.current) {
        logPathRef.current = log_path;
      }

      const start = typeof offset === 'number' ? offset : offsetRef.current;
      const end = typeof nextOffset === 'number'
        ? nextOffset
        : start + new TextEncoder().encode(message).length;

      if (end <= offsetRef.current) {
        return;
      }

      if (start > offsetRef.current) {
        scheduleNext(0);
        return;
      }

      const merged = appendLog(message);
      offsetRef.current = end;
      setExecuting(!logEnded(merged));
      autoScroll();
    },
    [appendLog, cron, logUrl, visible],
  );

  const titleElement = () => {
    return (
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {(executing || loading) && <Loading3QuartersOutlined spin />}
        {!executing && !loading && <CheckCircleOutlined />}
        <Typography.Text ellipsis={true} style={{ marginLeft: 5 }}>
          {cron && cron.name}
        </Typography.Text>
      </div>
    );
  };

  useEffect(() => {
    if (!cron?.id || !visible) {
      mountedRef.current = false;
      clearTimer();
      return;
    }
    mountedRef.current = true;
    clearTimer();
    offsetRef.current = 0;
    logPathRef.current = '';
    logTextRef.current = startTip;
    setValue(startTip);
    setLoading(true);
    setExecuting(true);
    scrollInfoRef.current.down = true;
    getCronLog();

    return () => {
      mountedRef.current = false;
      clearTimer();
    };
  }, [cron, logUrl, startTip, visible]);

  useEffect(() => {
    if (data) {
      logTextRef.current = data;
      setValue(data);
      setLoading(false);
    }
  }, [data]);

  useEffect(() => {
    if (!visible || !cron?.id || logUrl) {
      return;
    }
    const ws = WebSocketManager.getInstance();
    ws.subscribe('cronLog', handleWsLog, {
      references: [cron.id],
    });
    return () => {
      ws.unsubscribe('cronLog', handleWsLog);
    };
  }, [cron?.id, handleWsLog, logUrl, visible]);

  useEffect(() => {
    setIsPhone(document.body.clientWidth < 768);
  }, []);

  return (
    <Modal
      title={titleElement()}
      open={visible}
      centered
      className="log-modal"
      forceRender
      onOk={() => cancel()}
      onCancel={() => cancel()}
      footer={[
        <Button type="primary" onClick={() => cancel()}>
          OK
        </Button>,
      ]}
    >
      <div onScroll={handleScroll} className="log-container">
        {loading ? (
          <PageLoading />
        ) : (
          <pre
            style={
              isPhone
                ? {
                    fontFamily: 'Source Code Pro',
                    zoom: 0.83,
                  }
                : {}
            }
          >
            <Ansi>{value}</Ansi>
          </pre>
        )}
        <div id="log-flag"></div>
      </div>
    </Modal>
  );
};

export default CronLogModal;
