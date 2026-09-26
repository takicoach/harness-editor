const {contextBridge, webUtils} = require('electron');

// Expose only the path of a File the user has already given to the renderer.
contextBridge.exposeInMainWorld('harnessDesktop', {
  getPathForFile(file) {
    return webUtils.getPathForFile(file);
  },
});
