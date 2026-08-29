// bootstrap host seam – accepts window and inspector adapter
// Must not import Resolve or Electron lifecycle APIs (app, BrowserWindow creation)
// Later Resolve host can replace only this boundary.

function bootstrap(window, adapter, existingConversionService) {
  // Lazy require to keep this file free of direct electron lifecycle imports at top level
  const { attachIpc } = require('./ipc-contract.cjs');
  const { ConversionService } = require('./conversion-service.cjs');
  const svc = existingConversionService || new ConversionService();
  attachIpc(window, adapter, svc);
  svc.attachIpc(window);
  return svc;
}

module.exports = { bootstrap };
