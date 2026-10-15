// Bridge between the page (source/*.js) and the desktop app's main process. The page only sees window.carbovis.
const { contextBridge, ipcRenderer } = require('electron');
const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const EVENTS = ['update', 'peers', 'lib-changed', 'open-log', 'open-matchview'];

contextBridge.exposeInMainWorld('FRC_DESKTOP', true);
contextBridge.exposeInMainWorld('carbovis', {
  info: () => inv('app:info'),
  lib: {
    list: () => inv('lib:list'),
    read: name => inv('lib:read', name),
    write: (name, bytes) => inv('lib:write', name, bytes),
    remove: name => inv('lib:remove', name),
    meta: (name, patch) => inv('lib:meta', name, patch),
    reveal: () => inv('lib:reveal'),
    import: () => inv('lib:import'),
    chooseDir: () => inv('lib:chooseDir'),
  },
  rec: {
    begin: () => inv('rec:begin'),
    append: (tok, bytes) => inv('rec:append', tok, bytes),
    end: (tok, name) => inv('rec:end', tok, name),
  },
  secret: { get: key => inv('secret:get', key), set: (key, value) => inv('secret:set', key, value) },
  lan: { status: () => inv('lan:status'), set: on => inv('lan:set', on), peers: () => inv('lan:peers') },
  qr: text => inv('qr', text),
  update: { check: () => inv('update:check'), install: () => inv('update:install') },
  win: { fit: dsHeight => inv('win:fit', dsHeight) },
  on: (ch, fn) => { if (EVENTS.includes(ch)) ipcRenderer.on(ch, (_e, d) => fn(d)); },
});
