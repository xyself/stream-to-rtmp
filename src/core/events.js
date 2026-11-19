const { EventEmitter } = require('node:events');

const EVENTS = Object.freeze({
  NOTIFY: 'notify',
  STREAM_STARTED: 'running',
  STREAM_OFFLINE: 'offline',
  STREAM_ERROR: 'error',
  BITRATE_DROP: 'bitrate_drop',
  BITRATE_RECOVER: 'recover',
});

class RelayEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  publish(notification) {
    if (!notification || !notification.type) return;
    this.emit('notify', notification);
    this.emit(`notify:${notification.type}`, notification);
    if (notification.type !== 'error' || this.listenerCount('error') > 0) {
      this.emit(notification.type, notification);
    }
  }
}

const defaultEventBus = new RelayEventBus();

module.exports = defaultEventBus;
module.exports.RelayEventBus = RelayEventBus;
module.exports.EVENTS = EVENTS;

