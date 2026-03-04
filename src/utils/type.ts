export type SockMessageType =
  | 'ping'
  | 'installDependence'
  | 'uninstallDependence'
  | 'updateSystemVersion'
  | 'manuallyRunScript'
  | 'cronLog'
  | 'runSubscriptionEnd'
  | 'reloadSystem'
  | 'updateNodeMirror'
  | 'updateLinuxMirror';

export interface SockPayload {
  type: SockMessageType;
  message?: string;
  references?: number[];
  log_path?: string;
  offset?: number;
  nextOffset?: number;
}
