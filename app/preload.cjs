// The only bridge between the renderer and Node.
//
// contextIsolation is on and nodeIntegration is off, so the interface has no
// access to the filesystem or to Node at all — it can call the named methods
// below and nothing else. A transcript archive is exactly the kind of thing that
// should not be one XSS away from arbitrary file access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vh', {
  /** Mirrors the HTTP API's method names, so the renderer needs no branching. */
  call: (method, args) => ipcRenderer.invoke('vh:api', method, args),

  /** Progress for long jobs, pushed from the main process. */
  onProgress: (fn) => {
    const h = (_e, p) => fn(p);
    ipcRenderer.on('vh:progress', h);
    return () => ipcRenderer.off('vh:progress', h);
  },
  onJob: (fn) => {
    const h = (_e, j) => fn(j);
    ipcRenderer.on('vh:job', h);
    return () => ipcRenderer.off('vh:job', h);
  },

  /** Audio comes over a custom scheme; no server, no open port. */
  mediaUrl: (id) => `vh://media/${id}`,

  platform: process.platform,
});
