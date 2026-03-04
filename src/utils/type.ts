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
