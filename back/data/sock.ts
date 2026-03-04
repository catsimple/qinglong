export class SockMessage {
  message?: string;
  type?: SockMessageType;
  references?: number[];
  log_path?: string;
  offset?: number;
  nextOffset?: number;

  constructor(options: SockMessage) {
    this.type = options.type;
    this.message = options.message;
    this.references = options.references;
    this.log_path = options.log_path;
    this.offset = options.offset;
    this.nextOffset = options.nextOffset;
  }
}

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
